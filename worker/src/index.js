const RESERVATION_SECONDS = 10 * 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS_PER_REGISTRATION = 100;
const DEFAULT_COUPON_ANALYZER_API = 'https://coupon-capture.45kikurage.workers.dev/api/analyze-detail';
const DEFAULT_COUPON_ANALYZER_BASE = 'https://coupon-capture.45kikurage.workers.dev';
const URL_RECONCILE_VERSION = '2026-09-21-v1';

export default {
  async fetch(request, env) {
    try {
      assertBindings(env);
      if (request.method === 'OPTIONS') return corsResponse(request, env, new Response(null, { status: 204 }));
      if (!isOriginAllowed(request, env)) return json(request, env, { error: 'このサイトからは利用できません。' }, 403);
      await ensureCouponSchema(env);
      await ensureCouponMaintenance(env);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      await releaseExpired(env);

      if (request.method === 'GET' && path === '/api/health') {
        return json(request, env, { ok: true, reservationMinutes: 10 });
      }
      if (request.method === 'GET' && path === '/api/coupons') return await listCoupons(request, env);
      if (request.method === 'POST' && path === '/api/coupons/reconcile') return await reconcileExistingUrlCoupons(request, env);
      if (request.method === 'POST' && path === '/api/coupons/register') return await registerCoupon(request, env);
      if (request.method === 'POST' && path === '/api/coupons/register-auto') return await registerAutoCoupon(request, env);

      let match = path.match(/^\/api\/coupons\/([^/]+)\/cover$/);
      if (request.method === 'GET' && match) return await getCover(request, env, decodeURIComponent(match[1]));

      match = path.match(/^\/api\/coupons\/([^/]+)\/reserve$/);
      if (request.method === 'POST' && match) return await reserveCoupon(request, env, decodeURIComponent(match[1]));

      match = path.match(/^\/api\/reservations\/([^/]+)$/);
      if (request.method === 'GET' && match) return await reservationStatus(request, env, decodeURIComponent(match[1]));

      match = path.match(/^\/api\/reservations\/([^/]+)\/(used|confirm|cancel)$/);
      if (request.method === 'POST' && match) {
        const id = decodeURIComponent(match[1]);
        if (match[2] === 'used') return await markUsed(request, env, id);
        if (match[2] === 'confirm') return await confirmUse(request, env, id);
        return await cancelReservation(request, env, id);
      }

      match = path.match(/^\/api\/reservations\/([^/]+)\/download$/);
      if (request.method === 'GET' && match) return await downloadReservation(request, env, decodeURIComponent(match[1]));

      return json(request, env, { error: 'APIが見つかりません。' }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return json(request, env, { error: status === 500 ? 'サーバー処理に失敗しました。' : error.message }, status);
    }
  }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertBindings(env) {
  if (!env.COUPON_DB || !env.COUPON_IMAGES) throw new HttpError(500, 'D1/R2 Bindingが未設定です。');
}

async function ensureCouponSchema(env) {
  const info = await env.COUPON_DB.prepare('PRAGMA table_info(coupons)').all();
  const hasRedeemPlace = (info.results || []).some(row => row.name === 'redeem_place');
  if (!hasRedeemPlace) {
    try {
      await env.COUPON_DB.prepare("ALTER TABLE coupons ADD COLUMN redeem_place TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }

  await env.COUPON_DB.prepare(`
    CREATE TABLE IF NOT EXISTS coupon_url_reconcile (
      coupon_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (coupon_id, version)
    )
  `).run();
}

function canonicalCouponNameForStorage(name, redeemPlace = '') {
  let value = String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  value = value
    .replace(/\s*(?:または\s*)?運営元[:：].*$/,'')
    .replace(/\s*(?:または\s*)?提供元[:：].*$/,'')
    .replace(/\s*(?:または\s*)?発行元[:：].*$/,'');

  if (/セブンプレミアム/.test(value) && /カフェラテ/.test(value)) {
    return 'セブンプレミアム カフェラテ いずれか1本';
  }
  if (/ななチキ/.test(value) && /揚げ鶏/.test(value)) {
    return 'ななチキ または 揚げ鶏 いずれか1個';
  }
  if ((/カフェ|ラテ|コーヒー|飲料|ml|mL/i.test(value)) && /いずれか1点$/.test(value)) {
    value = value.replace(/いずれか1点$/, 'いずれか1本');
  }
  return value;
}

async function ensureCouponMaintenance(env) {
  // 件数が少ない自己利用分では、毎回軽く整合性を確認する。
  // これにより、登録直後にできた旧名称/新名称の重複カードも次回表示で自動統合される。
  return mergeCanonicalCouponGroups(env);
}

async function mergeCanonicalCouponGroups(env) {
  const rowsResult = await env.COUPON_DB.prepare(`
    SELECT id, name, name_key, coupon_type, redeem_place, cover_object_key, created_at
    FROM coupons
    WHERE coupon_type = 'url'
    ORDER BY created_at ASC, id ASC
  `).all();
  const rows = rowsResult.results || [];
  const groups = new Map();

  for (const row of rows) {
    const canonicalName = canonicalCouponNameForStorage(row.name, row.redeem_place);
    const canonicalKey = normalizeName(`${canonicalName}\u0000${row.redeem_place || ''}`);
    const groupKey = `${canonicalKey}\u0001${row.coupon_type}`;
    const group = groups.get(groupKey) || { canonicalName, canonicalKey, rows: [] };
    group.rows.push(row);
    groups.set(groupKey, group);
  }

  for (const group of groups.values()) {
    const activeIds = group.rows.map(row => row.id);
    if (!activeIds.length) continue;

    if (activeIds.length > 1) {
      const marks = activeIds.map(() => '?').join(',');
      const activeReservation = await env.COUPON_DB.prepare(`
        SELECT COUNT(*) AS count
        FROM reservations
        WHERE coupon_id IN (${marks})
          AND status IN ('reserved', 'pending_confirmation')
          AND expires_at > ?
      `).bind(...activeIds, nowSeconds()).first();
      if (Number(activeReservation?.count || 0) > 0) continue;
    }

    const target = group.rows.find(row => row.name_key === group.canonicalKey) || group.rows[0];
    let targetCover = target.cover_object_key || null;

    for (const source of group.rows) {
      if (source.id === target.id) continue;

      const expiries = await env.COUPON_DB.prepare(
        'SELECT id, expires_on, created_at FROM coupon_expiries WHERE coupon_id = ? ORDER BY created_at, id'
      ).bind(source.id).all();

      for (const expiry of expiries.results || []) {
        let targetExpiry = await env.COUPON_DB.prepare(
          'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?'
        ).bind(target.id, expiry.expires_on).first();

        if (!targetExpiry) {
          const newExpiryId = crypto.randomUUID();
          await env.COUPON_DB.prepare(`
            INSERT OR IGNORE INTO coupon_expiries (id, coupon_id, expires_on, created_at)
            VALUES (?, ?, ?, ?)
          `).bind(newExpiryId, target.id, expiry.expires_on, expiry.created_at || nowSeconds()).run();
          targetExpiry = await env.COUPON_DB.prepare(
            'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?'
          ).bind(target.id, expiry.expires_on).first();
        }

        if (targetExpiry?.id) {
          await env.COUPON_DB.prepare('UPDATE coupon_items SET expiry_id = ? WHERE expiry_id = ?')
            .bind(targetExpiry.id, expiry.id).run();
        }
      }

      await env.COUPON_DB.prepare('UPDATE reservations SET coupon_id = ? WHERE coupon_id = ?')
        .bind(target.id, source.id).run();

      if (!targetCover && source.cover_object_key) {
        targetCover = source.cover_object_key;
      } else if (source.cover_object_key && source.cover_object_key !== targetCover) {
        await env.COUPON_IMAGES.delete(source.cover_object_key).catch(() => {});
      }

      await env.COUPON_DB.prepare('DELETE FROM coupons WHERE id = ?').bind(source.id).run();
    }

    const safeNameKey = group.canonicalKey;
    await env.COUPON_DB.prepare(`
      UPDATE coupons
      SET name = ?, name_key = ?, cover_object_key = COALESCE(?, cover_object_key), updated_at = ?
      WHERE id = ?
    `).bind(group.canonicalName, safeNameKey, targetCover, nowSeconds(), target.id).run();
  }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function isOriginAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return allowedOrigins(env).includes(origin.replace(/\/$/, ''));
}

function corsResponse(request, env, response) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  if (origin && isOriginAllowed(request, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Reservation-Token');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(request, env, data, status = 200) {
  return corsResponse(request, env, new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  }));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function todayInTokyo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function releaseExpired(env) {
  const now = nowSeconds();
  await env.COUPON_DB.batch([
    env.COUPON_DB.prepare(`
      UPDATE coupon_items
      SET reservation_id = NULL, reservation_expires_at = NULL
      WHERE reservation_id IS NOT NULL AND reservation_expires_at <= ?
    `).bind(now),
    env.COUPON_DB.prepare(`
      UPDATE reservations SET status = 'expired', updated_at = ?
      WHERE status IN ('reserved', 'pending_confirmation') AND expires_at <= ?
    `).bind(now, now)
  ]);
}

async function countPendingUrlReconcile(env) {
  const row = await env.COUPON_DB.prepare(`
    SELECT COUNT(DISTINCT c.id) AS count
    FROM coupons c
    JOIN coupon_expiries e ON e.coupon_id = c.id
    JOIN coupon_items i ON i.expiry_id = e.id AND i.item_type = 'url'
    LEFT JOIN coupon_url_reconcile s
      ON s.coupon_id = c.id AND s.version = ?
    WHERE c.coupon_type = 'url'
      AND (
        i.url_value LIKE 'https://coupon.sej.co.jp/%'
        OR i.url_value LIKE 'https://ncpfa.famima.com/%'
      )
      AND s.coupon_id IS NULL
  `).bind(URL_RECONCILE_VERSION).first();
  return Number(row?.count || 0);
}

async function saveReconcileStatus(env, couponId, status, message = '') {
  await env.COUPON_DB.prepare(`
    INSERT INTO coupon_url_reconcile (coupon_id, version, status, message, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(coupon_id, version) DO UPDATE SET
      status = excluded.status,
      message = excluded.message,
      updated_at = excluded.updated_at
  `).bind(couponId, URL_RECONCILE_VERSION, status, String(message || '').slice(0, 300), nowSeconds()).run();
}

async function reconcileOneExistingUrlCoupon(env, row) {
  const analyzed = await analyzeCouponForImport(row.url_value, env);
  const redeemPlace = String(analyzed.redeemPlace || analyzed.merchant || row.redeem_place || '').trim();
  const canonicalName = canonicalCouponNameForStorage(String(analyzed.product || row.name || '').trim(), redeemPlace);

  if (!canonicalName || canonicalName === '商品名不明' || !redeemPlace) {
    throw new HttpError(422, '商品名または引換先を確認できませんでした。');
  }

  let coverObjectKey = row.cover_object_key || null;
  if (!coverObjectKey && analyzed.productImageDataUri) {
    const image = decodeImageDataUri(analyzed.productImageDataUri);
    if (image) {
      const imageHash = await sha256Buffer(image.bytes);
      coverObjectKey = `covers/${row.id}/reconcile-${imageHash}.${extensionFor(image.mimeType)}`;
      await env.COUPON_IMAGES.put(coverObjectKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
    }
  }

  await env.COUPON_DB.prepare(`
    UPDATE coupons
    SET name = ?, redeem_place = ?, cover_object_key = COALESCE(?, cover_object_key), updated_at = ?
    WHERE id = ?
  `).bind(canonicalName, redeemPlace, coverObjectKey, nowSeconds(), row.id).run();

  return {
    id: row.id,
    beforeName: row.name,
    afterName: canonicalName,
    redeemPlace,
    changed: row.name !== canonicalName || String(row.redeem_place || '') !== redeemPlace
  };
}

async function reconcileExistingUrlCoupons(request, env) {
  const body = await readJson(request);
  const limit = Math.max(1, Math.min(6, Math.floor(Number(body.limit) || 4)));

  const beforeCountRow = await env.COUPON_DB.prepare(
    "SELECT COUNT(*) AS count FROM coupons WHERE coupon_type = 'url'"
  ).first();
  const beforeCount = Number(beforeCountRow?.count || 0);

  const candidates = await env.COUPON_DB.prepare(`
    SELECT c.id, c.name, c.redeem_place, c.cover_object_key, c.created_at,
           MIN(i.url_value) AS url_value
    FROM coupons c
    JOIN coupon_expiries e ON e.coupon_id = c.id
    JOIN coupon_items i ON i.expiry_id = e.id AND i.item_type = 'url'
    LEFT JOIN coupon_url_reconcile s
      ON s.coupon_id = c.id AND s.version = ?
    WHERE c.coupon_type = 'url'
      AND (
        i.url_value LIKE 'https://coupon.sej.co.jp/%'
        OR i.url_value LIKE 'https://ncpfa.famima.com/%'
      )
      AND s.coupon_id IS NULL
    GROUP BY c.id
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ?
  `).bind(URL_RECONCILE_VERSION, limit).all();

  let processed = 0;
  let changed = 0;
  let failed = 0;
  const details = [];

  for (const row of candidates.results || []) {
    processed += 1;
    try {
      const result = await reconcileOneExistingUrlCoupon(env, row);
      if (result.changed) changed += 1;
      details.push({ id: row.id, status: 'done', beforeName: result.beforeName, afterName: result.afterName });
      await saveReconcileStatus(env, row.id, 'done', result.changed ? 'updated' : 'unchanged');
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : '解析に失敗しました。';
      details.push({ id: row.id, status: 'failed', name: row.name, message });
      // 失敗カードは既存データを変更せず、今回の整理対象から外す。
      await saveReconcileStatus(env, row.id, 'failed', message);
    }
  }

  // 正規化後に、同じ商品＋引換先へまとまったカードを統合。
  await mergeCanonicalCouponGroups(env);

  const afterCountRow = await env.COUPON_DB.prepare(
    "SELECT COUNT(*) AS count FROM coupons WHERE coupon_type = 'url'"
  ).first();
  const afterCount = Number(afterCountRow?.count || 0);
  const merged = Math.max(0, beforeCount - afterCount);
  const remaining = await countPendingUrlReconcile(env);

  return json(request, env, {
    version: URL_RECONCILE_VERSION,
    processed,
    changed,
    failed,
    merged,
    remaining,
    done: remaining === 0,
    details
  });
}

async function listCoupons(request, env) {
  const now = nowSeconds();
  const today = todayInTokyo();
  const result = await env.COUPON_DB.prepare(`
    SELECT c.id, c.name, c.coupon_type, c.redeem_place, c.cover_object_key,
           e.expires_on,
           COUNT(i.id) AS remaining_count,
           SUM(CASE WHEN i.reservation_id IS NULL OR i.reservation_expires_at <= ? THEN 1 ELSE 0 END) AS available_count
    FROM coupons c
    JOIN coupon_expiries e ON e.coupon_id = c.id AND e.expires_on >= ?
    JOIN coupon_items i ON i.expiry_id = e.id
    GROUP BY c.id, c.redeem_place, e.id
    HAVING COUNT(i.id) > 0
    ORDER BY e.expires_on ASC, c.created_at ASC
  `).bind(now, today).all();

  const map = new Map();
  for (const row of result.results || []) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        name: canonicalCouponNameForStorage(row.name, row.redeem_place || ''),
        redeemPlace: row.redeem_place || '',
        type: row.coupon_type,
        coverUrl: `${new URL(request.url).origin}/api/coupons/${encodeURIComponent(row.id)}/cover?v=${encodeURIComponent(row.cover_object_key || '')}`,
        remainingCount: 0,
        availableCount: 0,
        expiries: []
      });
    }
    const coupon = map.get(row.id);
    const remaining = Number(row.remaining_count) || 0;
    const available = Number(row.available_count) || 0;
    coupon.remainingCount += remaining;
    coupon.availableCount += available;
    coupon.expiries.push({ expiresOn: row.expires_on, remainingCount: remaining, availableCount: available });
  }
  return json(request, env, { coupons: [...map.values()] });
}

async function getCover(request, env, couponId) {
  const row = await env.COUPON_DB.prepare('SELECT name, redeem_place, cover_object_key FROM coupons WHERE id = ?').bind(couponId).first();
  if (!row) throw new HttpError(404, 'クーポンがありません。');
  if (!row.cover_object_key) {
    const label = escapeSvgText(row.name || 'クーポン');
    const place = escapeSvgText(row.redeem_place || '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><rect width="640" height="640" fill="#fffaf1"/><rect x="24" y="24" width="592" height="592" rx="44" fill="#fde0b6" stroke="#8c7762" stroke-width="6"/><text x="320" y="292" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#282018">${label}</text><text x="320" y="350" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#776a5e">${place}</text></svg>`;
    return corsResponse(request, env, new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } }));
  }
  const object = await env.COUPON_IMAGES.get(row.cover_object_key);
  if (!object) throw new HttpError(404, '代表画像がありません。');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=3600');
  return corsResponse(request, env, new Response(object.body, { headers }));
}


