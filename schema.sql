CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  on_duty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_dept TEXT NOT NULL,
  to_dept TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','image','file','audio')),
  body TEXT,
  file_name TEXT,
  file_path TEXT,
  file_size INTEGER,
  duration REAL,
  transcript TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'delivered',
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  reply_to_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_dept, to_dept, created_at);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  profile_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_staff ON push_subscriptions(staff_id);

CREATE TABLE IF NOT EXISTS typing_status (
  from_dept TEXT NOT NULL,
  to_dept TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (from_dept, to_dept)
);

INSERT OR IGNORE INTO departments (id, name, contact_name, on_duty) VALUES
  ('gm', 'General Manager', 'Dave', 1),
  ('foh', 'Front of House', NULL, 1),
  ('concierge', 'Concierge', NULL, 1),
  ('restaurant', 'Restaurant', NULL, 1),
  ('kitchen', 'Kitchen', 'Peter', 1),
  ('bar', 'Bar', NULL, 1),
  ('housekeeping', 'Housekeeping', NULL, 1),
  ('maintenance', 'Maintenance', NULL, 1);
