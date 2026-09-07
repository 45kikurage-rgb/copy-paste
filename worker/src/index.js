const RESERVATION_SECONDS = 10 * 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS_PER_REGISTRATION = 100;

export default {
  async fetch(request, env) {
    try {
      assertBindings(env);
      if (request.method === 'OPTIONS') return corsResponse(request, env, new Response(null, { status: 204 }));
      if (!isOriginAllowed(request, env)) return json(request, env, { error: 'このサイトからは利用できません。' }, 403);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      await releaseExpired(env);

      if (request.method === 'GET' && path === '/api/health') {
        return json(request, env, { ok: true, reservationMinutes: 10 });
      }
      if (request.method === 'GET' && path === '/api/coupons') return await listCoupons(request, env);
      if (request.method === 'POST' && path === '/api/coupons/register') return await registerCoupon(request, env);

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

async function listCoupons(request, env) {
  const now = nowSeconds();
  const today = todayInTokyo();
  const result = await env.COUPON_DB.prepare(`
    SELECT c.id, c.name, c.coupon_type, c.cover_object_key,
           e.expires_on,
           COUNT(i.id) AS remaining_count,
           SUM(CASE WHEN i.reservation_id IS NULL OR i.reservation_expires_at <= ? THEN 1 ELSE 0 END) AS available_count
    FROM coupons c
    JOIN coupon_expiries e ON e.coupon_id = c.id AND e.expires_on >= ?
    JOIN coupon_items i ON i.expiry_id = e.id
    GROUP BY c.id, e.id
    HAVING COUNT(i.id) > 0
    ORDER BY e.expires_on ASC, c.created_at ASC
  `).bind(now, today).all();

  const map = new Map();
  for (const row of result.results || []) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        name: row.name,
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
  const row = await env.COUPON_DB.prepare('SELECT cover_object_key FROM coupons WHERE id = ?').bind(couponId).first();
  if (!row?.cover_object_key) throw new HttpError(404, '代表画像がありません。');
  const object = await env.COUPON_IMAGES.get(row.cover_object_key);
  if (!object) throw new HttpError(404, '代表画像がありません。');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=3600');
  return corsResponse(request, env, new Response(object.body, { headers }));
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
