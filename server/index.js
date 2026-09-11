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

function rowToDepartment(row) {
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty };
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
  };
}

function insertMessage(opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?)
  `).run(
    id, opts.from, opts.to, opts.type,
    opts.body || null, opts.fileName || null, opts.filePath || null, opts.fileSize || null,
    opts.duration || null, opts.transcript || null, opts.urgent ? 1 : 0, now, opts.replyToId || null
  );
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
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
  db.prepare(`UPDATE messages SET status = 'read' WHERE to_dept = ? AND from_dept = ? AND status != 'read'`).run(self, other);
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

    if (req.method === 'POST' && p === '/api/messages/read') {
      const body = await readJsonBody(req);
      if (!DEPT_IDS.has(body.self) || !DEPT_IDS.has(body.with)) return send(res, 400, { error: 'Unknown department' });
      markThreadRead(body.self, body.with);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/messages') {
      const body = await readJsonBody(req);
      const { from, to, type, text, urgent, fileName, fileBase64, fileMime, duration, transcript, replyToId } = body;
      if (!DEPT_IDS.has(from) || !DEPT_IDS.has(to)) return send(res, 400, { error: 'Unknown department' });
      if (!['text', 'image', 'file', 'audio'].includes(type)) return send(res, 400, { error: 'Invalid message type' });
      if (type === 'text' && !text?.trim()) return send(res, 400, { error: 'Message text is required' });

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
        from, to, type,
        body: text?.trim() || null,
        fileName: fileName || null, filePath: filePathOnDisk, fileSize,
        duration: duration || null, transcript: transcript?.trim() || null,
        urgent: !!urgent,
        replyToId: replyToId || null,
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

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/pin')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/pin'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id;
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const nextPinned = !existing.pinned_at;
      db.prepare('UPDATE messages SET pinned_at = ? WHERE id = ?').run(nextPinned ? new Date().toISOString() : null, id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/forward')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/forward'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      if (existing.deleted_at) return send(res, 400, { error: "Can't forward a deleted message" });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id;
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
      const rows = targets.map((to) => insertMessage({ from, to, type: 'text', body: text, urgent: !!body.urgent }));
      return send(res, 201, { messages: rows.map((r) => rowToMessage(r, from, false)) });
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

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log('Message Dash server listening on http://localhost:' + PORT);
});
