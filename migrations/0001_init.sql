-- Giftlist schema. All money is stored in cents; all timestamps are epoch ms;
-- calendar dates (order date, ETA, deadline) are 'YYYY-MM-DD' strings.

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  google_sub          TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  name                TEXT,
  picture             TEXT,
  gmail_refresh_token TEXT,              -- AES-GCM encrypted; NULL = Gmail not connected
  gmail_connected_at  INTEGER,
  scan_since          TEXT NOT NULL,     -- only emails on/after this date are scanned
  deadline            TEXT NOT NULL,     -- gift-giving day, used for "cutting it close" warnings
  last_scan_at        INTEGER,
  last_scan_error     TEXT,
  scan_started_at     INTEGER,           -- simple lock so two scans don't overlap
  created_at          INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,           -- SHA-256 of the cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- People you are buying for.
CREATE TABLE recipients (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  budget_cents INTEGER,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX recipients_user ON recipients(user_id);

-- The gift list: things you plan to buy (or already bought).
CREATE TABLE items (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id       TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  notes              TEXT,
  url                TEXT,
  target_price_cents INTEGER,
  manual_status      TEXT,               -- NULL | 'in_hand' (bought in person / arrived) | 'wrapped'
  manual_price_cents INTEGER,            -- spend not covered by a tracked order (e.g. bought in store)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX items_user ON items(user_id);

-- Orders found in email (or entered by hand).
CREATE TABLE orders (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor             TEXT NOT NULL,
  vendor_key         TEXT NOT NULL,      -- normalized vendor, used for muting
  order_number       TEXT,               -- as shown to the shopper
  order_key          TEXT,               -- normalized order number, used for dedupe
  order_date         TEXT,
  total_cents        INTEGER,
  currency           TEXT NOT NULL DEFAULT 'USD',
  status             TEXT NOT NULL DEFAULT 'ordered', -- ordered|shipped|out_for_delivery|delivered|cancelled|returned
  estimated_delivery TEXT,
  has_confirmation   INTEGER NOT NULL DEFAULT 0, -- 1 once the order-confirmation email was read
  ignored            INTEGER NOT NULL DEFAULT 0, -- 1 = "not a gift", hidden from the dashboard
  source             TEXT NOT NULL DEFAULT 'email', -- email|manual
  email_subject      TEXT,
  note               TEXT,               -- something the scanner couldn't resolve, shown on the order
  last_event_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX orders_user ON orders(user_id);
-- Not unique: small shops reuse numbers like #1042, so an order is identified
-- by its number *and* its store (see scan/apply.ts).
CREATE INDEX orders_user_key ON orders(user_id, order_key);

CREATE TABLE shipments (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id           TEXT REFERENCES orders(id) ON DELETE CASCADE,
  carrier            TEXT,
  tracking_number    TEXT NOT NULL,
  tracking_url       TEXT,
  status             TEXT NOT NULL DEFAULT 'in_transit', -- in_transit|out_for_delivery|delivered|exception
  estimated_delivery TEXT,
  delivered_at       TEXT,
  last_event_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX shipments_user_tracking ON shipments(user_id, tracking_number);
CREATE INDEX shipments_order ON shipments(order_id);

-- Products inside an order, and how each one maps to the gift list.
CREATE TABLE order_lines (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id               TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  description            TEXT NOT NULL,
  quantity               INTEGER NOT NULL DEFAULT 1,
  unit_price_cents       INTEGER,
  status                 TEXT NOT NULL DEFAULT 'active', -- active|cancelled|returned
  shipment_id            TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  item_id                TEXT REFERENCES items(id) ON DELETE SET NULL,
  match_state            TEXT NOT NULL DEFAULT 'unmatched', -- unmatched|suggested|matched|ignored
  match_source           TEXT,           -- ai|fuzzy|user
  suggested_recipient_id TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  ship_to_name           TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_item ON order_lines(item_id);
CREATE INDEX order_lines_user ON order_lines(user_id);

-- Every Gmail message we have looked at, so nothing is read (or billed) twice.
CREATE TABLE emails (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gmail_id     TEXT NOT NULL,
  from_addr    TEXT,
  subject      TEXT,
  received_at  INTEGER,
  kind         TEXT,                     -- 'pending' while being read, then the extraction kind, or 'error'
  order_id     TEXT REFERENCES orders(id) ON DELETE SET NULL,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0, -- tries so far; an email is skipped after 3
  processed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX emails_user_gmail ON emails(user_id, gmail_id);

-- Merchants whose future orders are hidden automatically (groceries, etc.).
CREATE TABLE muted_vendors (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_key TEXT NOT NULL,
  vendor     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vendor_key)
);
