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
  signoff_category TEXT,
  signoff_guest_info TEXT,
  signoff_status TEXT,
  signoff_decided_by TEXT,
  signoff_decided_at TEXT,
  signoff_code TEXT,
  poll_question TEXT,
  poll_options TEXT,
  poll_votes TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  affects_guest INTEGER NOT NULL DEFAULT 0,
  dashboard_conversation_id TEXT
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
  status_line TEXT,
  phone TEXT,
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
  created_at TEXT NOT NULL,
  department_id TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_staff ON push_subscriptions(staff_id);
CREATE INDEX IF NOT EXISTS idx_push_dept ON push_subscriptions(department_id);

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
  shared_at TEXT,
  description TEXT,
  event_date TEXT,
  guest_count INTEGER,
  location TEXT
);

CREATE TABLE IF NOT EXISTS event_stations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  description TEXT,
  icon TEXT,
  assigned_dept_id TEXT,
  confirmed_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_stations_group ON event_stations(group_id, position);

CREATE TABLE IF NOT EXISTS event_runsheet_items (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  time_label TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  team_label TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_runsheet_group ON event_runsheet_items(group_id, position);

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
  pinned_at TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  owner_staff_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_tickets(status, created_at);

-- Maintenance tickets themselves now live in the dashboard's noir-house-db.
-- Its maintenance_tickets table has no columns for pinning or escalation
-- tracking (features Hotel Ping grew after that table was created), so
-- those stay here, keyed to the ticket's id on the dashboard side.
CREATE TABLE IF NOT EXISTS maintenance_ticket_meta (
  ticket_id TEXT PRIMARY KEY,
  pinned_at TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT
);

-- Tracks which of the dashboard's planner entries we've already turned
-- into a chat message alert, so the cron check never re-alerts the same
-- entry on its next tick.
CREATE TABLE IF NOT EXISTS planner_alerts_sent (
  entry_id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blockers (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  waiting_on TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_blockers_open ON blockers(department_id, resolved_at);

CREATE TABLE IF NOT EXISTS external_notifications (
  idempotency_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_guest_request_keys (
  idempotency_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  staff_name TEXT,
  photo_path TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_dept ON stories(department_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (story_id, department_id)
);

CREATE TABLE IF NOT EXISTS asset_requests (
  id TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','borrowed','returned')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  returned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_requests_status ON asset_requests(status, created_at);

INSERT OR IGNORE INTO departments (id, name, contact_name, on_duty) VALUES
  ('gm', 'General Manager', 'Dave', 1),
  ('foh', 'Head Receptionist', NULL, 1),
  ('concierge', 'Head Concierge', NULL, 1),
  ('restaurant', 'Restaurant Manager', NULL, 1),
  ('kitchen', 'Head Chef', 'Peter', 1),
  ('bar', 'Bar Manager', NULL, 1),
  ('housekeeping', 'Head Housekeeper', NULL, 1),
  ('maintenance', 'Maintenance Manager', NULL, 1);
