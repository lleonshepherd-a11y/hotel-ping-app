const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DEPARTMENTS } = require('./db');

const PORT = process.env.PORT || 4100;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DEPT_IDS = new Set(DEPARTMENTS.map((d) => d.id));
const DEPT_NAMES = {};
DEPARTMENTS.forEach((d) => { DEPT_NAMES[d.id] = d.name; });
DEPT_NAMES.dashboard = 'Dashboard';
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || 'dev-local-key';
const TASK_STATUSES = ['not_started', 'in_progress', 'completed'];
const MAINT_STATUSES = ['reported', 'in_progress', 'fixed'];
const MAINT_PRIORITIES = ['safety', 'guest', 'problem', 'routine'];
const MAINT_PRIORITY_RANK = { safety: 0, guest: 1, problem: 2, routine: 3 };
const DEADLINE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GUEST_REQUEST_STATUSES = ['new', 'in_progress', 'completed'];
const loginAttempts = new Map();

function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, headers || {}));
  res.end(typeof body === 'string' && !headers ? payload : payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 30 * 1024 * 1024; // 30MB cap, generous for a voice note or photo
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function rowToHandoverNote(row) {
  return { id: row.id, departmentId: row.department_id, staffId: row.staff_id, staffName: row.staff_name, body: row.body, createdAt: row.created_at };
}
function rowToDepartment(row) {
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty };
}
function rowToTicket(row) {
  return {
    id: row.id,
    roomNumber: row.room_number || undefined,
    description: row.description,
    photoUrl: row.photo_path ? '/uploads/' + row.photo_path : undefined,
    status: row.status,
    priority: row.priority || 'problem',
    guestPresent: !!row.guest_present,
    deadline: row.deadline || undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || undefined,
    pinned: !!row.pinned_at,
  };
}
function rowToTicketReply(row) {
  return { id: row.id, ticketId: row.ticket_id, from: row.from_dept, text: row.body, createdAt: row.created_at };
}
function rowToGuestRequest(row) {
  return {
    id: row.id,
    roomNumber: row.room_number,
    text: row.request_text,
    status: row.status,
    replyText: row.reply_text || undefined,
    pinned: !!row.pinned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}

function rowToMessage(row, viewerDeptId, isAdmin) {
  const deleted = !!row.deleted_at;
  if (deleted && !isAdmin && viewerDeptId !== row.from_dept) {
    return null;
  }
  const reveal = deleted && isAdmin;
  const hide = deleted && !reveal;
  return {
    id: row.id,
    from: row.from_dept,
    to: row.to_dept,
    type: row.type,
    body: hide ? null : row.body,
    fileName: hide ? null : row.file_name,
    fileUrl: hide || !row.file_path ? null : '/uploads/' + row.file_path,
    fileSize: hide ? null : row.file_size,
    duration: hide ? null : row.duration,
    transcript: hide ? null : row.transcript,
    urgent: !!row.urgent,
    status: row.status,
    createdAt: row.created_at,
    deleted: deleted,
    deletedAt: reveal ? row.deleted_at : undefined,
    replyTo: row.reply_to_id || undefined,
    pinned: !!row.pinned_at,
    completed: !!row.completed_at,
    completedAt: row.completed_at || undefined,
    completedBy: row.completed_by || undefined,
    broadcastId: row.broadcast_id || undefined,
    roomNumber: row.room_number || undefined,
    taskStatus: row.task_status || undefined,
    groupId: row.group_id || undefined,
    editedAt: row.edited_at || undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
  };
}
function rowToGroup(row, members) {
  return { id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at, members: members || [] };
}

const URGENT_ESCALATION_MINUTES = 10;
const NORMAL_ESCALATION_MINUTES = 25;
function checkEscalations() {
  const urgentCutoff = new Date(Date.now() - URGENT_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const normalCutoff = new Date(Date.now() - NORMAL_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE deleted_at IS NULL AND escalated_at IS NULL AND status != 'read'
      AND ((urgent = 1 AND created_at < ?) OR (urgent = 0 AND created_at < ?))
      AND (to_dept IS NULL OR (SELECT on_duty FROM departments WHERE id = to_dept) = 1)
  `).all(urgentCutoff, normalCutoff);
  const now = new Date().toISOString();
  for (const row of rows) {
    console.log('[escalation] unread message', row.id, row.urgent ? '(urgent)' : '(normal)', row.from_dept, '->', row.to_dept);
    db.prepare('UPDATE messages SET escalated_at = ? WHERE id = ?').run(now, row.id);
  }
  return rows.length;
}

function insertMessage(opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = opts.mentions && opts.mentions.length ? JSON.stringify(opts.mentions) : null;
  db.prepare(`
    INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id, broadcast_id, room_number, task_status, group_id, mentions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.from, opts.to || null, opts.type,
    opts.body || null, opts.fileName || null, opts.filePath || null, opts.fileSize || null,
    opts.duration || null, opts.transcript || null, opts.urgent ? 1 : 0, now, opts.replyToId || null, opts.broadcastId || null, opts.roomNumber || null, opts.taskStatus || null, opts.groupId || null, mentionsJson
  );
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (opts.groupId) {
    const members = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(opts.groupId);
    const mentioned = new Set(opts.mentions || []);
    for (const m of members) {
      if (m.department_id !== opts.from) console.log('[group notify]', m.department_id, mentioned.has(m.department_id) ? 'MENTIONED in group' : 'new message in group', opts.groupId);
    }
  }
  return row;
}

function getDepartments() {
  const rows = db.prepare('SELECT * FROM departments ORDER BY name').all();
  return rows.map(rowToDepartment);
}

function getConversations(self, isAdmin) {
  const others = DEPARTMENTS.filter((d) => d.id !== self);
  const lastMsgStmt = db.prepare(`
    SELECT * FROM messages
    WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?)
    ORDER BY created_at DESC LIMIT 1
  `);
  const unreadStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE to_dept = ? AND from_dept = ? AND status != 'read'
  `);
  const urgentUnreadStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE to_dept = ? AND from_dept = ? AND status != 'read' AND urgent = 1
  `);
  return others.map((d) => {
    const last = lastMsgStmt.get(self, d.id, d.id, self);
    const unread = unreadStmt.get(self, d.id).n;
    const urgentUnread = urgentUnreadStmt.get(self, d.id).n;
    return {
      departmentId: d.id,
      lastMessage: last ? rowToMessage(last, self, isAdmin) : null,
      unreadCount: unread,
      hasUrgentUnread: urgentUnread > 0,
    };
  });
}

function markThreadRead(self, other) {
  db.prepare(`UPDATE messages SET status = 'read', read_at = ? WHERE to_dept = ? AND from_dept = ? AND status != 'read'`).run(new Date().toISOString(), self, other);
}

function rowToStaff(row) {
  return { id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at, profileComplete: !!row.profile_complete };
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function staffFromToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(session.staff_id);
  return staff || null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ---- Static frontend ----
    if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/uploads/')) {
      let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
      if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
      if ((!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) && fs.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');
      const ext = path.extname(filePath);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const filePath = path.join(UPLOADS_DIR, path.basename(p));
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // ---- External integration (own API-key auth, not a staff session) ----
    if (req.method === 'POST' && p === '/api/external/notify') {
      const apiKey = req.headers['x-api-key'] || '';
      if (apiKey !== EXTERNAL_API_KEY) return send(res, 401, { error: 'Unauthorized' });
      const body = await readJsonBody(req);
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      const departmentId = body.departmentId;
      const message = String(body.message || '').trim();
      if (!idempotencyKey) return send(res, 400, { error: 'idempotencyKey is required' });
      if (!DEPT_IDS.has(departmentId)) return send(res, 400, { error: 'Unknown department' });
      if (!message) return send(res, 400, { error: 'message is required' });

      const existing = db.prepare('SELECT message_id FROM external_notifications WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return send(res, 200, { ok: true, duplicate: true, messageId: existing.message_id });

      const row = insertMessage({ from: 'dashboard', to: departmentId, type: 'text', body: message });
      db.prepare('INSERT INTO external_notifications (idempotency_key, message_id, created_at) VALUES (?, ?, ?)')
        .run(idempotencyKey, row.id, new Date().toISOString());
      return send(res, 201, { ok: true, duplicate: false, messageId: row.id });
    }

    // ---- Guest concierge requests (public, no staff session — reached via a room QR code) ----
    if (req.method === 'POST' && p === '/api/guest-requests') {
      const body = await readJsonBody(req);
      const roomNumber = String(body.roomNumber || '').trim();
      const text = String(body.text || '').trim();
      if (!roomNumber) return send(res, 400, { error: 'Room number is required' });
      if (roomNumber.length > 20) return send(res, 400, { error: 'Room number is too long' });
      if (!text) return send(res, 400, { error: 'Please describe what you need' });
      if (text.length > 500) return send(res, 400, { error: 'Message is too long' });

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO guest_requests (id, room_number, request_text, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)"
      ).run(id, roomNumber, text, now, now);
      const row = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      console.log('[guest request notify] concierge department: Room ' + roomNumber + ': ' + text);
      return send(res, 201, { request: rowToGuestRequest(row) });
    }

    if (req.method === 'GET' && p.startsWith('/api/guest-requests/') && !p.endsWith('/status') && !p.endsWith('/pin')) {
      const id = decodeURIComponent(p.slice('/api/guest-requests/'.length));
      const row = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      if (!row) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { request: rowToGuestRequest(row) });
    }

    // ---- Auth gate: every /api/ route except login needs a valid session ----
    if (p.startsWith('/api/') && p !== '/api/auth/login') {
      const authed = staffFromToken(req);
      if (!authed) return send(res, 401, { error: 'Not signed in' });
    }

    // ---- Auth ----
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const pin = String(body.pin || '');
      if (!name || !pin) return send(res, 400, { error: 'Name and PIN are required' });

      const attemptKey = (req.socket.remoteAddress || 'unknown') + '|' + name.toLowerCase();
      const attempt = loginAttempts.get(attemptKey);
      if (attempt && attempt.count >= 5 && Date.now() - attempt.first < 5 * 60 * 1000) {
        return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      }

      const staff = db.prepare('SELECT * FROM staff WHERE LOWER(name) = LOWER(?)').get(name);
      const ok = staff && hashPin(pin, staff.pin_salt) === staff.pin_hash;
      if (!ok) {
        const next = attempt ? { count: attempt.count + 1, first: attempt.first } : { count: 1, first: Date.now() };
        loginAttempts.set(attemptKey, next);
        return send(res, 401, { error: 'Incorrect name or PIN' });
      }
      loginAttempts.delete(attemptKey);

      const token = crypto.randomUUID() + crypto.randomUUID();
      db.prepare('INSERT INTO sessions (token, staff_id, created_at) VALUES (?, ?, ?)').run(token, staff.id, new Date().toISOString());
      return send(res, 200, { token: token, staff: rowToStaff(staff) });
    }

    if (req.method === 'POST' && p === '/api/auth/logout') {
      const staff = staffFromToken(req);
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/auth/me') {
      const staff = staffFromToken(req);
      if (!staff) return send(res, 401, { error: 'Not signed in' });
      return send(res, 200, { staff: rowToStaff(staff) });
    }

    // ---- Staff directory: any signed-in user can read names/departments ----
    if (req.method === 'GET' && p === '/api/staff') {
      const rows = db.prepare('SELECT * FROM staff ORDER BY name').all();
      return send(res, 200, { staff: rows.map(rowToStaff) });
    }

    // ---- Self-service profile setup: any signed-in user can edit their own name/PIN ----
    if (req.method === 'PATCH' && p === '/api/profile') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const body = await readJsonBody(req);
      if (typeof body.name === 'string' && body.name.trim()) {
        db.prepare('UPDATE staff SET name = ? WHERE id = ?').run(body.name.trim(), requester.id);
      }
      if (typeof body.pin === 'string' && body.pin) {
        if (!/^\d{4,6}$/.test(body.pin)) return send(res, 400, { error: 'PIN must be 4-6 digits' });
        const currentPin = typeof body.currentPin === 'string' ? body.currentPin : '';
        const existing = db.prepare('SELECT pin_hash, pin_salt FROM staff WHERE id = ?').get(requester.id);
        if (!existing || hashPin(currentPin, existing.pin_salt) !== existing.pin_hash) {
          return send(res, 400, { error: 'Current PIN is incorrect' });
        }
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(body.pin, salt), salt, requester.id);
      }
      db.prepare('UPDATE staff SET profile_complete = 1 WHERE id = ?').run(requester.id);
      const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(requester.id);
      return send(res, 200, { staff: rowToStaff(row) });
    }

    // ---- Staff management (admin only beyond this point) ----
    if (p === '/api/staff' || p.startsWith('/api/staff/')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });

      if (req.method === 'POST' && p === '/api/staff') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        const pin = String(body.pin || '');
        const departmentId = body.departmentId;
        if (!name || !/^\d{4,6}$/.test(pin)) return send(res, 400, { error: 'Name and a 4-6 digit PIN are required' });
        if (!DEPT_IDS.has(departmentId)) return send(res, 400, { error: 'Unknown department' });
        const salt = crypto.randomBytes(16).toString('hex');
        const id = crypto.randomUUID();
        db.prepare(`
          INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, departmentId, hashPin(pin, salt), salt, body.isAdmin ? 1 : 0, new Date().toISOString());
        return send(res, 201, { staff: rowToStaff(db.prepare('SELECT * FROM staff WHERE id = ?').get(id)) });
      }

      if (req.method === 'PATCH' && p.startsWith('/api/staff/')) {
        const id = decodeURIComponent(p.slice('/api/staff/'.length));
        const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
        if (!existing) return send(res, 404, { error: 'Staff not found' });
        const body = await readJsonBody(req);
        if (typeof body.name === 'string' && body.name.trim()) {
          db.prepare('UPDATE staff SET name = ? WHERE id = ?').run(body.name.trim(), id);
        }
        if (body.departmentId) {
          if (!DEPT_IDS.has(body.departmentId)) return send(res, 400, { error: 'Unknown department' });
          db.prepare('UPDATE staff SET department_id = ? WHERE id = ?').run(body.departmentId, id);
        }
        if (typeof body.isAdmin === 'boolean') {
          db.prepare('UPDATE staff SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, id);
        }
        if (typeof body.pin === 'string' && body.pin) {
          if (!/^\d{4,6}$/.test(body.pin)) return send(res, 400, { error: 'PIN must be 4-6 digits' });
          const salt = crypto.randomBytes(16).toString('hex');
          db.prepare('UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(body.pin, salt), salt, id);
        }
        return send(res, 200, { staff: rowToStaff(db.prepare('SELECT * FROM staff WHERE id = ?').get(id)) });
      }

      if (req.method === 'DELETE' && p.startsWith('/api/staff/')) {
        const id = decodeURIComponent(p.slice('/api/staff/'.length));
        if (id === requester.id) return send(res, 400, { error: "You can't delete your own account" });
        db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(id);
        db.prepare('DELETE FROM staff WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
    }

    // ---- API ----
    if (req.method === 'GET' && p === '/api/departments') {
      return send(res, 200, { departments: getDepartments() });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/departments/')) {
      const id = decodeURIComponent(p.slice('/api/departments/'.length));
      if (!DEPT_IDS.has(id)) return send(res, 404, { error: 'Unknown department' });
      const body = await readJsonBody(req);
      if (typeof body.onDuty === 'boolean') {
        db.prepare('UPDATE departments SET on_duty = ? WHERE id = ?').run(body.onDuty ? 1 : 0, id);
      }
      if (typeof body.contactName === 'string') {
        db.prepare('UPDATE departments SET contact_name = ? WHERE id = ?').run(body.contactName.trim() || null, id);
      }
      const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
      return send(res, 200, { department: rowToDepartment(row) });
    }

    if (req.method === 'GET' && p === '/api/conversations') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      return send(res, 200, { conversations: getConversations(self, requester.is_admin) });
    }

    if (req.method === 'GET' && p === '/api/messages') {
      const self = url.searchParams.get('self');
      const other = url.searchParams.get('with');
      if (!DEPT_IDS.has(self) || !DEPT_IDS.has(other)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      const rows = db.prepare(`
        SELECT * FROM messages
        WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?)
        ORDER BY created_at ASC
      `).all(self, other, other, self);
      return send(res, 200, { messages: rows.map((r) => rowToMessage(r, self, requester.is_admin)).filter(Boolean) });
    }

    if (req.method === 'GET' && p === '/api/groups') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      const groupRows = db.prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
      const groups = groupRows.map((g) => {
        const members = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(g.id).map((m) => m.department_id);
        const isMember = members.includes(self);
        const last = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(g.id);
        const readRow = db.prepare('SELECT last_read_at FROM group_reads WHERE group_id = ? AND department_id = ?').get(g.id, self);
        const since = readRow ? readRow.last_read_at : '1970-01-01T00:00:00.000Z';
        const unread = db.prepare(
          'SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND from_dept != ? AND created_at > ? AND deleted_at IS NULL'
        ).get(g.id, self, since);
        return {
          id: g.id, name: g.name, createdBy: g.created_by, createdAt: g.created_at,
          members, isMember,
          lastMessage: last ? rowToMessage(last, self, requester.is_admin) : null,
          unreadCount: isMember ? unread.n : 0,
        };
      });
      return send(res, 200, { groups });
    }

    if (req.method === 'POST' && p === '/api/groups') {
      const body = await readJsonBody(req);
      const self = body.self;
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Group name is required' });
      const memberIds = Array.isArray(body.memberDepartmentIds) ? body.memberDepartmentIds.filter((d) => DEPT_IDS.has(d)) : [];
      const allMembers = Array.from(new Set([self, ...memberIds]));
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, name, self, now);
      for (const deptId of allMembers) {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)').run(id, deptId, now);
      }
      const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      return send(res, 201, { group: rowToGroup(row, allMembers) });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/join')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/join'.length));
      const body = await readJsonBody(req);
      const self = body.self;
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Group not found' });
      const existingMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(id, self);
      db.prepare('INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)').run(id, self, new Date().toISOString());
      if (!existingMember) {
        const requester = staffFromToken(req);
        const actorId = requester ? requester.department_id : self;
        const joinerName = DEPT_NAMES[self] || self;
        const actorName = DEPT_NAMES[actorId] || actorId;
        const noticeBody = actorId === self ? (joinerName + ' joined the event') : (actorName + ' added ' + joinerName + ' to the event');
        insertMessage({ from: actorId, groupId: id, type: 'text', body: noticeBody });
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/leave')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/leave'.length));
      const body = await readJsonBody(req);
      const self = body.self;
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND department_id = ?').run(id, self);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/groups/')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length));
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      const requester = staffFromToken(req);
      if (group.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that created this event can delete it' });
      }
      const memberCount = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(id);
      if (memberCount.n > 1 && !requester.is_admin) {
        return send(res, 400, { error: "Other departments have joined this event and it can't be deleted" });
      }
      db.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p.startsWith('/api/groups/') && p.endsWith('/messages')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/messages'.length));
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(id, self);
      if (!member && !requester.is_admin) return send(res, 403, { error: 'Not a member of this group' });
      const rows = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC').all(id);
      return send(res, 200, { messages: rows.map((r) => rowToMessage(r, self, requester.is_admin)).filter(Boolean) });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/read')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/read'.length));
      const body = await readJsonBody(req);
      const self = body.self;
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO group_reads (group_id, department_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(group_id, department_id) DO UPDATE SET last_read_at = excluded.last_read_at'
      ).run(id, self, now);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/feed') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 200);
      const rows = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?').all(limit);
      return send(res, 200, { messages: rows.map((r) => rowToMessage(r, r.from_dept, true)).filter(Boolean) });
    }

    if (req.method === 'GET' && p === '/api/response-times') {
      const requester = staffFromToken(req);
      const mine = url.searchParams.get('mine') === '1';
      if (!mine && !requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = mine
        ? db.prepare(
            `SELECT to_dept, created_at, read_at FROM messages
             WHERE urgent = 1 AND read_at IS NOT NULL AND deleted_at IS NULL AND created_at > ? AND to_dept = ?`
          ).all(cutoff, requester.department_id)
        : db.prepare(
            `SELECT to_dept, created_at, read_at FROM messages
             WHERE urgent = 1 AND read_at IS NOT NULL AND deleted_at IS NULL AND created_at > ?`
          ).all(cutoff);
      const byDept = {};
      for (const r of rows) {
        const seconds = (new Date(r.read_at).getTime() - new Date(r.created_at).getTime()) / 1000;
        if (!byDept[r.to_dept]) byDept[r.to_dept] = { total: 0, count: 0 };
        byDept[r.to_dept].total += seconds;
        byDept[r.to_dept].count += 1;
      }
      const departments = Object.keys(byDept).map((deptId) => ({
        deptId, avgSeconds: byDept[deptId].total / byDept[deptId].count, count: byDept[deptId].count,
      }));
      return send(res, 200, { departments });
    }

    if (req.method === 'GET' && p === '/api/missed') {
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      const items = [];

      const msgRows = db.prepare(
        "SELECT * FROM messages WHERE to_dept = ? AND status != 'read' AND deleted_at IS NULL ORDER BY created_at ASC"
      ).all(dept);
      for (const m of msgRows) {
        items.push({ kind: 'message', id: m.id, createdAt: m.created_at, message: rowToMessage(m, dept, false) });
      }

      if (dept === 'maintenance') {
        const ticketRows = db.prepare(
          "SELECT * FROM maintenance_tickets WHERE status != 'fixed' ORDER BY created_at ASC"
        ).all();
        for (const t of ticketRows) {
          items.push({ kind: 'ticket', id: t.id, createdAt: t.created_at, ticket: rowToTicket(t) });
        }
      }

      if (dept === 'concierge') {
        const reqRows = db.prepare(
          "SELECT * FROM guest_requests WHERE status = 'new' ORDER BY created_at ASC"
        ).all();
        for (const r of reqRows) {
          items.push({ kind: 'guestRequest', id: r.id, createdAt: r.created_at, request: rowToGuestRequest(r) });
        }
      }

      items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      return send(res, 200, { items });
    }

    if (req.method === 'POST' && p === '/api/messages/read') {
      const body = await readJsonBody(req);
      if (!DEPT_IDS.has(body.self) || !DEPT_IDS.has(body.with)) return send(res, 400, { error: 'Unknown department' });
      markThreadRead(body.self, body.with);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/messages') {
      const body = await readJsonBody(req);
      const { from, to, groupId, type, text, urgent, fileName, fileBase64, fileMime, duration, transcript, replyToId, roomNumber, taskStatus, mentions } = body;
      if (!DEPT_IDS.has(from)) return send(res, 400, { error: 'Unknown department' });
      let validMembers = null;
      if (groupId) {
        const memberRows = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(groupId);
        validMembers = new Set(memberRows.map((m) => m.department_id));
        if (!validMembers.has(from)) return send(res, 403, { error: 'Not a member of this group' });
      } else if (!DEPT_IDS.has(to)) {
        return send(res, 400, { error: 'Unknown department' });
      }
      if (!['text', 'image', 'file', 'audio'].includes(type)) return send(res, 400, { error: 'Invalid message type' });
      if (type === 'text' && !text?.trim()) return send(res, 400, { error: 'Message text is required' });
      if (roomNumber && String(roomNumber).length > 20) return send(res, 400, { error: 'Room number is too long' });
      if (taskStatus && !TASK_STATUSES.includes(taskStatus)) return send(res, 400, { error: 'Invalid task status' });
      const validMentions = Array.isArray(mentions) && validMembers
        ? mentions.filter((d) => validMembers.has(d) && d !== from)
        : [];

      let filePathOnDisk = null;
      let fileSize = null;
      if (fileBase64) {
        const buf = Buffer.from(fileBase64, 'base64');
        if (buf.length > 25 * 1024 * 1024) return send(res, 400, { error: 'File is too large (25MB max)' });
        const ext = (fileMime && fileMime.split('/')[1]) ? '.' + fileMime.split('/')[1].split(';')[0] : '';
        const safeName = crypto.randomUUID() + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
        filePathOnDisk = safeName;
        fileSize = buf.length;
      }

      const row = insertMessage({
        from, to: groupId ? null : to, groupId: groupId || null, type,
        body: text?.trim() || null,
        fileName: fileName || null, filePath: filePathOnDisk, fileSize,
        duration: duration || null, transcript: transcript?.trim() || null,
        urgent: !!urgent,
        replyToId: replyToId || null,
        roomNumber: roomNumber ? String(roomNumber).trim() : null,
        taskStatus: taskStatus || null,
        mentions: validMentions,
      });
      return send(res, 201, { message: rowToMessage(row, from, false) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/messages/')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      if (existing.from_dept !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: "You can only delete your own department's messages" });
      }
      db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return send(res, 200, { message: rowToMessage(row, existing.from_dept, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/edit')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/edit'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      if (existing.from_dept !== requester.department_id) {
        return send(res, 403, { error: 'You can only edit your own messages' });
      }
      if (existing.deleted_at) return send(res, 400, { error: "Can't edit a deleted message" });
      if (existing.type !== 'text') return send(res, 400, { error: 'Only text messages can be edited' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'Message text is required' });
      db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(text, new Date().toISOString(), id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/pin')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/pin'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
        || (existing.group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(existing.group_id, requester.department_id));
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const nextPinned = !existing.pinned_at;
      db.prepare('UPDATE messages SET pinned_at = ? WHERE id = ?').run(nextPinned ? new Date().toISOString() : null, id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/complete')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/complete'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
        || (existing.group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(existing.group_id, requester.department_id));
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const nextCompleted = !existing.completed_at;
      db.prepare('UPDATE messages SET completed_at = ?, completed_by = ? WHERE id = ?').run(
        nextCompleted ? new Date().toISOString() : null, nextCompleted ? requester.department_id : null, id
      );
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/task-status')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/task-status'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      if (!existing.task_status) return send(res, 400, { error: "This message isn't tagged as a task" });
      const requester = staffFromToken(req);
      if (existing.to_dept !== requester.department_id) return send(res, 403, { error: 'Only the department this task was sent to can update it' });
      const bodyIn = await readJsonBody(req);
      if (!TASK_STATUSES.includes(bodyIn.status)) return send(res, 400, { error: 'Invalid task status' });
      db.prepare('UPDATE messages SET task_status = ? WHERE id = ?').run(bodyIn.status, id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (bodyIn.status === 'in_progress' || bodyIn.status === 'completed') {
        const verb = bodyIn.status === 'in_progress' ? 'Accepted' : 'Completed';
        const taskPreview = existing.body ? ': "' + existing.body + '"' : '';
        insertMessage({
          from: existing.to_dept, to: existing.from_dept, type: 'text',
          body: verb + ' task' + taskPreview,
        });
      }
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/forward')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/forward'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      if (existing.deleted_at) return send(res, 400, { error: "Can't forward a deleted message" });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
        || (existing.group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(existing.group_id, requester.department_id));
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const body = await readJsonBody(req);
      const to = body.to;
      if (!DEPT_IDS.has(to)) return send(res, 400, { error: 'Unknown department' });
      const row = insertMessage({
        from: requester.department_id, to, type: existing.type,
        body: existing.body, fileName: existing.file_name, filePath: existing.file_path, fileSize: existing.file_size,
        duration: existing.duration, transcript: existing.transcript, urgent: false,
      });
      return send(res, 201, { message: rowToMessage(row, requester.department_id, false) });
    }

    if (req.method === 'POST' && p === '/api/broadcast') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'Message text is required' });
      const from = requester.department_id;
      const targets = [...DEPT_IDS].filter((id) => id !== from);
      const broadcastId = crypto.randomUUID();
      const rows = targets.map((to) => insertMessage({ from, to, type: 'text', body: text, urgent: !!body.urgent, broadcastId }));
      return send(res, 201, { messages: rows.map((r) => rowToMessage(r, from, false)) });
    }

    if (req.method === 'GET' && p.startsWith('/api/broadcast/') && p.endsWith('/status')) {
      const broadcastId = decodeURIComponent(p.slice('/api/broadcast/'.length, -'/status'.length));
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const rows = db.prepare('SELECT to_dept, status FROM messages WHERE broadcast_id = ?').all(broadcastId);
      const total = rows.length;
      const read = rows.filter((r) => r.status === 'read').map((r) => r.to_dept);
      const unread = rows.filter((r) => r.status !== 'read').map((r) => r.to_dept);
      return send(res, 200, { total, readCount: read.length, read, unread });
    }

    if (req.method === 'POST' && p === '/api/typing') {
      const body = await readJsonBody(req);
      const requester = staffFromToken(req);
      const self = requester.department_id;
      if (!DEPT_IDS.has(body.to)) return send(res, 400, { error: 'Unknown department' });
      db.prepare(`
        INSERT INTO typing_status (from_dept, to_dept, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(from_dept, to_dept) DO UPDATE SET updated_at = excluded.updated_at
      `).run(self, body.to, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/typing') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const cutoff = new Date(Date.now() - 6000).toISOString();
      const rows = db.prepare('SELECT from_dept FROM typing_status WHERE to_dept = ? AND updated_at > ?').all(self, cutoff);
      return send(res, 200, { typing: rows.map((r) => r.from_dept) });
    }

    if (req.method === 'GET' && p === '/api/muted') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const rows = db.prepare('SELECT other_dept_id FROM muted_conversations WHERE department_id = ?').all(self);
      return send(res, 200, { muted: rows.map((r) => r.other_dept_id) });
    }

    if (req.method === 'POST' && p === '/api/muted') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      const other = body.with;
      if (!DEPT_IDS.has(other)) return send(res, 400, { error: 'Unknown department' });
      const self = requester.department_id;
      const existing = db.prepare('SELECT 1 FROM muted_conversations WHERE department_id = ? AND other_dept_id = ?').get(self, other);
      if (existing) {
        db.prepare('DELETE FROM muted_conversations WHERE department_id = ? AND other_dept_id = ?').run(self, other);
        return send(res, 200, { muted: false });
      }
      db.prepare('INSERT INTO muted_conversations (department_id, other_dept_id, muted_at) VALUES (?, ?, ?)').run(self, other, new Date().toISOString());
      return send(res, 200, { muted: true });
    }

    if (req.method === 'GET' && p === '/api/handover') {
      const dept = url.searchParams.get('department');
      if (!DEPT_IDS.has(dept)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      if (dept !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Not part of this department' });
      }
      const rows = db.prepare('SELECT * FROM handover_notes WHERE department_id = ? ORDER BY created_at DESC LIMIT 30').all(dept);
      return send(res, 200, { notes: rows.map(rowToHandoverNote) });
    }

    if (req.method === 'POST' && p === '/api/handover') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      const text = String(body.body || '').trim();
      if (!text) return send(res, 400, { error: 'Note text is required' });
      const dept = requester.department_id;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO handover_notes (id, department_id, staff_id, staff_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, dept, requester.id, requester.name, text, now);
      const row = db.prepare('SELECT * FROM handover_notes WHERE id = ?').get(id);
      return send(res, 201, { note: rowToHandoverNote(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/handover/')) {
      const id = decodeURIComponent(p.slice('/api/handover/'.length));
      const existing = db.prepare('SELECT * FROM handover_notes WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Note not found' });
      const requester = staffFromToken(req);
      if (existing.staff_id !== requester.id && !requester.is_admin) {
        return send(res, 403, { error: 'You can only remove your own notes' });
      }
      db.prepare('DELETE FROM handover_notes WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/maintenance') {
      const rows = db.prepare('SELECT * FROM maintenance_tickets ORDER BY created_at DESC').all();
      return send(res, 200, { tickets: rows.map(rowToTicket) });
    }

    if (req.method === 'POST' && p === '/api/maintenance') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      const description = String(body.description || '').trim();
      if (!description) return send(res, 400, { error: 'A description is required' });
      const roomNumber = body.roomNumber ? String(body.roomNumber).trim() : null;
      if (roomNumber && roomNumber.length > 40) return send(res, 400, { error: 'Location is too long' });
      const priority = MAINT_PRIORITIES.includes(body.priority) ? body.priority : 'problem';
      const guestPresent = !!body.guestPresent;
      let deadline = body.deadline ? String(body.deadline).trim() : null;
      if (deadline && !DEADLINE_RE.test(deadline)) deadline = null;

      if (roomNumber) {
        const dup = db.prepare(
          "SELECT * FROM maintenance_tickets WHERE status != 'fixed' AND LOWER(TRIM(room_number)) = LOWER(?) ORDER BY created_at DESC LIMIT 1"
        ).get(roomNumber);
        if (dup) {
          const replyId = crypto.randomUUID();
          const now = new Date().toISOString();
          const noteText = 'Also reported by ' + (DEPT_NAMES[requester.department_id] || requester.department_id) + ': ' + description;
          db.prepare('INSERT INTO maintenance_replies (id, ticket_id, from_dept, body, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(replyId, dup.id, requester.department_id, noteText, now);

          const mergedPriority = MAINT_PRIORITY_RANK[priority] < MAINT_PRIORITY_RANK[dup.priority] ? priority : dup.priority;
          const mergedGuestPresent = guestPresent || !!dup.guest_present;
          const mergedDeadline = deadline && (!dup.deadline || deadline < dup.deadline) ? deadline : dup.deadline;
          if (mergedPriority !== dup.priority || mergedGuestPresent !== !!dup.guest_present || mergedDeadline !== dup.deadline) {
            db.prepare('UPDATE maintenance_tickets SET priority = ?, guest_present = ?, deadline = ?, updated_at = ? WHERE id = ?')
              .run(mergedPriority, mergedGuestPresent ? 1 : 0, mergedDeadline, now, dup.id);
          }
          const mergedRow = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(dup.id);

          if (dup.created_by !== requester.department_id) {
            console.log('[maintenance notify] maintenance department: Same job reported again -', noteText);
          }
          return send(res, 200, { ticket: rowToTicket(mergedRow), merged: true });
        }
      }

      let photoPath = null;
      if (body.photoBase64) {
        const buf = Buffer.from(body.photoBase64, 'base64');
        if (buf.length > 60 * 1024 * 1024) return send(res, 400, { error: 'File is too large (60MB max)' });
        const ext = (body.photoMime && body.photoMime.split('/')[1]) ? '.' + body.photoMime.split('/')[1].split(';')[0] : '';
        const safeName = crypto.randomUUID() + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
        photoPath = safeName;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO maintenance_tickets (id, room_number, description, photo_path, status, priority, guest_present, deadline, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)"
      ).run(id, roomNumber, description, photoPath, priority, guestPresent ? 1 : 0, deadline, requester.department_id, now, now);
      const row = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      let notifyBody = (roomNumber ? 'Room ' + roomNumber + ': ' : '') + description;
      if (guestPresent) notifyBody += ' · Guest in room';
      if (deadline) notifyBody += ' · Needed by ' + deadline;
      console.log('[maintenance notify] maintenance department:', notifyBody);
      return send(res, 201, { ticket: rowToTicket(row) });
    }

    if (req.method === 'GET' && p.startsWith('/api/maintenance/') && p.endsWith('/replies')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length, -'/replies'.length));
      const rows = db.prepare('SELECT * FROM maintenance_replies WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
      return send(res, 200, { replies: rows.map(rowToTicketReply) });
    }

    if (req.method === 'POST' && p.startsWith('/api/maintenance/') && p.endsWith('/replies')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length, -'/replies'.length));
      const existing = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Ticket not found' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'Message is required' });
      const requester = staffFromToken(req);
      const replyId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO maintenance_replies (id, ticket_id, from_dept, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(replyId, id, requester.department_id, text, now);
      const row = db.prepare('SELECT * FROM maintenance_replies WHERE id = ?').get(replyId);

      const notifyTarget = requester.department_id === 'maintenance' ? existing.created_by : 'maintenance';
      if (notifyTarget !== requester.department_id) {
        console.log('[maintenance reply notify]', notifyTarget, ':', text);
      }

      return send(res, 201, { reply: rowToTicketReply(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/maintenance/') && p.endsWith('/status')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length, -'/status'.length));
      const body = await readJsonBody(req);
      const status = body.status;
      if (!MAINT_STATUSES.includes(status)) return send(res, 400, { error: 'Invalid status' });
      const existing = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Ticket not found' });
      const now = new Date().toISOString();
      db.prepare('UPDATE maintenance_tickets SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?')
        .run(status, now, status === 'fixed' ? now : null, id);
      const row = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);

      const statusNotice = { in_progress: 'Started work on: ', fixed: 'Fixed: ' };
      if (statusNotice[status] && existing.created_by !== 'maintenance') {
        insertMessage({
          from: 'maintenance', to: existing.created_by, type: 'text',
          body: statusNotice[status] + existing.description + (existing.room_number ? ' (' + existing.room_number + ')' : ''),
        });
      }

      return send(res, 200, { ticket: rowToTicket(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/maintenance/') && p.endsWith('/pin')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length, -'/pin'.length));
      const existing = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Ticket not found' });
      const nextPinned = !existing.pinned_at;
      db.prepare('UPDATE maintenance_tickets SET pinned_at = ? WHERE id = ?')
        .run(nextPinned ? new Date().toISOString() : null, id);
      const row = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      return send(res, 200, { ticket: rowToTicket(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/maintenance/')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length));
      const existing = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Ticket not found' });
      const requester = staffFromToken(req);
      if (existing.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: "You can only remove your own department's tickets" });
      }
      if (existing.status !== 'reported' && !requester.is_admin) {
        return send(res, 400, { error: "This job has already been picked up and can't be deleted" });
      }
      db.prepare('DELETE FROM maintenance_tickets WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/guest-requests') {
      const requester = staffFromToken(req);
      if (requester.department_id !== 'concierge') {
        return send(res, 403, { error: 'Concierge access required' });
      }
      const rows = db.prepare('SELECT * FROM guest_requests ORDER BY created_at DESC').all();
      return send(res, 200, { requests: rows.map(rowToGuestRequest) });
    }

    if (req.method === 'POST' && p.startsWith('/api/guest-requests/') && p.endsWith('/status')) {
      const requester = staffFromToken(req);
      if (requester.department_id !== 'concierge') {
        return send(res, 403, { error: 'Concierge access required' });
      }
      const id = decodeURIComponent(p.slice('/api/guest-requests/'.length, -'/status'.length));
      const body = await readJsonBody(req);
      const status = body.status;
      if (!GUEST_REQUEST_STATUSES.includes(status)) return send(res, 400, { error: 'Invalid status' });
      const existing = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Request not found' });
      const replyText = body.replyText !== undefined ? (String(body.replyText).trim() || null) : existing.reply_text;
      const now = new Date().toISOString();
      db.prepare('UPDATE guest_requests SET status = ?, reply_text = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(status, replyText, now, status === 'completed' ? now : null, id);
      const row = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      return send(res, 200, { request: rowToGuestRequest(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/guest-requests/') && p.endsWith('/pin')) {
      const requester = staffFromToken(req);
      if (requester.department_id !== 'concierge') {
        return send(res, 403, { error: 'Concierge access required' });
      }
      const id = decodeURIComponent(p.slice('/api/guest-requests/'.length, -'/pin'.length));
      const existing = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Request not found' });
      const now = new Date().toISOString();
      const newPinned = existing.pinned_at ? null : now;
      db.prepare('UPDATE guest_requests SET pinned_at = ? WHERE id = ?').run(newPinned, id);
      const row = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      return send(res, 200, { request: rowToGuestRequest(row) });
    }

    if (req.method === 'POST' && p === '/api/escalations/check') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const count = checkEscalations();
      return send(res, 200, { escalated: count });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log('Message Dash server listening on http://localhost:' + PORT);
});
