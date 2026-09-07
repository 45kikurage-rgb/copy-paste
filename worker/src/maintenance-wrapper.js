import editWorker, { } from './edit-wrapper.js';
import { isOriginAllowed, todayInTokyo } from './index.js';

export default {
  async fetch(request, env) {
    try {
      if (env.COUPON_DB && env.COUPON_IMAGES) await cleanupExpiredCoupons(env);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/backup') {
        if (!isOriginAllowed(request, env)) return responseJson(request, env, { error: 'このサイトからは利用できません。' }, 403);
        return await createBackup(request, env, url.searchParams.get('format') || 'json');
      }
      return editWorker.fetch(request, env);
    } catch (error) {
      console.error(error);
      return responseJson(request, env, { error: 'メンテナンス処理に失敗しました。' }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanupExpiredCoupons(env));
  }
};

async function cleanupExpiredCoupons(env) {
  const today = todayInTokyo();

  const expiredItems = await env.COUPON_DB.prepare(`
    SELECT i.object_key
    FROM coupon_items i
    JOIN coupon_expiries e ON e.id = i.expiry_id
    WHERE e.expires_on < ? AND i.object_key IS NOT NULL
  `).bind(today).all();

  const orphanCovers = await env.COUPON_DB.prepare(`
    SELECT c.id, c.cover_object_key
    FROM coupons c
    WHERE c.cover_object_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM coupon_expiries e
        WHERE e.coupon_id = c.id AND e.expires_on >= ?
      )
  `).bind(today).all();

  await env.COUPON_DB.batch([
    env.COUPON_DB.prepare(`
      DELETE FROM coupon_items
      WHERE expiry_id IN (SELECT id FROM coupon_expiries WHERE expires_on < ?)
    `).bind(today),
    env.COUPON_DB.prepare('DELETE FROM coupon_expiries WHERE expires_on < ?').bind(today),
    env.COUPON_DB.prepare(`
      DELETE FROM reservations
      WHERE coupon_id IN (
        SELECT c.id FROM coupons c
        WHERE NOT EXISTS (SELECT 1 FROM coupon_expiries e WHERE e.coupon_id = c.id)
      )
    `),
    env.COUPON_DB.prepare(`
      DELETE FROM coupons
      WHERE NOT EXISTS (SELECT 1 FROM coupon_expiries e WHERE e.coupon_id = coupons.id)
    `)
  ]);

  const keys = [
    ...(expiredItems.results || []).map(row => row.object_key),
    ...(orphanCovers.results || []).map(row => row.cover_object_key)
  ].filter(Boolean);
  if (keys.length) await env.COUPON_IMAGES.delete([...new Set(keys)]);
}

async function createBackup(request, env, format) {
  const result = await env.COUPON_DB.prepare(`
    SELECT c.name, c.coupon_type AS type, e.expires_on AS expiresOn,
           COUNT(i.id) AS remainingCount
    FROM coupons c
    JOIN coupon_expiries e ON e.coupon_id = c.id
    JOIN coupon_items i ON i.expiry_id = e.id
    GROUP BY c.id, e.id
    ORDER BY e.expires_on ASC, c.name ASC
  `).all();
  const rows = (result.results || []).map(row => ({
    name: row.name,
    type: row.type,
    expiresOn: row.expiresOn,
    remainingCount: Number(row.remainingCount) || 0
  }));
  const stamp = todayInTokyo().replaceAll('-', '');

  if (String(format).toLowerCase() === 'csv') {
    const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [['クーポン名','種類','利用期限','残り枚数'], ...rows.map(row => [row.name, row.type === 'url' ? 'URL型' : '画像型', row.expiresOn, row.remainingCount])];
    const csv = '\ufeff' + lines.map(line => line.map(esc).join(',')).join('\r\n');
    return corsResponse(request, env, new Response(csv, { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="coupon-backup-${stamp}.csv"`,
      'Cache-Control': 'no-store'
    }}));
  }

  return corsResponse(request, env, new Response(JSON.stringify({ exportedAt: new Date().toISOString(), coupons: rows }, null, 2), { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="coupon-backup-${stamp}.json"`,
    'Cache-Control': 'no-store'
  }}));
}

function corsResponse(request, env, response) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  if (origin && isOriginAllowed(request, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}

function responseJson(request, env, data, status = 200) {
  return corsResponse(request, env, new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }));
}
