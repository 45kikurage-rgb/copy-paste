const RESERVATION_SECONDS = 10 * 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS_PER_REGISTRATION = 100;
const URL_RECONCILE_VERSION = '2026-09-24-v8-identity4';

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

      let match = path.match(/^\/api\/coupons\/([^/]+)$/);
      if (request.method === 'DELETE' && match) return await deleteCoupon(request, env, decodeURIComponent(match[1]));

      match = path.match(/^\/api\/coupons\/([^/]+)\/cover$/);
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
  const columns = new Set((info.results || []).map(row => row.name));

  if (!columns.has('redeem_place')) {
    try {
      await env.COUPON_DB.prepare("ALTER TABLE coupons ADD COLUMN redeem_place TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }

  if (!columns.has('capacity')) {
    try {
      await env.COUPON_DB.prepare("ALTER TABLE coupons ADD COLUMN capacity TEXT NOT NULL DEFAULT ''").run();
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

  await env.COUPON_DB.prepare(`
    CREATE TABLE IF NOT EXISTS coupon_item_reconcile (
      item_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, version)
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
  if (/スタバ|スターバックス|STARBUCKS/i.test(value)) {
    const amount = value.normalize('NFKC').match(/(?:税込\s*)?(\d{3,5})\s*円|(?:スタバ|スターバックス)\s*(\d{3,5})/i);
    const yen = Number(amount?.[1] || amount?.[2] || 0);
    if (yen > 0) return 'スタバ' + yen;
  }
  if (/コメダ|KOMEDA/i.test(value)) {
    const amount = value.normalize('NFKC').match(/(?:税込\s*)?(\d{3,5})\s*円|(?:コメダ(?:コーヒー)?|KOMEDA)\s*(\d{3,5})/i);
    const yen = Number(amount?.[1] || amount?.[2] || 0);
    if (yen > 0) return yen + '円 コメダコーヒー';
  }
  if (/ミスタードーナツ|ミスド|MISTER\s*DONUT/i.test(value)) {
    const amount = value.normalize('NFKC').match(/(?:税込\s*)?(\d{3,5})\s*円|(?:ミスタードーナツ|ミスド)\s*(\d{3,5})/i);
    const yen = Number(amount?.[1] || amount?.[2] || 0);
    if (yen > 0) return yen + '円 ミスタードーナツ';
  }
  if (/ローソン|LAWSON/i.test(value)) {
    const amount = value.normalize('NFKC').match(/(?:税込\s*)?(\d{3,5})\s*円/);
    const yen = Number(amount?.[1] || 0);
    if (yen > 0 && /お買物券|お買い物券|ギフト券|デジタルギフト|ローソン/i.test(value)) {
      return yen + '円 ローソン';
    }
  }
  if ((/カフェ|ラテ|コーヒー|飲料|ml|mL/i.test(value)) && /いずれか1点$/.test(value)) {
    value = value.replace(/いずれか1点$/, 'いずれか1本');
  }
  return value;
}

function normalizeCouponCapacity(explicitValue = '', productName = '') {
  const source = String(explicitValue || productName || '').normalize('NFKC');
  const found = [];

  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(ml|mL|L|g|kg)\b/g)) {
    let unit = match[2];
    if (/^ml$/i.test(unit)) unit = 'ml';
    else if (/^kg$/i.test(unit)) unit = 'kg';
    else if (/^g$/i.test(unit)) unit = 'g';
    else unit = 'L';
    const label = `${match[1]}${unit}`;
    if (!found.includes(label)) found.push(label);
  }

  return found.join(' / ');
}

function couponIdentityKey(name, capacity, redeemPlace, expiresOn) {
  return normalizeName([
    canonicalCouponNameForStorage(name, redeemPlace),
    normalizeCouponCapacity(capacity, name),
    String(redeemPlace || '').trim(),
    String(expiresOn || '').trim()
  ].join('\u0000'));
}

function isGenericSevenProductName(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  return /^(?:セブン[‐ー・\- ]?イレブン\s*)?(?:引換\s*)?クーポン$/i.test(text)
    || /^セブン[‐ー・\- ]?イレブン.*クーポン$/i.test(text)
    || /^(?:商品|対象商品|商品画像|引換クーポン)$/i.test(text);
}

async function ensureCouponMaintenance(env) {
  // 件数が少ない自己利用分では、毎回軽く整合性を確認する。
  // これにより、登録直後にできた旧名称/新名称の重複カードも次回表示で自動統合される。
  return mergeCanonicalCouponGroups(env);
}

async function mergeCanonicalCouponGroups(env) {
  const rowsResult = await env.COUPON_DB.prepare(`
    SELECT c.id, c.name, c.name_key, c.coupon_type, c.redeem_place, c.capacity,
           c.cover_object_key, c.created_at,
           MIN(e.expires_on) AS expires_on,
           COUNT(DISTINCT e.id) AS expiry_count
    FROM coupons c
    LEFT JOIN coupon_expiries e ON e.coupon_id = c.id
    WHERE c.coupon_type = 'url'
    GROUP BY c.id
    ORDER BY c.created_at ASC, c.id ASC
  `).all();

  const rows = rowsResult.results || [];
  const groups = new Map();

  for (const row of rows) {
    // 期限が複数ある旧カードは、item-level reconciliationで先に分割する。
    if (Number(row.expiry_count || 0) !== 1 || !row.expires_on) continue;

    const canonicalName = canonicalCouponNameForStorage(row.name, row.redeem_place);
    const capacity = normalizeCouponCapacity(row.capacity, canonicalName);
    const identityKey = couponIdentityKey(canonicalName, capacity, row.redeem_place, row.expires_on);
    const group = groups.get(identityKey) || {
      canonicalName,
      capacity,
      redeemPlace: row.redeem_place || '',
      expiresOn: row.expires_on,
      identityKey,
      rows: []
    };
    group.rows.push(row);
    groups.set(identityKey, group);
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

    const target = group.rows.find(row => row.name_key === group.identityKey) || group.rows[0];
    let targetCover = target.cover_object_key || null;
    const targetExpiry = await env.COUPON_DB.prepare(
      'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ? LIMIT 1'
    ).bind(target.id, group.expiresOn).first();
    if (!targetExpiry?.id) continue;

    for (const source of group.rows) {
      if (source.id === target.id) continue;

      const sourceExpiry = await env.COUPON_DB.prepare(
        'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ? LIMIT 1'
      ).bind(source.id, group.expiresOn).first();

      if (sourceExpiry?.id) {
        await env.COUPON_DB.prepare('UPDATE coupon_items SET expiry_id = ? WHERE expiry_id = ?')
          .bind(targetExpiry.id, sourceExpiry.id).run();
      }

      await env.COUPON_DB.prepare('UPDATE reservations SET coupon_id = ? WHERE coupon_id = ?')
        .bind(target.id, source.id).run();

      if (!targetCover && source.cover_object_key) {
        targetCover = source.cover_object_key;
      } else if (source.cover_object_key && source.cover_object_key !== targetCover) {
        await env.COUPON_IMAGES.delete(source.cover_object_key).catch(() => {});
      }

      await env.COUPON_DB.prepare('DELETE FROM coupon_expiries WHERE coupon_id = ?').bind(source.id).run();
      await env.COUPON_DB.prepare('DELETE FROM coupon_url_reconcile WHERE coupon_id = ?').bind(source.id).run();
      await env.COUPON_DB.prepare('DELETE FROM coupons WHERE id = ?').bind(source.id).run();
    }

    await env.COUPON_DB.prepare(`
      UPDATE coupons
      SET name = ?, name_key = ?, redeem_place = ?, capacity = ?,
          cover_object_key = COALESCE(?, cover_object_key), updated_at = ?
      WHERE id = ?
    `).bind(
      group.canonicalName,
      group.identityKey,
      group.redeemPlace,
      group.capacity,
      targetCover,
      nowSeconds(),
      target.id
    ).run();
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
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
    SELECT COUNT(*) AS count
    FROM coupon_items i
    JOIN coupon_expiries e ON e.id = i.expiry_id
    JOIN coupons c ON c.id = e.coupon_id
    LEFT JOIN coupon_item_reconcile s
      ON s.item_id = i.id AND s.version = ?
    WHERE c.coupon_type = 'url'
      AND i.item_type = 'url'
      AND (
        i.url_value LIKE 'https://coupon.sej.co.jp/%'
        OR i.url_value LIKE 'https://ncpfa.famima.com/%'
        OR i.url_value LIKE 'https://gift.starbucks.co.jp/%'
        OR i.url_value LIKE 'https://komeda.e-gift.co/%'
        OR i.url_value LIKE 'https://lawson-i.e-gift.co/%'
        OR i.url_value LIKE 'https://misterdonut.e-gift.co/%'
      )
      AND s.item_id IS NULL
  `).bind(URL_RECONCILE_VERSION).first();
  return Number(row?.count || 0);
}

async function saveItemReconcileStatus(env, itemId, status, message = '') {
  await env.COUPON_DB.prepare(`
    INSERT INTO coupon_item_reconcile (item_id, version, status, message, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(item_id, version) DO UPDATE SET
      status = excluded.status,
      message = excluded.message,
      updated_at = excluded.updated_at
  `).bind(itemId, URL_RECONCILE_VERSION, status, String(message || '').slice(0, 300), nowSeconds()).run();
}

async function cleanupEmptyUrlCoupon(env, couponId) {
  if (!couponId) return;

  await env.COUPON_DB.prepare(`
    DELETE FROM coupon_expiries
    WHERE coupon_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM coupon_items i WHERE i.expiry_id = coupon_expiries.id
      )
  `).bind(couponId).run();

  const remaining = await env.COUPON_DB.prepare(`
    SELECT c.cover_object_key,
           (SELECT COUNT(*) FROM coupon_expiries e WHERE e.coupon_id = c.id) AS expiry_count,
           (SELECT COUNT(*) FROM reservations r
             WHERE r.coupon_id = c.id
               AND r.status IN ('reserved', 'pending_confirmation')
               AND r.expires_at > ?) AS active_reservations
    FROM coupons c
    WHERE c.id = ?
  `).bind(nowSeconds(), couponId).first();

  if (!remaining || Number(remaining.expiry_count || 0) > 0 || Number(remaining.active_reservations || 0) > 0) return;

  const coverKey = remaining.cover_object_key || '';
  await env.COUPON_DB.prepare('DELETE FROM coupon_url_reconcile WHERE coupon_id = ?').bind(couponId).run();
  await env.COUPON_DB.prepare('DELETE FROM coupons WHERE id = ?').bind(couponId).run();

  if (coverKey) {
    const shared = await env.COUPON_DB.prepare(
      'SELECT COUNT(*) AS count FROM coupons WHERE cover_object_key = ?'
    ).bind(coverKey).first();
    if (Number(shared?.count || 0) === 0) await env.COUPON_IMAGES.delete(coverKey).catch(() => {});
  }
}

async function ensureIdentityCoupon(env, analyzed, fallback = {}) {
  const redeemPlace = String(analyzed.redeemPlace || analyzed.merchant || fallback.redeem_place || '').trim();
  const name = canonicalCouponNameForStorage(String(analyzed.product || fallback.name || '').trim(), redeemPlace);
  const capacity = normalizeCouponCapacity(analyzed.capacity || analyzed.size || fallback.capacity || '', name);
  const expiresOn = String(analyzed.expiresOn || fallback.expires_on || '').trim();

  if (!name || name === '商品名不明' || isGenericSevenProductName(name)) {
    throw new HttpError(422, '商品名を正しく確認できません。');
  }
  if (!redeemPlace) throw new HttpError(422, '引換先を確認できません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new HttpError(422, '利用期限を確認できません。');

  const nameKey = couponIdentityKey(name, capacity, redeemPlace, expiresOn);
  let coupon = await env.COUPON_DB.prepare(`
    SELECT id, name, name_key, redeem_place, capacity, cover_object_key
    FROM coupons
    WHERE name_key = ? AND coupon_type = 'url'
    LIMIT 1
  `).bind(nameKey).first();

  const now = nowSeconds();
  if (!coupon) {
    const id = crypto.randomUUID();
    await env.COUPON_DB.prepare(`
      INSERT OR IGNORE INTO coupons
        (id, name, name_key, coupon_type, redeem_place, capacity, created_at, updated_at)
      VALUES (?, ?, ?, 'url', ?, ?, ?, ?)
    `).bind(id, name, nameKey, redeemPlace, capacity, now, now).run();

    coupon = await env.COUPON_DB.prepare(`
      SELECT id, name, name_key, redeem_place, capacity, cover_object_key
      FROM coupons
      WHERE name_key = ? AND coupon_type = 'url'
      LIMIT 1
    `).bind(nameKey).first();
  }

  if (!coupon) throw new HttpError(500, 'クーポンカードを作成できませんでした。');

  const proposedExpiryId = crypto.randomUUID();
  await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupon_expiries (id, coupon_id, expires_on, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(proposedExpiryId, coupon.id, expiresOn, now).run();

  const expiry = await env.COUPON_DB.prepare(
    'SELECT id FROM coupon_expiries WHERE coupon_id = ? AND expires_on = ? LIMIT 1'
  ).bind(coupon.id, expiresOn).first();
  if (!expiry?.id) throw new HttpError(500, '利用期限を保存できませんでした。');

  let coverObjectKey = coupon.cover_object_key || null;
  if (!coverObjectKey && analyzed.productImageDataUri) {
    const image = decodeImageDataUri(analyzed.productImageDataUri);
    if (image) {
      const imageHash = await sha256Buffer(image.bytes);
      coverObjectKey = `covers/${coupon.id}/identity-${imageHash}.${extensionFor(image.mimeType)}`;
      await env.COUPON_IMAGES.put(coverObjectKey, image.bytes, { httpMetadata: { contentType: image.mimeType } });
    }
  }

  await env.COUPON_DB.prepare(`
    UPDATE coupons
    SET name = ?, name_key = ?, redeem_place = ?, capacity = ?,
        cover_object_key = COALESCE(?, cover_object_key), updated_at = ?
    WHERE id = ?
  `).bind(name, nameKey, redeemPlace, capacity, coverObjectKey, now, coupon.id).run();

  return { couponId: coupon.id, expiryId: expiry.id, name, capacity, redeemPlace, expiresOn, nameKey };
}

async function reconcileOneExistingUrlItem(env, row) {
  const analyzed = await analyzeCouponForImport(row.url_value, env);
  const identity = await ensureIdentityCoupon(env, analyzed, row);

  const changed = row.coupon_id !== identity.couponId
    || row.expiry_id !== identity.expiryId
    || row.name !== identity.name
    || String(row.capacity || '') !== identity.capacity
    || String(row.redeem_place || '') !== identity.redeemPlace
    || String(row.expires_on || '') !== identity.expiresOn;

  await env.COUPON_DB.prepare(
    'UPDATE coupon_items SET expiry_id = ? WHERE id = ?'
  ).bind(identity.expiryId, row.item_id).run();

  if (row.coupon_id !== identity.couponId) {
    await cleanupEmptyUrlCoupon(env, row.coupon_id);
  } else if (row.expiry_id !== identity.expiryId) {
    await env.COUPON_DB.prepare(`
      DELETE FROM coupon_expiries
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM coupon_items WHERE expiry_id = ?)
    `).bind(row.expiry_id, row.expiry_id).run();
  }

  return { ...identity, changed };
}

async function reconcileExistingUrlCoupons(request, env) {
  const body = await readJson(request);
  const limit = Math.max(1, Math.min(6, Math.floor(Number(body.limit) || 6)));

  const beforeCountRow = await env.COUPON_DB.prepare(
    "SELECT COUNT(*) AS count FROM coupons WHERE coupon_type = 'url'"
  ).first();
  const beforeCount = Number(beforeCountRow?.count || 0);

  const candidates = await env.COUPON_DB.prepare(`
    SELECT i.id AS item_id, i.url_value, i.expiry_id,
           e.expires_on,
           c.id AS coupon_id, c.name, c.redeem_place, c.capacity, c.cover_object_key, c.created_at
    FROM coupon_items i
    JOIN coupon_expiries e ON e.id = i.expiry_id
    JOIN coupons c ON c.id = e.coupon_id
    LEFT JOIN coupon_item_reconcile s
      ON s.item_id = i.id AND s.version = ?
    WHERE c.coupon_type = 'url'
      AND i.item_type = 'url'
      AND (i.reservation_id IS NULL OR i.reservation_expires_at <= ?)
      AND (
        i.url_value LIKE 'https://coupon.sej.co.jp/%'
        OR i.url_value LIKE 'https://ncpfa.famima.com/%'
        OR i.url_value LIKE 'https://gift.starbucks.co.jp/%'
        OR i.url_value LIKE 'https://komeda.e-gift.co/%'
        OR i.url_value LIKE 'https://lawson-i.e-gift.co/%'
        OR i.url_value LIKE 'https://misterdonut.e-gift.co/%'
      )
      AND s.item_id IS NULL
    ORDER BY i.created_at ASC, i.id ASC
    LIMIT ?
  `).bind(URL_RECONCILE_VERSION, nowSeconds(), limit).all();

  let processed = 0;
  let changed = 0;
  let failed = 0;
  const details = [];

  for (const row of candidates.results || []) {
    processed += 1;
    try {
      const result = await reconcileOneExistingUrlItem(env, row);
      if (result.changed) changed += 1;
      details.push({
        id: row.item_id,
        status: 'done',
        beforeName: row.name,
        afterName: result.name,
        capacity: result.capacity,
        expiresOn: result.expiresOn
      });
      await saveItemReconcileStatus(env, row.item_id, 'done', result.changed ? 'updated' : 'unchanged');
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : '解析に失敗しました。';
      details.push({ id: row.item_id, status: 'failed', name: row.name, message });
      await saveItemReconcileStatus(env, row.item_id, 'failed', message);
    }
  }

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
    SELECT c.id, c.name, c.coupon_type, c.redeem_place, c.capacity, c.cover_object_key,
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
        capacity: row.capacity || '',
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

async function fetchAnalyzerJson(env, path, body) {
  if (!env.COUPON_ANALYZER || typeof env.COUPON_ANALYZER.fetch !== 'function') {
    return { ok: false, status: 503, data: { error: '共通クーポン解析APIが接続されていません。' }, networkError: true };
  }
  let response;
  try {
    response = await env.COUPON_ANALYZER.fetch(new Request(`https://coupon-analyzer-api.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }));
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
  // 食品クーポンは容量表記が無いことがあるため、まずcapture-oneのタイトル/期間から判定する。
  const capture = await fetchAnalyzerJson(env, '/api/capture-one', { url: urlValue, mode: 'fast' });
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
  const analysis = await fetchAnalyzerJson(env, '/api/analyze', { items: [{ label: '1', url: urlValue }], mode: 'stable' });
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
  const generic = /^(?:引換クーポン|クーポン|対象商品|商品画像|画像|バーコード|ロゴ|ご注意|クーポンの利用期間|セブン[‐ー・\- ]?イレブン店舗で引換えられます|セブン[‐ー・\- ]?イレブン\s*(?:引換\s*)?クーポン)$/;
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
  if (!product || isGenericSevenProductName(product)) throw new HttpError(422, '商品名を正しく読み取れませんでした。');
  if (!expiresOn) throw new HttpError(422, '利用期限を読み取れませんでした。');

  return {
    product,
    capacity: normalizeCouponCapacity('', product),
    redeemPlace: 'セブンイレブン',
    merchant: 'セブンイレブン',
    expiresOn,
    productImageDataUri: await fetchSevenProductImage(descriptors, current),
    site: 'seven',
    status: 'ok',
    analysisMode: 'direct-seven'
  };
}

async function fetchStarbucksDirectPage(urlValue) {
  let current = new URL(urlValue);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    if (current.protocol !== 'https:' || !/(^|\.)starbucks\.co\.jp$/i.test(current.hostname)) {
      throw new HttpError(422, 'スターバックス公式サイト以外へ転送されたため停止しました。');
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
      throw new HttpError(502, 'スターバックスeGiftページに接続できませんでした。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'スターバックスの転送先を確認できませんでした。');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new HttpError(502, 'スターバックスのページ取得エラー（' + response.status + '）');
    return { html: await readResponseText(response, 2500000), current };
  }
  throw new HttpError(422, 'スターバックスの転送回数が多すぎます。');
}

function starbucksOgImage(html) {
  const a = String(html || '').match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (a?.[1]) return decodeHtmlEntities(a[1]);
  const b = String(html || '').match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["'][^>]*>/i);
  return b?.[1] ? decodeHtmlEntities(b[1]) : '';
}

function starbucksAmountCandidates(html, visibleText) {
  const raw = decodeHtmlEntities(String(html || ''))
    .replace(/\\u5186/gi, '円')
    .replace(/\\u7a0e\\u8fbc/gi, '税込')
    .replace(/\\u307e\\u3067/gi, 'まで')
    .normalize('NFKC');
  const text = String(visibleText || '').normalize('NFKC');
  const haystack = text + '\n' + raw;
  const values = [];

  const add = (value, score, source) => {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 100 || amount > 5000) return;
    if (amount >= 1900 && amount <= 2100) return; // 年を金額として拾わない
    values.push({ amount, score, source });
  };

  for (const match of haystack.matchAll(/(?:税込(?:み)?\s*)?([1-9]\d{2,4})\s*円(?:\s*まで)?/gi)) {
    add(match[1], 1000, 'yen-text');
  }
  for (const match of haystack.matchAll(/(?:DRINK\s*TICKET|ドリンク\s*チケット)[^0-9]{0,100}([1-9]\d{2,4})/gi)) {
    add(match[1], 700, 'ticket-text');
  }
  for (const match of raw.matchAll(/(?:ticketValue|faceValue|amount|price|upperLimit|limit)[^0-9]{0,40}([1-9]\d{2,4})/gi)) {
    add(match[1], 600, 'data-field');
  }

  for (const item of htmlImageDescriptors(html)) {
    const label = (item.source + ' ' + item.alt).normalize('NFKC');
    if (!/ticket|gift|drink|egift|スターバックス/i.test(label)) continue;
    for (const match of label.matchAll(/(?:^|[^0-9])([1-9]\d{2,4})(?:[^0-9]|$)/g)) {
      add(match[1], 450, 'image-label');
    }
  }

  return values.sort((a, b) => b.score - a.score || a.amount - b.amount);
}

async function fetchStarbucksCover(html, current, amount) {
  const sources = [];
  const ogImage = starbucksOgImage(html);
  if (ogImage) sources.push({ source: ogImage, og: true, label: ogImage });

  for (const item of htmlImageDescriptors(html)) {
    sources.push({ source: item.source, og: false, label: item.source + ' ' + item.alt });
  }

  const seen = new Set();
  const candidates = [];

  for (const entry of sources) {
    let url;
    try { url = new URL(entry.source, current); } catch { continue; }
    if (url.protocol !== 'https:' || seen.has(url.href)) continue;
    seen.add(url.href);

    const label = String(entry.label || '').normalize('NFKC');
    const officialHost = /(^|\.)starbucks\.co\.jp$/i.test(url.hostname);
    if (!officialHost && !entry.og) continue;

    let score = entry.og ? 100 : 0;
    if (/ticket|gift|drink|egift/i.test(label)) score += 1200;
    if (amount && new RegExp('(?:^|[^0-9])' + amount + '(?:[^0-9]|$)').test(label)) score += 1400;
    if (/card|coupon/i.test(label)) score += 400;
    if (/logo|icon|arrow|qr|barcode|brandmark/i.test(label)) score -= 3000;
    if (/starbucks/i.test(label) && !/ticket|gift|drink|egift/i.test(label)) score -= 250;

    candidates.push({ url, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  let best = null;
  for (const candidate of candidates.slice(0, 10)) {
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

      // ロゴのような小画像より、券面の大きい画像を優先する。
      const weighted = candidate.score + Math.min(bytes.length, 2500000) / 600;
      if (!best || weighted > best.weighted) best = { bytes, contentType, weighted };
    } catch {}
  }

  if (!best) return null;

  let binary = '';
  for (let i = 0; i < best.bytes.length; i += 32768) {
    binary += String.fromCharCode(...best.bytes.subarray(i, i + 32768));
  }
  return 'data:' + best.contentType + ';base64,' + btoa(binary);
}

async function analyzeStarbucksDirectForImport(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.hostname !== 'gift.starbucks.co.jp' || !/^\/e\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) return null;

  const page = await fetchStarbucksDirectPage(urlValue);
  const text = htmlVisibleLines(page.html).join('\n').normalize('NFKC');
  const candidates = starbucksAmountCandidates(page.html, text);
  const amount = Number(candidates[0]?.amount || 0);

  if (!amount) throw new HttpError(422, 'スターバックスeGiftの金額を読み取れませんでした。');

  const expiresOn = extractLatestIsoDate(text + '\n' + decodeHtmlEntities(page.html));
  if (!expiresOn) throw new HttpError(422, 'スターバックスeGiftの有効期限を読み取れませんでした。');

  return {
    product: 'スタバ' + amount,
    redeemPlace: 'スターバックス',
    merchant: 'スターバックス',
    expiresOn,
    productImageDataUri: await fetchStarbucksCover(page.html, page.current, amount),
    site: 'starbucks',
    status: 'ok',
    analysisMode: 'direct-starbucks'
  };
}
function genericOgValue(html, key) {
  const wanted = String(key || '').toLowerCase();
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const name = tag.match(/\b(?:property|name)\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase();
    if (name !== wanted) continue;
    const content = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (content) return decodeHtmlEntities(content);
  }
  return '';
}

async function fetchKomedaDirectPage(urlValue) {
  let current = new URL(urlValue);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    if (current.protocol !== 'https:' || current.hostname !== 'komeda.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(current.pathname)) {
      throw new HttpError(422, 'コメダ公式eGift以外へ転送されたため停止しました。');
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
      throw new HttpError(502, 'コメダeGiftページに接続できませんでした。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'コメダeGiftの転送先を確認できませんでした。');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new HttpError(502, 'コメダeGiftのページ取得エラー（' + response.status + '）');
    return { html: await readResponseText(response, 2500000), current };
  }
  throw new HttpError(422, 'コメダeGiftの転送回数が多すぎます。');
}

function komedaAmountFromPage(html, text) {
  const haystack = (String(text || '') + '\n' + decodeHtmlEntities(String(html || ''))).normalize('NFKC');
  const values = [];
  for (const match of haystack.matchAll(/(?:税込\s*)?([1-9]\d{2,4})\s*円/g)) {
    const amount = Number(match[1]);
    if (amount >= 100 && amount <= 10000 && !(amount >= 1900 && amount <= 2100)) values.push(amount);
  }
  if (values.length) return values[0];
  const title = genericOgValue(html, 'og:title');
  const titleMatch = title.normalize('NFKC').match(/([1-9]\d{2,4})\s*円/);
  return Number(titleMatch?.[1] || 0);
}

async function fetchKomedaCover(html, current, amount) {
  const sources = [];
  const ogImage = genericOgValue(html, 'og:image');
  if (ogImage) sources.push({ source: ogImage, score: 1000 });
  for (const item of htmlImageDescriptors(html)) {
    const label = (item.source + ' ' + item.alt).normalize('NFKC');
    let score = 0;
    if (/gift|ticket|coupon|コメダ|komeda/i.test(label)) score += 800;
    if (amount && new RegExp('(?:^|[^0-9])' + amount + '(?:[^0-9]|$)').test(label)) score += 1000;
    if (/logo|icon|arrow|qr|barcode/i.test(label)) score -= 2500;
    if (score > 0) sources.push({ source: item.source, score });
  }
  sources.sort((a,b)=>b.score-a.score);
  const seen = new Set();
  let best = null;
  for (const entry of sources.slice(0,10)) {
    let url;
    try { url = new URL(entry.source, current); } catch { continue; }
    if (url.protocol !== 'https:' || seen.has(url.href)) continue;
    seen.add(url.href);
    if (!/(^|\.)e-gift\.co$/i.test(url.hostname) && !/(^|\.)komeda\.e-gift\.co$/i.test(url.hostname) && entry.source !== ogImage) continue;
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'image/png,image/jpeg,image/webp,image/*',
          'Referer': current.toString(),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '').split(';',1)[0].toLowerCase().replace('image/jpg','image/jpeg');
      if (!/^image\/(?:png|jpeg|webp)$/.test(contentType)) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const weighted = entry.score + Math.min(bytes.length,2500000)/700;
      if (!best || weighted > best.weighted) best = { bytes, contentType, weighted };
    } catch {}
  }
  if (!best) return null;
  let binary='';
  for(let i=0;i<best.bytes.length;i+=32768) binary += String.fromCharCode(...best.bytes.subarray(i,i+32768));
  return 'data:' + best.contentType + ';base64,' + btoa(binary);
}

async function analyzeKomedaDirectForImport(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.hostname !== 'komeda.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(parsed.pathname)) return null;
  const page = await fetchKomedaDirectPage(urlValue);
  const text = htmlVisibleLines(page.html).join('\n').normalize('NFKC');
  const amount = komedaAmountFromPage(page.html, text);
  if (!amount) throw new HttpError(422, 'コメダeGiftの金額を読み取れませんでした。');
  const expiresOn = extractLatestIsoDate(text + '\n' + decodeHtmlEntities(page.html));
  if (!expiresOn) throw new HttpError(422, 'コメダeGiftの有効期限を読み取れませんでした。');
  return {
    product: amount + '円 コメダコーヒー',
    redeemPlace: 'コメダ珈琲店',
    merchant: 'コメダ珈琲店',
    expiresOn,
    productImageDataUri: await fetchKomedaCover(page.html, page.current, amount),
    site: 'komeda',
    status: 'ok',
    analysisMode: 'direct-komeda'
  };
}
function cleanEgiftTitle(value, brandPattern) {
  let title = decodeHtmlEntities(String(value || '')).normalize('NFKC').replace(/\s+/g, ' ').trim();
  title = title
    .replace(/\s*[|｜]\s*(?:eGift|デジタルギフト|ギフト).*$/i, '')
    .replace(/\s*[-–—]\s*(?:eGift|デジタルギフト|ギフト).*$/i, '')
    .replace(/\s*[|｜]\s*[^|｜]{0,24}$/i, match => brandPattern.test(match) ? '' : match)
    .trim();
  return title;
}

async function fetchLawsonDirectPage(urlValue) {
  const original = new URL(urlValue);
  let current = new URL(original.origin + original.pathname);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    if (current.protocol !== 'https:' || current.hostname !== 'lawson-i.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(current.pathname)) {
      throw new HttpError(422, 'ローソン公式eGift以外へ転送されたため停止しました。');
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
      throw new HttpError(502, 'ローソンeGiftページに接続できませんでした。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'ローソンeGiftの転送先を確認できませんでした。');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new HttpError(502, 'ローソンeGiftのページ取得エラー（' + response.status + '）');
    return { html: await readResponseText(response, 2500000), current };
  }
  throw new HttpError(422, 'ローソンeGiftの転送回数が多すぎます。');
}

function lawsonProductFromPage(html, text) {
  const ogTitle = genericOgValue(html, 'og:title');
  const titleTag = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const rawTitle = ogTitle || titleTag;
  let title = cleanEgiftTitle(rawTitle, /ローソン|LAWSON/i);

  const normalized = (String(text || '') + '\n' + decodeHtmlEntities(String(html || ''))).normalize('NFKC');
  const amountMatch = normalized.match(/(?:税込\s*)?([1-9]\d{2,4})\s*円/);
  const amount = Number(amountMatch?.[1] || 0);

  if (!title || /^(?:ローソン|LAWSON|eGift|ギフト)$/i.test(title)) {
    if (amount) return { product: amount + '円 ローソン', amount };
    return { product: 'ローソン eGift', amount: 0 };
  }

  if (amount && /お買物券|お買い物券|ギフト券|デジタルギフト|ギフト/i.test(title)) {
    return { product: amount + '円 ローソン', amount };
  }

  title = title
    .replace(/\s*ローソン\s*$/i, '')
    .replace(/^ローソン\s*/i, '')
    .trim();

  return { product: title || (amount ? amount + '円 ローソン' : 'ローソン eGift'), amount };
}

async function fetchLawsonCover(html, current, amount) {
  const sources = [];
  const ogImage = genericOgValue(html, 'og:image');
  if (ogImage) sources.push({ source: ogImage, score: 1000, og: true });

  for (const item of htmlImageDescriptors(html)) {
    const label = (item.source + ' ' + item.alt).normalize('NFKC');
    let score = 0;
    if (/gift|ticket|coupon|ローソン|lawson/i.test(label)) score += 800;
    if (amount && new RegExp('(?:^|[^0-9])' + amount + '(?:[^0-9]|$)').test(label)) score += 1000;
    if (/logo|icon|arrow|qr|barcode/i.test(label)) score -= 2500;
    if (score > 0) sources.push({ source: item.source, score, og: false });
  }

  sources.sort((a,b)=>b.score-a.score);
  const seen = new Set();
  let best = null;

  for (const entry of sources.slice(0,10)) {
    let url;
    try { url = new URL(entry.source, current); } catch { continue; }
    if (url.protocol !== 'https:' || seen.has(url.href)) continue;
    seen.add(url.href);

    if (!/(^|\.)e-gift\.co$/i.test(url.hostname) && url.hostname !== 'lawson-i.e-gift.co' && !entry.og) continue;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'image/png,image/jpeg,image/webp,image/*',
          'Referer': current.toString(),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '').split(';',1)[0].toLowerCase().replace('image/jpg','image/jpeg');
      if (!/^image\/(?:png|jpeg|webp)$/.test(contentType)) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const weighted = entry.score + Math.min(bytes.length,2500000)/700;
      if (!best || weighted > best.weighted) best = { bytes, contentType, weighted };
    } catch {}
  }

  if (!best) return null;
  let binary='';
  for(let i=0;i<best.bytes.length;i+=32768) binary += String.fromCharCode(...best.bytes.subarray(i,i+32768));
  return 'data:' + best.contentType + ';base64,' + btoa(binary);
}

async function analyzeLawsonDirectForImport(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.hostname !== 'lawson-i.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(parsed.pathname)) return null;

  const page = await fetchLawsonDirectPage(urlValue);
  const text = htmlVisibleLines(page.html).join('\n').normalize('NFKC');
  const item = lawsonProductFromPage(page.html, text);
  const expiresOn = extractLatestIsoDate(text + '\n' + decodeHtmlEntities(page.html));

  if (!item.product) throw new HttpError(422, 'ローソンeGiftの商品名を読み取れませんでした。');
  if (!expiresOn) throw new HttpError(422, 'ローソンeGiftの有効期限を読み取れませんでした。');

  return {
    product: item.product,
    redeemPlace: 'ローソン',
    merchant: 'ローソン',
    expiresOn,
    productImageDataUri: await fetchLawsonCover(page.html, page.current, item.amount),
    site: 'lawson',
    status: 'ok',
    analysisMode: 'direct-lawson'
  };
}

async function fetchMisterDonutDirectPage(urlValue) {
  const original = new URL(urlValue);
  let current = new URL(original.origin + original.pathname);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    if (current.protocol !== 'https:' || current.hostname !== 'misterdonut.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(current.pathname)) {
      throw new HttpError(422, 'ミスタードーナツ公式eGift以外へ転送されたため停止しました。');
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
      throw new HttpError(502, 'ミスタードーナツeGiftページに接続できませんでした。');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(422, 'ミスタードーナツeGiftの転送先を確認できませんでした。');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new HttpError(502, 'ミスタードーナツeGiftのページ取得エラー（' + response.status + '）');
    return { html: await readResponseText(response, 2500000), current };
  }
  throw new HttpError(422, 'ミスタードーナツeGiftの転送回数が多すぎます。');
}

function misterDonutProductFromPage(html, text) {
  const ogTitle = genericOgValue(html, 'og:title');
  const titleTag = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  let title = cleanEgiftTitle(ogTitle || titleTag, /ミスタードーナツ|ミスド|MISTER\s*DONUT/i)
    .replace(/^ミスタードーナツ\s*/i, '')
    .replace(/\s*ミスタードーナツ$/i, '')
    .trim();

  const haystack = (String(text || '') + '\n' + decodeHtmlEntities(String(html || ''))).normalize('NFKC');
  const amounts = [];
  for (const match of haystack.matchAll(/(?:税込\s*)?([1-9]\d{2,4})\s*円/g)) {
    const amount = Number(match[1]);
    if (amount >= 100 && amount <= 10000 && !(amount >= 1900 && amount <= 2100)) amounts.push(amount);
  }
  const amount = amounts[0] || Number(title.match(/([1-9]\d{2,4})\s*円/)?.[1] || 0);

  if (amount && /ギフトチケット|お買物券|お買い物券|ギフト券|デジタルギフト|チケット/i.test(title || haystack)) {
    return { product: amount + '円 ミスタードーナツ', amount };
  }

  if (!title || /^(?:eGift|ギフト|ミスタードーナツ)$/i.test(title)) {
    return { product: amount ? amount + '円 ミスタードーナツ' : 'ミスタードーナツ eGift', amount };
  }

  return { product: title, amount };
}

async function fetchMisterDonutCover(html, current, amount) {
  const sources = [];
  const ogImage = genericOgValue(html, 'og:image');
  if (ogImage) sources.push({ source: ogImage, score: 1000, og: true });

  for (const item of htmlImageDescriptors(html)) {
    const label = (item.source + ' ' + item.alt).normalize('NFKC');
    let score = 0;
    if (/gift|ticket|coupon|donut|ミスタードーナツ|ミスド/i.test(label)) score += 900;
    if (amount && new RegExp('(?:^|[^0-9])' + amount + '(?:[^0-9]|$)').test(label)) score += 1100;
    if (/main|visual|image|card/i.test(label)) score += 250;
    if (/logo|icon|arrow|qr|barcode|brandmark/i.test(label)) score -= 2800;
    if (score > 0) sources.push({ source: item.source, score, og: false });
  }

  sources.sort((a,b)=>b.score-a.score);
  const seen = new Set();
  let best = null;

  for (const entry of sources.slice(0,12)) {
    let url;
    try { url = new URL(entry.source, current); } catch { continue; }
    if (url.protocol !== 'https:' || seen.has(url.href)) continue;
    seen.add(url.href);

    if (!/(^|\.)e-gift\.co$/i.test(url.hostname) && url.hostname !== 'misterdonut.e-gift.co' && !entry.og) continue;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'image/png,image/jpeg,image/webp,image/*',
          'Referer': current.toString(),
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const contentType = (response.headers.get('content-type') || '').split(';',1)[0].toLowerCase().replace('image/jpg','image/jpeg');
      if (!/^image\/(?:png|jpeg|webp)$/.test(contentType)) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;

      const weighted = entry.score + Math.min(bytes.length,2500000)/650;
      if (!best || weighted > best.weighted) best = { bytes, contentType, weighted };
    } catch {}
  }

  if (!best) return null;
  let binary='';
  for(let i=0;i<best.bytes.length;i+=32768) binary += String.fromCharCode(...best.bytes.subarray(i,i+32768));
  return 'data:' + best.contentType + ';base64,' + btoa(binary);
}

async function analyzeMisterDonutDirectForImport(urlValue) {
  const parsed = new URL(urlValue);
  if (parsed.hostname !== 'misterdonut.e-gift.co' || !/^\/c\/[A-Za-z0-9_-]{6,200}\/\d{1,8}\/?$/.test(parsed.pathname)) return null;

  const page = await fetchMisterDonutDirectPage(urlValue);
  const text = htmlVisibleLines(page.html).join('\n').normalize('NFKC');
  const item = misterDonutProductFromPage(page.html, text);
  const expiresOn = extractLatestIsoDate(text + '\n' + decodeHtmlEntities(page.html));

  if (!item.product) throw new HttpError(422, 'ミスタードーナツeGiftの商品名を読み取れませんでした。');
  if (!expiresOn) throw new HttpError(422, 'ミスタードーナツeGiftの有効期限を読み取れませんでした。');

  return {
    product: item.product,
    redeemPlace: 'ミスタードーナツ',
    merchant: 'ミスタードーナツ',
    expiresOn,
    productImageDataUri: await fetchMisterDonutCover(page.html, page.current, item.amount),
    site: 'misterdonut',
    status: 'ok',
    analysisMode: 'direct-misterdonut'
  };
}

async function analyzeCouponForImport(urlValue, env) {
  const detail = await fetchAnalyzerJson(env, '/api/analyze-detail', { url: urlValue, mode: 'stable' });
  if (detail.ok && detail.data?.status === 'ok') {
    return { ...detail.data, analysisMode: 'shared-analyzer' };
  }

  const message = detail.data?.error || detail.data?.message || 'クーポン解析に失敗しました。';
  if (detail.data?.status === 'used') throw new HttpError(422, 'このクーポンは利用済みです。');
  throw new HttpError(detail.status >= 400 && detail.status < 500 ? 422 : 502, message);
}

async function deleteCoupon(request, env, couponId) {
  const coupon = await env.COUPON_DB.prepare(`
    SELECT id, name, coupon_type, cover_object_key
    FROM coupons
    WHERE id = ?
  `).bind(couponId).first();

  if (!coupon) throw new HttpError(404, '削除するクーポンが見つかりません。');

  const active = await env.COUPON_DB.prepare(`
    SELECT COUNT(*) AS count
    FROM reservations
    WHERE coupon_id = ?
      AND status IN ('reserved', 'pending_confirmation')
      AND expires_at > ?
  `).bind(couponId, nowSeconds()).first();

  if (Number(active?.count || 0) > 0) {
    throw new HttpError(409, '予約中のクーポンは削除できません。予約を完了またはキャンセルしてください。');
  }

  const imageRows = await env.COUPON_DB.prepare(`
    SELECT i.object_key
    FROM coupon_items i
    JOIN coupon_expiries e ON e.id = i.expiry_id
    WHERE e.coupon_id = ?
      AND i.object_key IS NOT NULL
  `).bind(couponId).all();

  const imageKeys = [
    coupon.cover_object_key,
    ...(imageRows.results || []).map(row => row.object_key)
  ].filter(Boolean);

  const statements = [
    env.COUPON_DB.prepare(`
      DELETE FROM coupon_items
      WHERE expiry_id IN (SELECT id FROM coupon_expiries WHERE coupon_id = ?)
    `).bind(couponId),
    env.COUPON_DB.prepare('DELETE FROM reservations WHERE coupon_id = ?').bind(couponId),
    env.COUPON_DB.prepare('DELETE FROM coupon_expiries WHERE coupon_id = ?').bind(couponId),
    env.COUPON_DB.prepare('DELETE FROM coupon_url_reconcile WHERE coupon_id = ?').bind(couponId),
    env.COUPON_DB.prepare('DELETE FROM coupons WHERE id = ?').bind(couponId)
  ];

  const results = await env.COUPON_DB.batch(statements);
  const deleted = Number(results.at(-1)?.meta?.changes || 0);
  if (!deleted) throw new HttpError(409, 'クーポンを削除できませんでした。');

  let imageDeleteFailed = 0;
  if (imageKeys.length) {
    try {
      await env.COUPON_IMAGES.delete([...new Set(imageKeys)]);
    } catch {
      imageDeleteFailed = imageKeys.length;
    }
  }

  return json(request, env, {
    deleted: true,
    couponId,
    name: coupon.name,
    deletedImageCount: imageDeleteFailed ? 0 : [...new Set(imageKeys)].length,
    imageCleanupPending: imageDeleteFailed > 0
  });
}

async function registerAutoCoupon(request, env) {
  const body = await readJson(request);
  const urlValue = normalizeUrl(String(body.url || '').trim());
  const fingerprint = await sha256Text(urlValue);

  const duplicate = await env.COUPON_DB.prepare(`
    SELECT c.name, c.redeem_place, c.capacity, e.expires_on
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
      capacity: duplicate.capacity || '',
      redeemPlace: duplicate.redeem_place || '',
      expiresOn: duplicate.expires_on,
      imageSaved: true,
      analysisMode: 'duplicate'
    });
  }

  const suppliedName = String(body.name || body.product || '').trim();
  const suppliedPlace = String(body.redeemPlace || body.merchant || '').trim();
  const suppliedExpiry = String(body.expiresOn || '').trim();
  const suppliedCapacity = String(body.capacity || '').trim();
  const hasSuppliedAnalysis = suppliedName && suppliedPlace && /^\d{4}-\d{2}-\d{2}$/.test(suppliedExpiry);

  const analyzed = hasSuppliedAnalysis
    ? {
        product: suppliedName,
        capacity: suppliedCapacity,
        redeemPlace: suppliedPlace,
        merchant: suppliedPlace,
        expiresOn: suppliedExpiry,
        productImageDataUri: body.productImageDataUri || null,
        status: 'ok',
        analysisMode: 'client-fallback'
      }
    : await analyzeCouponForImport(urlValue, env);

  const identity = await ensureIdentityCoupon(env, analyzed);

  if (identity.expiresOn < todayInTokyo()) {
    throw new HttpError(422, '期限切れのクーポンは登録できません。');
  }

  const result = await env.COUPON_DB.prepare(`
    INSERT OR IGNORE INTO coupon_items
      (id, expiry_id, item_type, url_value, object_key, fingerprint, original_name, mime_type, created_at)
    VALUES (?, ?, 'url', ?, NULL, ?, NULL, NULL, ?)
  `).bind(crypto.randomUUID(), identity.expiryId, urlValue, fingerprint, nowSeconds()).run();

  const newCount = Number(result.meta?.changes || 0);
  await mergeCanonicalCouponGroups(env);

  return json(request, env, {
    newCount,
    duplicateCount: newCount ? 0 : 1,
    name: identity.name,
    product: identity.name,
    capacity: identity.capacity,
    redeemPlace: identity.redeemPlace,
    expiresOn: identity.expiresOn,
    imageSaved: true,
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
