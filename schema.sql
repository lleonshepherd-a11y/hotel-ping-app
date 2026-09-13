CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  on_duty INTEGER NOT NULL DEFAULT 1,
  photo_path TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_dept TEXT NOT NULL,
  to_dept TEXT,
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
  reply_to_id TEXT,
  pinned_at TEXT,
  completed_at TEXT,
  completed_by TEXT,
  escalated_at TEXT,
  broadcast_id TEXT,
  room_number TEXT,
  read_at TEXT,
  task_status TEXT,
  group_id TEXT,
  edited_at TEXT,
  mentions TEXT,
  signoff_title TEXT,
  signoff_amount REAL,
  signoff_target TEXT,
  signoff_status TEXT,
  signoff_decided_by TEXT,
  signoff_decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);

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

CREATE TABLE IF NOT EXISTS muted_conversations (
  department_id TEXT NOT NULL,
  other_dept_id TEXT NOT NULL,
  muted_at TEXT NOT NULL,
  PRIMARY KEY (department_id, other_dept_id)
);

CREATE TABLE IF NOT EXISTS handover_notes (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_dept ON handover_notes(department_id, created_at);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  archived_at TEXT,
  shared_at TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_dept ON group_members(department_id);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);

CREATE TABLE IF NOT EXISTS group_reads (
  group_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (group_id, department_id)
);

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id TEXT PRIMARY KEY,
  room_number TEXT,
  description TEXT NOT NULL,
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','in_progress','fixed')),
  priority TEXT NOT NULL DEFAULT 'problem' CHECK(priority IN ('safety','guest','problem','routine')),
  guest_present INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  pinned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_tickets(status, created_at);

CREATE TABLE IF NOT EXISTS external_notifications (
  idempotency_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_replies (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  from_dept TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_replies_ticket ON maintenance_replies(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS guest_requests (
  id TEXT PRIMARY KEY,
  room_number TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','completed')),
  reply_text TEXT,
  pinned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_guest_requests_status ON guest_requests(status, created_at);

CREATE TABLE IF NOT EXISTS quick_replies (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_dept ON quick_replies(department_id, position);

INSERT OR IGNORE INTO departments (id, name, contact_name, on_duty) VALUES
  ('gm', 'General Manager', 'Dave', 1),
  ('foh', 'Head Receptionist', NULL, 1),
  ('concierge', 'Head Concierge', NULL, 1),
  ('restaurant', 'Restaurant Manager', NULL, 1),
  ('kitchen', 'Head Chef', 'Peter', 1),
  ('bar', 'Bar Manager', NULL, 1),
  ('housekeeping', 'Head Housekeeper', NULL, 1),
  ('maintenance', 'Maintenance Manager', NULL, 1);
