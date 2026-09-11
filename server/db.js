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

db.exec(`
  CREATE TABLE IF NOT EXISTS typing_status (
    from_dept TEXT NOT NULL,
    to_dept TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (from_dept, to_dept)
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
`);

const staffColumns = db.prepare("PRAGMA table_info(staff)").all().map((c) => c.name);
if (!staffColumns.includes('profile_complete')) {
  db.exec('ALTER TABLE staff ADD COLUMN profile_complete INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE staff SET profile_complete = 1');
}

const DEPARTMENTS = [
  { id: 'gm', name: 'General Manager', contact: 'Dave' },
  { id: 'foh', name: 'Front of House', contact: null },
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
