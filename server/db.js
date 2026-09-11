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
    INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, created_at)
    VALUES (?, 'Dave', 'gm', ?, ?, 1, ?)
  `).run(crypto.randomUUID(), hash, salt, new Date().toISOString());
}

module.exports = { db, DEPARTMENTS };
