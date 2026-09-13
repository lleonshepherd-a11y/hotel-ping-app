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
if (!messageColumns.includes('poll_question')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_question TEXT');
}
if (!messageColumns.includes('poll_options')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_options TEXT');
}
if (!messageColumns.includes('poll_votes')) {
  db.exec('ALTER TABLE messages ADD COLUMN poll_votes TEXT');
}

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
      poll_question TEXT,
      poll_options TEXT,
      poll_votes TEXT
    );
    INSERT INTO messages_new SELECT id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, deleted_at, reply_to_id, pinned_at, completed_at, completed_by, escalated_at, broadcast_id, room_number, read_at, task_status, group_id, edited_at, mentions, signoff_title, signoff_amount, signoff_target, signoff_category, signoff_guest_info, signoff_status, signoff_decided_by, signoff_decided_at, poll_question, poll_options, poll_votes FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_dept, to_dept, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
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
`);

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
  { id: 'foh', name: 'Head Receptionist', contact: null },
  { id: 'concierge', name: 'Head Concierge', contact: null },
  { id: 'restaurant', name: 'Restaurant Manager', contact: null },
  { id: 'kitchen', name: 'Head Chef', contact: 'Peter' },
  { id: 'bar', name: 'Bar Manager', contact: null },
  { id: 'housekeeping', name: 'Head Housekeeper', contact: null },
  { id: 'maintenance', name: 'Maintenance Manager', contact: null },
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
  const hash = crypto.scryptSync('1234', salt, 64).toString('hex');
  db.prepare(`
    INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, profile_complete, created_at)
    VALUES (?, 'Dave', 'gm', ?, ?, 1, 1, ?)
  `).run(crypto.randomUUID(), hash, salt, new Date().toISOString());
}

module.exports = { db, DEPARTMENTS };
