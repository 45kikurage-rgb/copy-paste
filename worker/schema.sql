PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  coupon_type TEXT NOT NULL CHECK (coupon_type IN ('url', 'image')),
  cover_object_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (name_key, coupon_type)
);

CREATE TABLE IF NOT EXISTS coupon_expiries (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  expires_on TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (coupon_id, expires_on)
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  coupon_type TEXT NOT NULL CHECK (coupon_type IN ('url', 'image')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'pending_confirmation', 'confirmed', 'cancelled', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_items (
  id TEXT PRIMARY KEY,
  expiry_id TEXT NOT NULL REFERENCES coupon_expiries(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('url', 'image')),
  url_value TEXT,
  object_key TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime_type TEXT,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  reservation_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (item_type = 'url' AND url_value IS NOT NULL AND object_key IS NULL) OR
    (item_type = 'image' AND object_key IS NOT NULL AND url_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_coupon_expiries_coupon_date
  ON coupon_expiries(coupon_id, expires_on);

CREATE INDEX IF NOT EXISTS idx_coupon_items_expiry
  ON coupon_items(expiry_id);

CREATE INDEX IF NOT EXISTS idx_coupon_items_available
  ON coupon_items(reservation_id, reservation_expires_at);

CREATE INDEX IF NOT EXISTS idx_reservations_expiry
  ON reservations(status, expires_at);
