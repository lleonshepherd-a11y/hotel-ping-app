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
  dashboard_conversation_id TEXT,
  room_clean TEXT,
  from_staff_name TEXT,
  client_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);
-- Lets a resent message (e.g. after a dropped connection) be recognised as
-- the same send rather than creating a duplicate - see client_message_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_message_id) WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_dept, to_dept, created_at);

-- One reaction per department per message - tapping the same emoji again
-- (in the worker's toggle handler) removes the row rather than stacking.
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

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
  confirmed_by_staff_id TEXT,
  created_by_staff_id TEXT,
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
  created_by_staff_id TEXT,
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

-- Group/event fields that live here rather than on the dashboard's own
-- groups table (NOIR_DB) - same split as maintenance_ticket_meta.
CREATE TABLE IF NOT EXISTS group_meta (
  group_id TEXT PRIMARY KEY,
  shared_at TEXT
);

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
  voice_path TEXT,
  voice_duration INTEGER,
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
  escalated_at TEXT,
  sort_order REAL
);

-- One row per status transition a ticket goes through (reported ->
-- in_progress -> fixed, or any repeat), so "who marked this fixed and
-- when" is always answerable after the fact - maintenance_tickets.status
-- itself only ever holds the current value.
CREATE TABLE IF NOT EXISTS maintenance_ticket_status_log (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by_staff_id TEXT NOT NULL,
  changed_by_name TEXT,
  changed_by_department_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_status_log_ticket ON maintenance_ticket_status_log(ticket_id, created_at);

-- Planner/calendar entries from the dashboard, surfaced to a department as
-- a standalone notification in "Missed" - never as a chat message from a
-- pretend sender. entry_id is the dashboard's own id, so this table also
-- dedupes: the cron check never re-notifies the same entry twice.
CREATE TABLE IF NOT EXISTS planner_alerts_sent (
  entry_id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  department_id TEXT,
  title TEXT,
  starts_at TEXT,
  details TEXT,
  read_at TEXT
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

-- Floor plans and named zones/subzones. This is the data half of the
-- location service the SOS flow calls - see resolveLocation() in worker.js
-- for the service boundary itself.
CREATE TABLE IF NOT EXISTS floors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  plan_image_path TEXT,
  created_at TEXT NOT NULL
);
-- lat/lng are optional and approximate - a single reference point for the
-- zone, not a boundary. They're what let resolveLocation() match a real
-- device-reported position (see below) to a zone; a zone with no
-- coordinates set can still be used manually via department_zone_stub.
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  floor_id TEXT NOT NULL,
  parent_zone_id TEXT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_floor ON zones(floor_id, position);

-- Location service STUB: until real indoor positioning (BLE beacons, WiFi
-- RTT, UWB tags, whatever) is wired in, each department's "current zone"
-- is just whatever an admin last set it to here for testing. resolveLocation()
-- is the only thing that reads this table - swapping in a real positioning
-- backend later means rewriting that one function, nothing else.
CREATE TABLE IF NOT EXISTS department_zone_stub (
  department_id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Press-and-hold safety alerts. Deliberately separate from the messages
-- table - no typing, no department picker, never appears in a chat thread.
-- Goes to every predefined responder department with department + time,
-- plus whatever the location service could resolve (zone-level at best -
-- never more precise than what's actually known).
CREATE TABLE IF NOT EXISTS help_alerts (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  raised_by_name TEXT,
  raised_by_staff_id TEXT,
  created_at TEXT NOT NULL,
  responded_by_name TEXT,
  responded_at TEXT,
  location_available INTEGER NOT NULL DEFAULT 0,
  location_source TEXT,
  floor_name TEXT,
  zone_name TEXT,
  subzone_name TEXT,
  location_accuracy_m REAL
);
CREATE INDEX IF NOT EXISTS idx_help_alerts_created ON help_alerts(created_at);

-- GM priority broadcast: a single alert pinned across every department's
-- screen (e.g. "Fire Alarm Test at 10:00 AM") until each department
-- accepts it, or the GM clears it for everyone.
CREATE TABLE IF NOT EXISTS priority_broadcasts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cleared_at TEXT
);
CREATE TABLE IF NOT EXISTS priority_broadcast_acks (
  broadcast_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (broadcast_id, department_id)
);

-- Housekeeping room status board. A standalone list of room labels (not
-- the SOS zone mapper's rooms - a hotel's real room numbers rarely line up
-- with how its floors are zoned for locating someone in an emergency), each
-- either dirty or clean. Marking a room clean notifies reception (foh).
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'dirty' CHECK(status IN ('dirty','clean')),
  cleaned_at TEXT,
  cleaned_by_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_position ON rooms(position);

-- Which specific NOIR_DB staff member is the named, directly-reachable
-- contact for a department (e.g. head_kitchen -> the actual Head Chef).
-- One row per department, admin-assigned in Hotel Setup.
CREATE TABLE IF NOT EXISTS department_heads (
  department_id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Personal photo for a NOIR_DB staff member. Staff records live in NOIR_DB
-- (not owned by this codebase), so this is a local companion table, same
-- pattern as maintenance_ticket_meta.
CREATE TABLE IF NOT EXISTS staff_photos (
  staff_id TEXT PRIMARY KEY,
  photo_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Self-service signup: name + department only, sitting here until the GM
-- accepts or denies it. Approving one creates the real NOIR_DB staff row -
-- nothing here is itself a usable account.
CREATE TABLE IF NOT EXISTS signup_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests(status, created_at);

-- The hotel's own identity shown across the app (Profile page header) -
-- separate from the Hotel Ping product brand, which only appears in the
-- "Powered by" footer. Single row, id is always 'default'.
CREATE TABLE IF NOT EXISTS hotel_profile (
  id TEXT PRIMARY KEY,
  name TEXT,
  logo_path TEXT,
  updated_at TEXT NOT NULL
);

-- Private voice/text notes a staff member records for themselves - e.g.
-- recording through a meeting so they don't have to remember a list by
-- heart. Never shared with anyone else; scoped by staff_id (the NOIR_DB
-- session identity) rather than joined against the staff table, matching
-- how messages.from_staff_name is captured at write time rather than
-- joined at read time.
CREATE TABLE IF NOT EXISTS personal_notes (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  staff_name TEXT,
  title TEXT,
  body TEXT,
  file_path TEXT,
  file_size INTEGER,
  duration REAL,
  transcript TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_personal_notes_staff ON personal_notes(staff_id, created_at);

-- Every unhandled server error, so a GM can see when something's actually
-- broken from inside the app itself instead of only via `wrangler tail`
-- (which needs a terminal open and watching live to catch anything).
CREATE TABLE IF NOT EXISTS error_log (
  id TEXT PRIMARY KEY,
  method TEXT,
  path TEXT,
  message TEXT,
  stack TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);

INSERT OR IGNORE INTO departments (id, name, contact_name, on_duty) VALUES
  ('gm', 'General Manager', 'Dave', 1),
  ('foh', 'Reception', NULL, 1),
  ('concierge', 'Concierge', NULL, 1),
  ('restaurant', 'Restaurant', NULL, 1),
  ('kitchen', 'Kitchen', 'Peter', 1),
  ('bar', 'Bar', NULL, 1),
  ('housekeeping', 'Housekeeping', NULL, 1),
  ('maintenance', 'Maintenance', NULL, 1);