function escapeSvgText(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function decodeImageDataUri(value) {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ''));
  if (!binary.length || binary.length > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, mimeType: match[1] };
}

function analyzerBaseFromEnv(env) {
  const configured = String(env.COUPON_ANALYZER_API || '').trim().replace(/\/$/, '');
  if (!configured) return DEFAULT_COUPON_ANALYZER_BASE;
  return configured.replace(/\/api\/(?:analyze-detail|analyze|capture-one)$/, '');
}

async function fetchAnalyzerJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, status: 0, data: {}, networkError: true };
  }
  let data = {};
  try { data = await response.json(); } catch {}
  return { ok: response.ok, status: response.status, data, networkError: false };
}

function redeemPlaceForSite(site, brand = '') {
  if (site === 'seven') return 'セブンイレブン';
  if (site === 'familymart') return 'ファミリーマート';
  if (site === 'misterdonut') return 'ミスタードーナツ';
  if (site === 'giftee_box') return brand || 'giftee Box';
  return brand || '';
}

function currentTokyoParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function validIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function inferExpiryYear(month, day) {
  const today = currentTokyoParts();
  let year = today.year;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
  if (Math.floor((candidate - todayUtc) / 86400000) < -31) year += 1;
  return year;
}

function extractLatestIsoDate(value) {
  const text = String(value || '').normalize('NFKC');
  const values = [];

  for (const match of text.matchAll(/(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*日?/g)) {
    const iso = validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) values.push(iso);
  }

  for (const match of text.matchAll(/(?:^|[^0-9])(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})\s*日?/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const iso = validIsoDate(inferExpiryYear(month, day), month, day);
    if (iso) values.push(iso);
  }

  return values.length ? [...new Set(values)].sort().at(-1) : '';
}

