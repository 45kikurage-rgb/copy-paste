import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

class D1StatementMock {
  constructor(database, sql) { this.database = database; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() {
    const row = this.database.prepare(this.sql).get(...this.params);
    return row || null;
  }
  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params), success: true };
  }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1Mock {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) {
        const prepared = this.database.prepare(statement.sql);
        if (/^\s*(SELECT|UPDATE[\s\S]*RETURNING)/i.test(statement.sql)) {
          results.push({ results: prepared.all(...statement.params), success: true, meta: { changes: 0 } });
        } else {
          const result = prepared.run(...statement.params);
          results.push({ success: true, meta: { changes: Number(result.changes) } });
        }
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  exec(sql) { this.database.exec(sql); }
}

class R2Mock {
  constructor() { this.objects = new Map(); }
  async put(key, value, options = {}) {
    this.objects.set(key, { bytes: new Uint8Array(value), httpMetadata: options.httpMetadata || {} });
  }
  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: new Response(entry.bytes).body,
      httpMetadata: entry.httpMetadata,
      async arrayBuffer() { return entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength); },
      writeHttpMetadata(headers) { if (entry.httpMetadata.contentType) headers.set('Content-Type', entry.httpMetadata.contentType); }
    };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

const db = new D1Mock();
const env = { COUPON_DB: db, COUPON_IMAGES: new R2Mock(), ALLOWED_ORIGINS: 'http://127.0.0.1:4173' };
const API = 'https://api.test';
const ORIGIN = 'http://127.0.0.1:4173';

async function fetchApi(path, options = {}) {
  const request = new Request(`${API}${path}`, { ...options, headers: { Origin: ORIGIN, ...(options.headers || {}) } });
  return worker.fetch(request, env);
}

