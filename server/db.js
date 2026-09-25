const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'message-dash.sqlite');

const db = new DatabaseSync(DB_PATH);

db.exec(`
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
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'delivered',
    created_at TEXT NOT NULL,
    FOREIGN KEY (from_dept) REFERENCES departments(id),
    FOREIGN KEY (to_dept) REFERENCES departments(id)
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
    created_at TEXT NOT NULL,
    FOREIGN KEY (department_id) REFERENCES departments(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (staff_id) REFERENCES staff(id)
  );
`);

const departmentColumns = db.prepare("PRAGMA table_info(departments)").all().map((c) => c.name);
if (!departmentColumns.includes('photo_path')) {
  db.exec('ALTER TABLE departments ADD COLUMN photo_path TEXT');
}

const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageColumns.includes('transcript')) {
  db.exec('ALTER TABLE messages ADD COLUMN transcript TEXT');
}
if (!messageColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
}
if (!messageColumns.includes('reply_to_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to_id TEXT');
}
if (!messageColumns.includes('pinned_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN pinned_at TEXT');
}
if (!messageColumns.includes('completed_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN completed_at TEXT');
}
if (!messageColumns.includes('completed_by')) {
  db.exec('ALTER TABLE messages ADD COLUMN completed_by TEXT');
}
if (!messageColumns.includes('escalated_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN escalated_at TEXT');
}
if (!messageColumns.includes('broadcast_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN broadcast_id TEXT');
}
if (!messageColumns.includes('room_number')) {
  db.exec('ALTER TABLE messages ADD COLUMN room_number TEXT');
}
if (!messageColumns.includes('read_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
}
if (!messageColumns.includes('task_status')) {
  db.exec('ALTER TABLE messages ADD COLUMN task_status TEXT');
}
if (!messageColumns.includes('group_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN group_id TEXT');
}
if (!messageColumns.includes('edited_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
}
if (!messageColumns.includes('mentions')) {
  db.exec('ALTER TABLE messages ADD COLUMN mentions TEXT');
}
if (!messageColumns.includes('signoff_title')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_title TEXT');
}
if (!messageColumns.includes('signoff_amount')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_amount REAL');
}
if (!messageColumns.includes('signoff_target')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_target TEXT');
}
if (!messageColumns.includes('signoff_category')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_category TEXT');
}
if (!messageColumns.includes('signoff_guest_info')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_guest_info TEXT');
}
if (!messageColumns.includes('signoff_status')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_status TEXT');
}
if (!messageColumns.includes('signoff_decided_by')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_decided_by TEXT');
}
if (!messageColumns.includes('signoff_decided_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_decided_at TEXT');
}
if (!messageColumns.includes('signoff_code')) {
  db.exec('ALTER TABLE messages ADD COLUMN signoff_code TEXT');
}
if (!messageColumns.includes('dashboard_conversation_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN dashboard_conversation_id TEXT');
}
if (!messageColumns.includes('poll_question')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_question TEXT');
}
if (!messageColumns.includes('poll_options')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_options TEXT');
}
if (!messageColumns.includes('poll_votes')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_votes TEXT');
}
if (!messageColumns.includes('escalation_level')) {
  db.exec('ALTER TABLE messages ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0');
}
if (!messageColumns.includes('affects_guest')) {
  db.exec('ALTER TABLE messages ADD COLUMN affects_guest INTEGER NOT NULL DEFAULT 0');
}
if (!messageColumns.includes('room_clean')) {
  db.exec('ALTER TABLE messages ADD COLUMN room_clean TEXT');
}
if (!messageColumns.includes('from_staff_name')) {
  db.exec('ALTER TABLE messages ADD COLUMN from_staff_name TEXT');
}
if (!messageColumns.includes('client_message_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN client_message_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_message_id) WHERE client_message_id IS NOT NULL');

const toDeptCol = db.prepare("PRAGMA table_info(messages)").all().find((c) => c.name === 'to_dept');
if (toDeptCol && toDeptCol.notnull) {
  db.exec(`
    CREATE TABLE messages_new (
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
      dashboard_conversation_id TEXT,
      poll_question TEXT,
      poll_options TEXT,
      poll_votes TEXT,
      escalation_level INTEGER NOT NULL DEFAULT 0,
      affects_guest INTEGER NOT NULL DEFAULT 0,
      room_clean TEXT,
      from_staff_name TEXT,
      client_message_id TEXT
    );
    INSERT INTO messages_new SELECT id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, deleted_at, reply_to_id, pinned_at, completed_at, completed_by, escalated_at, broadcast_id, room_number, read_at, task_status, group_id, edited_at, mentions, signoff_title, signoff_amount, signoff_target, signoff_category, signoff_guest_info, signoff_status, signoff_decided_by, signoff_decided_at, signoff_code, dashboard_conversation_id, poll_question, poll_options, poll_votes, escalation_level, affects_guest, room_clean, from_staff_name, client_message_id FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_dept, to_dept, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_message_id) WHERE client_message_id IS NOT NULL;
  `);
}

db.exec(`
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
    deleted_at TEXT
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
    pinned_at TEXT,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    escalated_at TEXT,
    owner_staff_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_tickets(status, created_at);

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
`);

const replyColumns = db.prepare("PRAGMA table_info(maintenance_replies)").all().map((c) => c.name);
if (!replyColumns.includes('voice_path')) {
  db.exec('ALTER TABLE maintenance_replies ADD COLUMN voice_path TEXT');
}
if (!replyColumns.includes('voice_duration')) {
  db.exec('ALTER TABLE maintenance_replies ADD COLUMN voice_duration INTEGER');
}

db.exec(`

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

  CREATE TABLE IF NOT EXISTS floors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    plan_image_path TEXT,
    created_at TEXT NOT NULL
  );
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

  CREATE TABLE IF NOT EXISTS department_zone_stub (
    department_id TEXT PRIMARY KEY,
    zone_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'dirty',
    cleaned_at TEXT,
    cleaned_by_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_position ON rooms(position);

  CREATE TABLE IF NOT EXISTS department_heads (
    department_id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staff_photos (
    staff_id TEXT PRIMARY KEY,
    photo_path TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signup_requests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS hotel_profile (
    id TEXT PRIMARY KEY,
    name TEXT,
    logo_path TEXT,
    updated_at TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS ops_calendar_entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time TEXT,
    category_label TEXT NOT NULL,
    category_color TEXT NOT NULL,
    department_ids TEXT NOT NULL,
    staff_ids TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_by TEXT,
    created_by_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ops_calendar_date ON ops_calendar_entries(entry_date);

  CREATE TABLE IF NOT EXISTS ops_planner_reminders_sent (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    interval_days INTEGER NOT NULL,
    department_id TEXT,
    staff_id TEXT,
    title TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time TEXT,
    sent_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ops_planner_reminders_dept ON ops_planner_reminders_sent(department_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_ops_planner_reminders_staff ON ops_planner_reminders_sent(staff_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_ops_planner_reminders_entry ON ops_planner_reminders_sent(entry_id, interval_days);
`);

const calendarColumns = db.prepare("PRAGMA table_info(ops_calendar_entries)").all().map((c) => c.name);
if (!calendarColumns.includes('staff_ids')) {
  db.exec("ALTER TABLE ops_calendar_entries ADD COLUMN staff_ids TEXT NOT NULL DEFAULT '[]'");
}

const maintenanceColumns = db.prepare("PRAGMA table_info(maintenance_tickets)").all().map((c) => c.name);
if (!maintenanceColumns.includes('pinned_at')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN pinned_at TEXT');
}
if (!maintenanceColumns.includes('priority')) {
  db.exec("ALTER TABLE maintenance_tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'problem'");
}
if (!maintenanceColumns.includes('guest_present')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN guest_present INTEGER NOT NULL DEFAULT 0');
}
if (!maintenanceColumns.includes('deadline')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN deadline TEXT');
}
if (!maintenanceColumns.includes('escalation_level')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0');
}
if (!maintenanceColumns.includes('escalated_at')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN escalated_at TEXT');
}
if (!maintenanceColumns.includes('owner_staff_id')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN owner_staff_id TEXT');
}
if (!maintenanceColumns.includes('sort_order')) {
  db.exec('ALTER TABLE maintenance_tickets ADD COLUMN sort_order REAL');
}

db.exec(`
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
`);

const groupColumns = db.prepare("PRAGMA table_info(groups)").all().map((c) => c.name);
if (!groupColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE groups ADD COLUMN deleted_at TEXT');
}
if (!groupColumns.includes('archived_at')) {
  db.exec('ALTER TABLE groups ADD COLUMN archived_at TEXT');
}
if (!groupColumns.includes('shared_at')) {
  db.exec('ALTER TABLE groups ADD COLUMN shared_at TEXT');
}
if (!groupColumns.includes('description')) {
  db.exec('ALTER TABLE groups ADD COLUMN description TEXT');
}
if (!groupColumns.includes('event_date')) {
  db.exec('ALTER TABLE groups ADD COLUMN event_date TEXT');
}
if (!groupColumns.includes('guest_count')) {
  db.exec('ALTER TABLE groups ADD COLUMN guest_count INTEGER');
}
if (!groupColumns.includes('location')) {
  db.exec('ALTER TABLE groups ADD COLUMN location TEXT');
}

db.exec(`
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
`);

const staffColumns = db.prepare("PRAGMA table_info(staff)").all().map((c) => c.name);
if (!staffColumns.includes('profile_complete')) {
  db.exec('ALTER TABLE staff ADD COLUMN profile_complete INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE staff SET profile_complete = 1');
}
if (!staffColumns.includes('status_line')) {
  db.exec('ALTER TABLE staff ADD COLUMN status_line TEXT');
}
if (!staffColumns.includes('phone')) {
  db.exec('ALTER TABLE staff ADD COLUMN phone TEXT');
}

const DEPARTMENTS = [
  { id: 'gm', name: 'General Manager', contact: 'Dave' },
  { id: 'foh', name: 'Reception', contact: null },
  { id: 'concierge', name: 'Concierge', contact: null },
  { id: 'restaurant', name: 'Restaurant', contact: null },
  { id: 'kitchen', name: 'Kitchen', contact: 'Peter' },
  { id: 'bar', name: 'Bar', contact: null },
  { id: 'housekeeping', name: 'Housekeeping', contact: null },
  { id: 'maintenance', name: 'Maintenance', contact: null },
];

const insertDept = db.prepare(
  'INSERT OR IGNORE INTO departments (id, name, contact_name, on_duty) VALUES (?, ?, ?, 1)'
);
for (const d of DEPARTMENTS) insertDept.run(d.id, d.name, d.contact);
const renameDept = db.prepare('UPDATE departments SET name = ? WHERE id = ?');
for (const d of DEPARTMENTS) renameDept.run(d.name, d.id);

const crypto = require('node:crypto');
const staffCount = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
if (staffCount === 0) {
  const salt = crypto.randomBytes(16).toString('hex');
  const pin = String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000));
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  db.prepare(`
    INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, profile_complete, created_at)
    VALUES (?, 'Dave', 'gm', ?, ?, 1, 1, ?)
  `).run(crypto.randomUUID(), hash, salt, new Date().toISOString());
  console.log("First-run admin account seeded: name 'Dave', PIN " + pin);
}

module.exports = { db, DEPARTMENTS };