function decodeBase64Text(value) {
  try {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function extractProductImageFromSvg(svg) {
  const exact = String(svg || '').match(/<image\s+href="(data:image\/(?:png|jpeg|webp);base64,[^"]+)"\s+x="80"\s+y="250"/i);
  if (exact) return exact[1];
  const generic = [...String(svg || '').matchAll(/<image\b[^>]*href="(data:image\/(?:png|jpeg|webp);base64,[^"]+)"[^>]*>/gi)];
  return generic[0]?.[1] || null;
}

function extractCouponTitleFromSvg(svg) {
  const text = String(svg || '');
  const matches = [...text.matchAll(/<text\b[^>]*y="(9\d{2}|10\d{2})"[^>]*>([^<]+)<\/text>/gi)]
    .map(match => ({ y: Number(match[1]), value: match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim() }))
    .filter(item => item.value);
  return matches.sort((a,b)=>a.y-b.y).map(item=>item.value).join(' ').trim();
}

async function analyzeCouponLegacy(urlValue, env) {
  const base = analyzerBaseFromEnv(env);

  // 食品クーポンは容量表記が無いことがあるため、まずcapture-oneのタイトル/期間から判定する。
  const capture = await fetchAnalyzerJson(`${base}/api/capture-one`, { url: urlValue, mode: 'fast' });
  if (capture.ok && capture.data) {
    const svg = capture.data.base64 ? decodeBase64Text(capture.data.base64) : '';
    const product = String(capture.data.product || capture.data.title || extractCouponTitleFromSvg(svg)).trim();
    const expiresOn = extractLatestIsoDate(
      Array.isArray(capture.data.period) ? capture.data.period.join('\n') : svg
    );
    if (product && product !== '商品名不明' && expiresOn) {
      return {
        product,
        redeemPlace: redeemPlaceForSite(capture.data.site),
        merchant: redeemPlaceForSite(capture.data.site),
        expiresOn,
        productImageDataUri: capture.data.productImageDataUri || extractProductImageFromSvg(svg),
        site: capture.data.site,
        status: 'ok',
        analysisMode: 'capture-fallback'
      };
    }
  }

  // capture-oneで取れないケースのみ従来の分析APIへ。
  const analysis = await fetchAnalyzerJson(`${base}/api/analyze`, { items: [{ label: '1', url: urlValue }] });
  if (!analysis.ok) {
    throw new HttpError(502, analysis.data.error || analysis.data.message || '既存のクーポン解析APIでも解析できませんでした。');
  }
  const item = analysis.data.results?.[0];
  if (!item) throw new HttpError(422, '商品情報を読み取れませんでした。');
  if (item.status === 'used') throw new HttpError(422, 'このクーポンは利用済みです。');
  if (item.status !== 'ok' || !item.product || item.product === '商品名不明') {
    throw new HttpError(422, item.message || '商品名を読み取れませんでした。');
  }

  const svg = capture.data?.base64 ? decodeBase64Text(capture.data.base64) : '';
  const expiresOn = extractLatestIsoDate(svg);
  if (!expiresOn) throw new HttpError(422, '利用期限を読み取れませんでした。');

  return {
    product: item.product,
    redeemPlace: redeemPlaceForSite(item.site, item.brand),
    merchant: redeemPlaceForSite(item.site, item.brand),
    expiresOn,
    productImageDataUri: capture.data?.productImageDataUri || extractProductImageFromSvg(svg),
    site: item.site,
    status: 'ok',
    analysisMode: 'legacy-fallback'
  };
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function htmlVisibleLines(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<!--.*?-->/gs, ' ')
    .replace(/<(script|style)\b[^>]*>.*?<\/\1>/gis, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/dd>|<\/dt>|<\/section>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function htmlImageDescriptors(html) {
  return (String(html || '').match(/<img\b[^>]*>/gi) || []).flatMap(tag => {
    const source = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!source) return [];
    const alt = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    return [{ source: decodeHtmlEntities(source), alt: decodeHtmlEntities(alt) }];
  });
}

function compactSevenProductNames(names) {
  const clean = names
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!clean.length) return '';
  if (clean.length === 1) return clean[0];

  const tokenized = clean.map(value => value.split(/\s+/));
  const prefix = [];
  for (let index = 0; ; index += 1) {
    const token = tokenized[0][index];
    if (!token || tokenized.some(tokens => tokens[index] !== token)) break;
    prefix.push(token);
  }

  const common = prefix.join(' ').trim();
  if (common.length >= 6) {
    const combined = clean.join(' ').normalize('NFKC');
    const unit = /\d+(?:\.\d+)?\s*(?:ml|mL|L)/.test(combined) ? '1本'
      : /\d+\s*本/.test(combined) ? '1本'
      : /\d+\s*個/.test(combined) ? '1個'
      : '1点';
    return `${common} いずれか${unit}`;
  }

  const unit = clean.some(value => /\d+\s*個/.test(value.normalize('NFKC'))) ? '1個'
    : clean.some(value => /\d+(?:\.\d+)?\s*(?:ml|mL|L)|\d+\s*本/.test(value.normalize('NFKC'))) ? '1本'
    : '1点';
  return `${clean.join(' または ')} いずれか${unit}`;
}

function pickSevenFoodProduct(lines, descriptors) {
  const generic = /^(?:引換クーポン|クーポン|対象商品|商品画像|画像|バーコード|ロゴ|ご注意|クーポンの利用期間|セブン[‐ー・\- ]?イレブン店舗で引換えられます)$/;
  const descriptor = descriptors
    .map(item => item.alt.replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= 3 && value.length <= 120 && !generic.test(value))
    .map(value => ({
      value,
      score: (/(?:または|いずれか)/.test(value) ? 500 : 0)
        + (/\d+\s*(?:個|本|枚|パック)/.test(value) ? 250 : 0)
        + (/ななチキ|揚げ鶏|チキン|おにぎり|パン|菓子|アイス|弁当|飲料/.test(value) ? 120 : 0)
        - (/バーコード|ロゴ|QR|2次元|店舗で|対象商品の内/.test(value) ? 500 : 0)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.value;
  if (descriptor) return descriptor;

  const targetIndex = lines.findIndex(line => /^■?対象商品/.test(line));
  if (targetIndex >= 0) {
    const names = [];
    for (const line of lines.slice(targetIndex + 1, targetIndex + 7)) {
      const clean = line.replace(/^[・●■※\s]+/, '').trim();
      if (!clean || /対象外|ご注意|利用期間|クーポン|地域により|画像はイメージ|運営元|提供元|発行元/.test(clean)) break;
      if (clean.length <= 70) names.push(clean);
      if (names.length >= 4) break;
    }
    if (names.length) return compactSevenProductNames(names);
  }

  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(item => item.line.length >= 3 && item.line.length <= 120 && !generic.test(item.line))
    .map(item => {
      let score = Math.max(0, 50 - item.index);
      if (/(?:または|いずれか)/.test(item.line)) score += 500;
      if (/\d+\s*(?:個|本|枚|パック)/.test(item.line)) score += 250;
      if (/ななチキ|揚げ鶏|チキン|おにぎり|パン|菓子|アイス|弁当|飲料/.test(item.line)) score += 120;
      if (/対象商品の内|店舗でご利用可能|利用期間|ご注意|販売休止|地域により|画像はイメージ/.test(item.line)) score -= 500;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.score > 80 ? candidates[0].line : '';
}

async function readResponseText(response, maxBytes = 1_500_000) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new HttpError(422, 'クーポンページを読み取れませんでした。');
  const contentType = response.headers.get('content-type') || '';
  const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1]?.toLowerCase() || '';
  try {
    return new TextDecoder(/shift[_-]?jis|sjis|windows-31j/i.test(charset) ? 'shift_jis' : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function fetchSevenDirectPage(urlValue) {
  let current = new URL(urlValue);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (current.protocol !== 'https:' || current.hostname !== 'coupon.sej.co.jp' || !/^\/order\//.test(current.pathname)) {
      throw new HttpError(422, 'セブンイレブン公式クーポン以外へ転送されたため停止しました。');
    }
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
        }
      });
    } catch {
      throw new HttpError(502, 'セブンイレブンのクーポンページに接続できませんでした。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'セブンイレブンの転送先を確認できませんでした。');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new HttpError(502, `セブンイレブンのページ取得エラー（${response.status}）`);
    if (current.pathname.startsWith('/order/cpnsp_err')) throw new HttpError(422, 'このクーポンは無効または期限切れです。');
    return { html: await readResponseText(response), current };
  }
  throw new HttpError(422, 'セブンイレブンの転送回数が多すぎます。');
}

async function fetchSevenProductImage(descriptors, current) {
  const candidates = descriptors
    .map(item => {
      let url;
      try { url = new URL(item.source, current); } catch { return null; }
      if (url.protocol !== 'https:' || url.hostname !== 'coupon.sej.co.jp') return null;
      const label = `${url.pathname} ${item.alt}`;
      if (/barcode|bar-code|qr|2d|logo/i.test(label)) return null;
      let score = 0;
      if (/shohin|product|item|商品/i.test(label)) score += 1000;
      if (/(?:または|いずれか|ななチキ|揚げ鶏|チキン)/.test(item.alt)) score += 800;
      return { url, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  let best = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, {
        headers: {
          'Accept': 'image/png,image/jpeg,image/webp,image/*',
          'Referer': current.toString(),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase().replace('image/jpg', 'image/jpeg');
      if (!/^image\/(?:png|jpeg|webp)$/.test(contentType)) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const weighted = candidate.score + Math.min(bytes.length, 2_000_000) / 1000;
      if (!best || weighted > best.weighted) best = { bytes, contentType, weighted };
    } catch {}
  }
  if (!best) return null;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < best.bytes.length; i += chunk) {
    binary += String.fromCharCode(...best.bytes.subarray(i, i + chunk));
  }
  return `data:${best.contentType};base64,${btoa(binary)}`;
}

async function analyzeSevenDirectForImport(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.hostname !== 'coupon.sej.co.jp' || parsed.pathname !== '/order/cpnsp_03.do' || !parsed.searchParams.get('hansoku_id')) {
    return null;
  }

  const { html, current } = await fetchSevenDirectPage(urlValue);
  const lines = htmlVisibleLines(html);
  const text = lines.join('\n');
  if (/このクーポンは(?:ご)?利用済みです/.test(text)) throw new HttpError(422, 'このクーポンは利用済みです。');

  const descriptors = htmlImageDescriptors(html);
  const product = pickSevenFoodProduct(lines, descriptors);
  const expiresOn = extractLatestIsoDate(text);
  if (!product) throw new HttpError(422, '商品名を読み取れませんでした。');
  if (!expiresOn) throw new HttpError(422, '利用期限を読み取れませんでした。');

  return {
    product,
    redeemPlace: 'セブンイレブン',
    merchant: 'セブンイレブン',
    expiresOn,
    productImageDataUri: await fetchSevenProductImage(descriptors, current),
    site: 'seven',
    status: 'ok',
    analysisMode: 'direct-seven'
  };
}

async function analyzeCouponForImport(urlValue, env) {
  const directSeven = await analyzeSevenDirectForImport(urlValue);
  if (directSeven) return directSeven;

  const detailApi = String(env.COUPON_ANALYZER_API || DEFAULT_COUPON_ANALYZER_API).trim();
  const detail = await fetchAnalyzerJson(detailApi, { url: urlValue });
  if (detail.ok && detail.data?.status === 'ok') return { ...detail.data, analysisMode: 'detail' };

  // 本番Workerがまだ /api/analyze-detail 未反映の場合や、詳細解析だけ失敗した場合は
  // 既存の /api/analyze + /api/capture-one へ自動フォールバックする。
  try {
    return await analyzeCouponLegacy(urlValue, env);
  } catch (legacyError) {
    const detailMessage = detail.data?.error || detail.data?.message || '';
    if (legacyError instanceof HttpError) {
      if (detailMessage && !/Not found|API|見つかりません/i.test(detailMessage)) {
        throw new HttpError(legacyError.status, `${detailMessage} / ${legacyError.message}`);
      }
      throw legacyError;
    }
    throw new HttpError(502, detailMessage || 'クーポン解析に失敗しました。');
  }
}

async function registerAutoCoupon(request, env) {
  const body = await readJson(request);
  const urlValue = normalizeUrl(String(body.url || '').trim());
  const fingerprint = await sha256Text(urlValue);

  const duplicate = await env.COUPON_DB.prepare(`
    SELECT c.name, c.redeem_place, e.expires_on
    FROM coupon_items i
    JOIN coupon_expiries e ON e.id = i.expiry_id
    JOIN coupons c ON c.id = e.coupon_id
    WHERE i.fingerprint = ?
    LIMIT 1
  `).bind(fingerprint).first();
  if (duplicate) {
    return json(request, env, {
      newCount: 0,
      duplicateCount: 1,
      name: duplicate.name,
      product: duplicate.name,
      redeemPlace: duplicate.redeem_place || '',
      expiresOn: duplicate.expires_on,
      imageSaved: true,
      analysisMode: 'duplicate'
    });
  }

  const suppliedName = String(body.name || body.product || '').trim();
  const suppliedPlace = String(body.redeemPlace || body.merchant || '').trim();
  const suppliedExpiry = String(body.expiresOn || '').trim();
  const hasSuppliedAnalysis = suppliedName && suppliedPlace && /^\d{4}-\d{2}-\d{2}$/.test(suppliedExpiry);

  const analyzed = hasSuppliedAnalysis
    ? {
        product: suppliedName,
        redeemPlace: suppliedPlace,
        merchant: suppliedPlace,
        expiresOn: suppliedExpiry,
        productImageDataUri: body.productImageDataUri || null,
        status: 'ok',
        analysisMode: 'client-fallback'
      }
    : await analyzeCouponForImport(urlValue, env);

  const redeemPlace = String(analyzed.redeemPlace || analyzed.merchant || '').trim();
  const name = canonicalCouponNameForStorage(String(analyzed.product || '').trim(), redeemPlace);
  const expiresOn = String(analyzed.expiresOn || '').trim();

  if (!name || name === '商品名不明' || name.length > 100) throw new HttpError(422, '商品名を確認できません。');
  if (!redeemPlace || redeemPlace.length > 60) throw new HttpError(422, '引換先を確認できません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new HttpError(422, '利用期限を確認できません。');
  if (expiresOn < todayInTokyo()) throw new HttpError(422, '期限切れのクーポンは登録できません。');

  const now = nowSeconds();
  const nameKey = normalizeName(`${name}\u0000${redeemPlace}`);

  const existingCards = await env.COUPON_DB.prepare(`
    SELECT id, name, name_key, cover_object_key
    FROM coupons
    WHERE coupon_type = 'url' AND redeem_place = ?
    ORDER BY created_at ASC, id ASC
  `).bind(redeemPlace).all();

  let coupon = (existingCards.results || []).find(row => {
    const canonical = canonicalCouponNameForStorage(row.name, redeemPlace);
    return normalizeName(`${canonical}\u0000${redeemPlace}`) === nameKey;
  }) || null;

  if (!coupon) {
    const proposedCouponId = crypto.randomUUID();
    await env.COUPON_DB.prepare(`
      INSERT OR IGNORE INTO coupons (id, name, name_key, coupon_type, redeem_place, created_at, updated_at)
      VALUES (?, ?, ?, 'url', ?, ?, ?)
    `).bind(proposedCouponId, name, nameKey, redeemPlace, now, now).run();

    coupon = await env.COUPON_DB.prepare(
      'SELECT id, name, name_key, cover_object_key FROM coupons WHERE name_key = ? AND coupon_type = ?'
    ).bind(nameKey, 'url').first();
  } else if (coupon.name !== name || coupon.name_key !== nameKey) {
    // 同義の旧カードを見つけた場合は、新しいカードを作らずそのカードを正規名へ寄せる。
    // 同じ正規キーの別カードが残っている場合は、直後のmaintenanceで安全に統合される。
    const conflict = await env.COUPON_DB.prepare(
      'SELECT id FROM coupons WHERE name_key = ? AND coupon_type = ? AND id <> ? LIMIT 1'
    ).bind(nameKey, 'url', coupon.id).first();
    if (!conflict) {
      await env.COUPON_DB.prepare('UPDATE coupons SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
        .bind(name, nameKey, now, coupon.id).run();
      coupon = { ...coupon, name, name_key: nameKey };
    }
  }

  if (!coupon) throw new HttpError(500, 'クーポンを作成できませんでした。');

  const proposedExpiryId = crypto.randomUUID();
  await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupon_expiries (id, coupon_id, expires_on, created_at) VALUES (?, ?, ?, ?)
  `).bind(proposedExpiryId, coupon.id, expiresOn, now).run();
  const expiry = await env.COUPON_DB.prepare(
    'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?'
  ).bind(coupon.id, expiresOn).first();
  if (!expiry) throw new HttpError(500, '利用期限を保存できませんでした。');

  let imageSaved = Boolean(coupon.cover_object_key);
  if (!coupon.cover_object_key && analyzed.productImageDataUri) {
    const image = decodeImageDataUri(analyzed.productImageDataUri);
    if (image) {
      const imageHash = await sha256Buffer(image.bytes);
      const coverKey = `covers/${coupon.id}/auto-${imageHash}.${extensionFor(image.mimeType)}`;
      await env.COUPON_IMAGES.put(coverKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
      await env.COUPON_DB.prepare('UPDATE coupons SET cover_object_key = ?, updated_at = ? WHERE id = ?')
        .bind(coverKey, now, coupon.id).run();
      imageSaved = true;
    }
  }

  const result = await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupon_items
      (id, expiry_id, item_type, url_value, object_key, fingerprint, original_name, mime_type, created_at)
    VALUES (?, ?, 'url', ?, NULL, ?, NULL, NULL, ?)
  `).bind(crypto.randomUUID(), expiry.id, urlValue, fingerprint, now).run();

  const newCount = Number(result.meta?.changes || 0);
  await mergeCanonicalCouponGroups(env);

  return json(request, env, {
    newCount,
    duplicateCount: newCount ? 0 : 1,
    name,
    product: name,
    redeemPlace,
    expiresOn,
    imageSaved,
    analysisMode: analyzed.analysisMode || 'detail'
  }, newCount ? 201 : 200);
}

async function registerCoupon(request, env) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const type = String(form.get('type') || '');
  const expiresOn = String(form.get('expiresOn') || '');
  const cover = form.get('coverImage');
  if (!name || name.length > 100) throw new HttpError(400, 'クーポン名を入力してください。');
  if (!['url', 'image'].includes(type)) throw new HttpError(400, 'URL型または画像型を選択してください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new HttpError(400, '利用期限を入力してください。');
  if (expiresOn < todayInTokyo()) throw new HttpError(400, '過去の利用期限は登録できません。');
  if (!(cover instanceof File) || !cover.size) throw new HttpError(400, '代表画像を選択してください。');
  validateImage(cover, '代表画像');

  const rawItems = type === 'url'
    ? parseUrls(String(form.get('urls') || '')).map(value => ({ value, originalName: null, mimeType: null }))
    : form.getAll('couponImages').filter(value => value instanceof File && value.size).map(value => ({ value, originalName: value.name, mimeType: value.type }));
  if (!rawItems.length) throw new HttpError(400, type === 'url' ? 'URLを入力してください。' : '利用用画像を選択してください。');
  if (rawItems.length > MAX_ITEMS_PER_REGISTRATION) throw new HttpError(400, `1回に登録できるのは${MAX_ITEMS_PER_REGISTRATION}件までです。`);
  if (type === 'image') rawItems.forEach(item => validateImage(item.value, '利用用画像'));

  const prepared = [];
  const seen = new Set();
  for (const item of rawItems) {
    const fingerprint = type === 'url'
      ? await sha256Text(normalizeUrl(item.value))
      : await sha256Buffer(await item.value.arrayBuffer());
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    prepared.push({ ...item, fingerprint });
  }
  const internalDuplicates = rawItems.length - prepared.length;
  const existing = await existingFingerprints(env, prepared.map(item => item.fingerprint));
  const candidates = prepared.filter(item => !existing.has(item.fingerprint));
  if (!candidates.length) return json(request, env, { newCount: 0, duplicateCount: rawItems.length });

  const now = nowSeconds();
  const nameKey = normalizeName(name);
  const couponId = crypto.randomUUID();
  await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupons (id, name, name_key, coupon_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(couponId, name, nameKey, type, now, now).run();
  const coupon = await env.COUPON_DB.prepare(
    'SELECT id, cover_object_key FROM coupons WHERE name_key = ? AND coupon_type = ?'
  ).bind(nameKey, type).first();
  if (!coupon) throw new HttpError(500, 'クーポンを作成できませんでした。');

  const expiryId = crypto.randomUUID();
  await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupon_expiries (id, coupon_id, expires_on, created_at) VALUES (?, ?, ?, ?)
  `).bind(expiryId, coupon.id, expiresOn, now).run();
  const expiry = await env.COUPON_DB.prepare(
    'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ?'
  ).bind(coupon.id, expiresOn).first();

  const coverBuffer = await cover.arrayBuffer();
  const coverHash = await sha256Buffer(coverBuffer);
  const coverKey = `covers/${coupon.id}/${coverHash}.${extensionFor(cover.type)}`;
  await env.COUPON_IMAGES.put(coverKey, coverBuffer, { httpMetadata: { contentType: cover.type } });
  await env.COUPON_DB.prepare('UPDATE coupons SET name = ?, cover_object_key = ?, updated_at = ? WHERE id = ?')
    .bind(name, coverKey, now, coupon.id).run();
  if (coupon.cover_object_key && coupon.cover_object_key !== coverKey) await env.COUPON_IMAGES.delete(coupon.cover_object_key);

  const statements = [];
  for (const item of candidates) {
    let urlValue = null;
    let objectKey = null;
    if (type === 'url') {
      urlValue = normalizeUrl(item.value);
    } else {
      const bytes = await item.value.arrayBuffer();
      objectKey = `coupon-items/${item.fingerprint}.${extensionFor(item.value.type)}`;
      await env.COUPON_IMAGES.put(objectKey, bytes, { httpMetadata: { contentType: item.value.type } });
    }
    statements.push(env.COUPON_DB.prepare(`
      INSERT OR IGNORE INTO coupon_items
        (id, expiry_id, item_type, url_value, object_key, fingerprint, original_name, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), expiry.id, type, urlValue, objectKey, item.fingerprint, item.originalName, item.mimeType, now));
  }
  const results = await runBatches(env.COUPON_DB, statements, 50);
  const newCount = results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  const duplicateCount = internalDuplicates + existing.size + (candidates.length - newCount);
  return json(request, env, { newCount, duplicateCount });
}

export function parseUrls(text) {
  const urls = String(text).replace(/\r\n?/g, '\n').split(/\n+/).map(value => value.trim()).filter(Boolean);
  for (const value of urls) normalizeUrl(value);
  return urls;
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new HttpError(400, `URLの形式が正しくありません: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'http/httpsのURLだけ登録できます。');
  return url.href;
}

function normalizeName(value) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

function validateImage(file, label) {
  if (!String(file.type).startsWith('image/')) throw new HttpError(400, `${label}は画像ファイルを選択してください。`);
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(400, `${label}は1枚10MB以下にしてください。`);
}

async function existingFingerprints(env, fingerprints) {
  const found = new Set();
  for (let index = 0; index < fingerprints.length; index += 80) {
    const chunk = fingerprints.slice(index, index + 80);
    if (!chunk.length) continue;
    const marks = chunk.map(() => '?').join(',');
    const result = await env.COUPON_DB.prepare(`SELECT fingerprint FROM coupon_items WHERE fingerprint IN (${marks})`).bind(...chunk).all();
    (result.results || []).forEach(row => found.add(row.fingerprint));
  }
  return found;
}

async function reserveCoupon(request, env, couponId) {
  const body = await readJson(request);
  const coupon = await env.COUPON_DB.prepare('SELECT id, name, coupon_type FROM coupons WHERE id = ?').bind(couponId).first();
  if (!coupon) throw new HttpError(404, 'クーポンが見つかりません。');
  const quantity = coupon.coupon_type === 'url' ? 1 : Math.floor(Number(body.quantity));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEMS_PER_REGISTRATION) throw new HttpError(400, '利用枚数が正しくありません。');

  const now = nowSeconds();
  const expiresAt = now + RESERVATION_SECONDS;
  const reservationId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Text(token);
  await env.COUPON_DB.prepare(`
    INSERT INTO reservations (id, coupon_id, coupon_type, quantity, token_hash, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
  `).bind(reservationId, couponId, coupon.coupon_type, quantity, tokenHash, expiresAt, now, now).run();

  const claimed = await env.COUPON_DB.prepare(`
    UPDATE coupon_items
    SET reservation_id = ?, reservation_expires_at = ?
    WHERE id IN (
      SELECT i.id FROM coupon_items i
      JOIN coupon_expiries e ON e.id = i.expiry_id
      WHERE e.coupon_id = ? AND e.expires_on >= ?
        AND (i.reservation_id IS NULL OR i.reservation_expires_at <= ?)
      ORDER BY e.expires_on ASC, i.created_at ASC, i.id ASC
      LIMIT ?
    )
    AND (reservation_id IS NULL OR reservation_expires_at <= ?)
    RETURNING id, url_value
  `).bind(reservationId, expiresAt, couponId, todayInTokyo(), now, quantity, now).all();
  const items = claimed.results || [];
  if (items.length !== quantity) {
    await env.COUPON_DB.batch([
      env.COUPON_DB.prepare('UPDATE coupon_items SET reservation_id = NULL, reservation_expires_at = NULL WHERE reservation_id = ?').bind(reservationId),
      env.COUPON_DB.prepare('DELETE FROM reservations WHERE id = ?').bind(reservationId)
    ]);
    throw new HttpError(409, '指定枚数を確保できませんでした。一覧を更新してもう一度お試しください。');
  }

  return json(request, env, {
    reservationId,
    token,
    couponName: coupon.name,
    type: coupon.coupon_type,
    quantity,
    expiresAt,
    targetUrl: coupon.coupon_type === 'url' ? items[0].url_value : null
  }, 201);
}

async function reservationStatus(request, env, id) {
  const reservation = await authorizedReservation(request, env, id);
  return json(request, env, publicReservation(reservation));
}

async function markUsed(request, env, id) {
  const reservation = await authorizedReservation(request, env, id);
  ensureActive(reservation);
  const now = nowSeconds();
  const result = await env.COUPON_DB.prepare(`
    UPDATE reservations SET status = 'pending_confirmation', updated_at = ?
    WHERE id = ? AND status = 'reserved' AND expires_at > ?
  `).bind(now, id, now).run();
  if (!result.meta?.changes && reservation.status !== 'pending_confirmation') throw new HttpError(409, '予約状態が変わりました。');
  return json(request, env, { ...publicReservation(reservation), status: 'pending_confirmation' });
}

async function cancelReservation(request, env, id) {
  const reservation = await authorizedReservation(request, env, id);
  if (!['reserved', 'pending_confirmation'].includes(reservation.status)) throw new HttpError(409, 'この予約はキャンセルできません。');
  const now = nowSeconds();
  const results = await env.COUPON_DB.batch([
    env.COUPON_DB.prepare(`
      UPDATE reservations SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('reserved', 'pending_confirmation')
    `).bind(now, id),
    env.COUPON_DB.prepare(`
      UPDATE coupon_items SET reservation_id = NULL, reservation_expires_at = NULL
      WHERE reservation_id = ?
        AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'cancelled')
    `).bind(id, id)
  ]);
  if (!results[0].meta?.changes) throw new HttpError(409, '予約状態が変わりました。');
  return json(request, env, { status: 'cancelled' });
}

async function confirmUse(request, env, id) {
  const reservation = await authorizedReservation(request, env, id);
  ensureActive(reservation);
  if (reservation.status !== 'pending_confirmation') throw new HttpError(409, '先に「利用した」を押してください。');
  const itemResult = await env.COUPON_DB.prepare(`
    SELECT id, object_key FROM coupon_items WHERE reservation_id = ? ORDER BY id
  `).bind(id).all();
  const items = itemResult.results || [];
  if (items.length !== Number(reservation.quantity)) throw new HttpError(409, '予約内容が変わりました。一覧を更新してください。');
  const now = nowSeconds();
  const results = await env.COUPON_DB.batch([
    env.COUPON_DB.prepare(`
      UPDATE reservations SET status = 'confirmed', updated_at = ?
      WHERE id = ? AND status = 'pending_confirmation' AND expires_at > ?
    `).bind(now, id, now),
    env.COUPON_DB.prepare(`
      DELETE FROM coupon_items
      WHERE reservation_id = ?
        AND EXISTS (SELECT 1 FROM reservations WHERE id = ? AND status = 'confirmed')
    `).bind(id, id)
  ]);
  if (!results[0].meta?.changes) throw new HttpError(409, '予約状態が変わりました。');
  const keys = items.map(item => item.object_key).filter(Boolean);
  if (keys.length) await env.COUPON_IMAGES.delete(keys);
  return json(request, env, { status: 'confirmed', deletedCount: items.length });
}

async function downloadReservation(request, env, id) {
  const reservation = await authorizedReservation(request, env, id);
  ensureActive(reservation);
  if (reservation.coupon_type !== 'image') throw new HttpError(400, '画像型クーポンではありません。');
  const result = await env.COUPON_DB.prepare(`
    SELECT i.id, i.object_key, i.original_name, i.mime_type
    FROM coupon_items i WHERE i.reservation_id = ? ORDER BY i.created_at, i.id
  `).bind(id).all();
  const files = [];
  let index = 1;
  for (const row of result.results || []) {
    const object = await env.COUPON_IMAGES.get(row.object_key);
    if (!object) throw new HttpError(500, '保存画像を取得できませんでした。');
    const extension = extensionFor(row.mime_type || object.httpMetadata?.contentType || 'image/jpeg');
    files.push({ name: safeFilename(row.original_name, index++, extension), object });
  }
  const archive = createZipStream(files);
  return corsResponse(request, env, new Response(archive, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="coupons-${id.slice(0, 8)}.zip"`,
      'Cache-Control': 'no-store'
    }
  }));
}

async function authorizedReservation(request, env, id) {
  const token = request.headers.get('X-Reservation-Token') || '';
  if (!token) throw new HttpError(401, '予約情報がありません。');
  const tokenHash = await sha256Text(token);
  const reservation = await env.COUPON_DB.prepare(`
    SELECT r.*, c.name AS coupon_name FROM reservations r JOIN coupons c ON c.id = r.coupon_id
    WHERE r.id = ? AND r.token_hash = ?
  `).bind(id, tokenHash).first();
  if (!reservation) throw new HttpError(404, '予約が見つかりません。');
  return reservation;
}

function ensureActive(reservation) {
  if (!['reserved', 'pending_confirmation'].includes(reservation.status) || Number(reservation.expires_at) <= nowSeconds()) {
    throw new HttpError(409, '予約時間が終了しました。');
  }
}

function publicReservation(reservation) {
  return {
    reservationId: reservation.id,
    couponId: reservation.coupon_id,
    couponName: reservation.coupon_name,
    type: reservation.coupon_type,
    quantity: Number(reservation.quantity),
    status: reservation.status,
    expiresAt: Number(reservation.expires_at)
  };
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function runBatches(db, statements, size) {
  const results = [];
  for (let index = 0; index < statements.length; index += size) results.push(...await db.batch(statements.slice(index, index + size)));
  return results;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

async function sha256Text(text) {
  return sha256Buffer(new TextEncoder().encode(text));
}

async function sha256Buffer(buffer) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function extensionFor(mimeType) {
  const map = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
  return map[mimeType] || 'jpg';
}

function safeFilename(name, index, extension) {
  const stem = String(name || `coupon-${index}`).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || `coupon-${index}`;
  return `${String(index).padStart(2, '0')}-${stem}.${extension}`;
}

// 追加ライブラリを使わないZIP(Store方式)。スマホで複数画像を1ファイルとして保存できる。
export function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30); local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// R2の画像本体をメモリへ全件展開せず、順番にZIPへ流す。
function createZipStream(files) {
  return new ReadableStream({
    async start(controller) {
      try {
        const encoder = new TextEncoder();
        const centralParts = [];
        let offset = 0;
        for (const file of files) {
          const name = encoder.encode(file.name);
          const local = new Uint8Array(30 + name.length);
          const lv = new DataView(local.buffer);
          lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0808, true);
          lv.setUint16(26, name.length, true); local.set(name, 30);
          controller.enqueue(local);

          let size = 0;
          let crcState = 0xffffffff;
          const reader = file.object.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            size += bytes.length;
            crcState = crc32Continue(crcState, bytes);
            controller.enqueue(bytes);
          }
          const crc = (crcState ^ 0xffffffff) >>> 0;
          const descriptor = new Uint8Array(16);
          const dv = new DataView(descriptor.buffer);
          dv.setUint32(0, 0x08074b50, true); dv.setUint32(4, crc, true);
          dv.setUint32(8, size, true); dv.setUint32(12, size, true);
          controller.enqueue(descriptor);

          const central = new Uint8Array(46 + name.length);
          const cv = new DataView(central.buffer);
          cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0808, true);
          cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
          cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
          centralParts.push(central);
          offset += local.length + size + descriptor.length;
        }
        const centralOffset = offset;
        for (const central of centralParts) { controller.enqueue(central); offset += central.length; }
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
        ev.setUint32(12, offset - centralOffset, true); ev.setUint32(16, centralOffset, true);
        controller.enqueue(end);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function crc32Continue(crc, bytes) {
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc;
}