async function request(path, options = {}, expected = 200) {
  const response = await fetchApi(path, options);
  const body = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`);
  return body;
}

function cover() {
  return new File([new Uint8Array([137, 80, 78, 71])], 'cover.png', { type: 'image/png' });
}

async function registerUrlCoupon() {
  const form = new FormData();
  form.set('name', 'URLテスト');
  form.set('type', 'url');
  form.set('expiresOn', '2099-12-31');
  form.set('coverImage', cover());
  form.set('urls', 'https://example.com/one\nhttps://example.com/two\nhttps://example.com/one');
  const result = await request('/api/coupons/register', { method: 'POST', body: form });
  assert.deepEqual(result, { newCount: 2, duplicateCount: 1 });
}

async function registerImageCoupon() {
  const form = new FormData();
  form.set('name', '画像テスト');
  form.set('type', 'image');
  form.set('expiresOn', '2098-12-31');
  form.set('coverImage', cover());
  form.append('couponImages', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
  form.append('couponImages', new File([new Uint8Array([4, 5, 6])], 'b.png', { type: 'image/png' }));
  form.append('couponImages', new File([new Uint8Array([1, 2, 3])], 'a-copy.png', { type: 'image/png' }));
  const result = await request('/api/coupons/register', { method: 'POST', body: form });
  assert.deepEqual(result, { newCount: 2, duplicateCount: 1 });
}

function reservationHeaders(reservation) {
  return { 'X-Reservation-Token': reservation.token };
}

await request('/api/health');
const denied = await worker.fetch(new Request(`${API}/api/health`, { headers: { Origin: 'https://not-allowed.example' } }), env);
assert.equal(denied.status, 403, '許可していないWebサイトからのAPI操作を拒否');
await registerUrlCoupon();
await registerImageCoupon();

let list = await request('/api/coupons');
assert.equal(list.coupons.length, 2);
assert.equal(list.coupons[0].name, '画像テスト', '期限が早い順');
const urlCoupon = list.coupons.find(coupon => coupon.type === 'url');
const imageCoupon = list.coupons.find(coupon => coupon.type === 'image');

// Promise.allで同時押下を再現。D1は各UPDATEを直列化し、別URLを返す。
const concurrentUrls = await Promise.all([
  fetchApi(`/api/coupons/${urlCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  fetchApi(`/api/coupons/${urlCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
]);
assert.deepEqual(concurrentUrls.map(response => response.status).sort(), [201, 201]);
const urlReservations = await Promise.all(concurrentUrls.map(response => response.json()));
assert.notEqual(urlReservations[0].targetUrl, urlReservations[1].targetUrl, 'URLを二重予約しない');
await request(`/api/coupons/${urlCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 409);

await request(`/api/reservations/${urlReservations[0].reservationId}/cancel`, { method: 'POST', headers: reservationHeaders(urlReservations[0]) });
const released = await request(`/api/coupons/${urlCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 201);
await request(`/api/reservations/${released.reservationId}/used`, { method: 'POST', headers: reservationHeaders(released) });
list = await request('/api/coupons');
assert.equal(list.coupons.find(coupon => coupon.id === urlCoupon.id).remainingCount, 2, '利用しただけでは減らない');
await request(`/api/reservations/${released.reservationId}/confirm`, { method: 'POST', headers: reservationHeaders(released) });
list = await request('/api/coupons');
assert.equal(list.coupons.find(coupon => coupon.id === urlCoupon.id).remainingCount, 1, '確認で1件減る');

// 残る予約を10分経過相当にし、次のAPIアクセスで自動解放されることを確認。
db.exec(`UPDATE coupon_items SET reservation_expires_at = 0 WHERE reservation_id IS NOT NULL;
         UPDATE reservations SET expires_at = 0 WHERE status IN ('reserved', 'pending_confirmation');`);
list = await request('/api/coupons');
assert.equal(list.coupons.find(coupon => coupon.id === urlCoupon.id).availableCount, 1, '期限切れ予約を自動解放');

const imageResponses = await Promise.all([
  fetchApi(`/api/coupons/${imageCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: 2 }) }),
  fetchApi(`/api/coupons/${imageCoupon.id}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: 2 }) })
]);
assert.deepEqual(imageResponses.map(response => response.status).sort(), [201, 409], '画像を二重予約しない');
const imageSuccessResponse = imageResponses.find(response => response.status === 201);
const imageReservation = await imageSuccessResponse.json();
const archive = await fetchApi(`/api/reservations/${imageReservation.reservationId}/download`, { headers: reservationHeaders(imageReservation) });
assert.equal(archive.status, 200);
assert.equal(archive.headers.get('Content-Type'), 'application/zip');
const archiveBytes = new Uint8Array(await archive.arrayBuffer());
assert.equal(new DataView(archiveBytes.buffer).getUint32(0, true), 0x04034b50);
await request(`/api/reservations/${imageReservation.reservationId}/used`, { method: 'POST', headers: reservationHeaders(imageReservation) });
await request(`/api/reservations/${imageReservation.reservationId}/confirm`, { method: 'POST', headers: reservationHeaders(imageReservation) });
list = await request('/api/coupons');
assert.equal(list.coupons.some(coupon => coupon.id === imageCoupon.id), false, '残り0枚のカードを返さない');

const duplicateForm = new FormData();
duplicateForm.set('name', '別名でも重複');
duplicateForm.set('type', 'url');
duplicateForm.set('expiresOn', '2099-12-31');
duplicateForm.set('coverImage', cover());
duplicateForm.set('urls', urlReservations[1].targetUrl);
const duplicate = await request('/api/coupons/register', { method: 'POST', body: duplicateForm });
assert.deepEqual(duplicate, { newCount: 0, duplicateCount: 1 });

const laterExpiryForm = new FormData();
laterExpiryForm.set('name', 'URLテスト');
laterExpiryForm.set('type', 'url');
laterExpiryForm.set('expiresOn', '2100-12-31');
laterExpiryForm.set('coverImage', cover());
laterExpiryForm.set('urls', 'https://example.com/later-expiry');
await request('/api/coupons/register', { method: 'POST', body: laterExpiryForm });
list = await request('/api/coupons');
const groupedCoupon = list.coupons.find(coupon => coupon.id === urlCoupon.id);
assert.equal(groupedCoupon.expiries.length, 2, '同じクーポンを期限ごとにまとめる');
assert.deepEqual(groupedCoupon.expiries.map(expiry => expiry.expiresOn), ['2099-12-31', '2100-12-31']);

console.log('integration: all coupon flows passed');
