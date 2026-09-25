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
// Head-of-department contacts: one specific, named, photographed person per
// department (assigned in Hotel Setup - see department_heads), separate
// from the department's own shared line. GM has no paired head - it's
// already a single accountable person, not a shared queue.
const HEAD_DEPT_IDS = new Set(DEPARTMENTS.filter((d) => d.id !== 'gm').map((d) => 'head_' + d.id));
const ALL_DEPT_IDS = new Set([...DEPT_IDS, ...HEAD_DEPT_IDS]);
const DEPT_NAMES = {};
DEPARTMENTS.forEach((d) => { DEPT_NAMES[d.id] = d.name; });
DEPT_NAMES.dashboard = 'Head Office';
const HEAD_DEPT_NAMES = {
  head_foh: 'Head Receptionist', head_concierge: 'Head Concierge', head_restaurant: 'Restaurant Manager',
  head_kitchen: 'Head Chef', head_bar: 'Bar Manager', head_housekeeping: 'Head Housekeeper', head_maintenance: 'Maintenance Manager',
};
Object.assign(DEPT_NAMES, HEAD_DEPT_NAMES);
const DEFAULT_QUICK_REPLIES = ['On it', 'Done', '5 mins', 'On my way', 'Noted', 'Course away', 'Hold 10 mins', 'Ready for dessert'];
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || 'dev-local-key';
const MESSAGE_PAGE_SIZE = 200;
// Pre-launch: nobody is paying to use this yet, so PIN checking is off and
// signing in only needs a real staff member's name - flip this back to
// true (and unhide the PIN field in index.html) before real staff/guests
// start using it.
const LOGIN_REQUIRE_PIN = false;
const HELP_ALERT_RESPONDER_DEPTS = ['gm'];
const HELP_ALERT_WINDOW_MINUTES = 30;
const MAX_DEVICE_MATCH_METERS = 60;
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function resolveLocation(requester, deviceCoords) {
  try {
    if (deviceCoords && typeof deviceCoords.lat === 'number' && typeof deviceCoords.lng === 'number') {
      const rows = db.prepare(
        `SELECT z.id, z.name AS zone_name, z.parent_zone_id, z.lat, z.lng, f.name AS floor_name
         FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.lat IS NOT NULL AND z.lng IS NOT NULL`
      ).all();
      let best = null, bestDist = Infinity;
      for (const z of rows) {
        const dist = haversineMeters(deviceCoords.lat, deviceCoords.lng, z.lat, z.lng);
        if (dist < bestDist) { bestDist = dist; best = z; }
      }
      if (best && bestDist <= MAX_DEVICE_MATCH_METERS) {
        let zoneName = best.zone_name, subzoneName = null;
        if (best.parent_zone_id) {
          const parent = db.prepare('SELECT name FROM zones WHERE id = ?').get(best.parent_zone_id);
          if (parent) { zoneName = parent.name; subzoneName = best.zone_name; }
        }
        return {
          available: true, source: 'device', floorName: best.floor_name, zoneName, subzoneName,
          accuracyMeters: typeof deviceCoords.accuracy === 'number' ? deviceCoords.accuracy : null,
        };
      }
    }
    const row = db.prepare(
      `SELECT z.id AS zone_id, z.name AS zone_name, z.parent_zone_id, f.name AS floor_name
       FROM department_zone_stub dzs JOIN zones z ON z.id = dzs.zone_id JOIN floors f ON f.id = z.floor_id
       WHERE dzs.department_id = ?`
    ).get(requester.department_id);
    if (!row) return { available: false };
    let zoneName = row.zone_name, subzoneName = null;
    if (row.parent_zone_id) {
      const parent = db.prepare('SELECT name FROM zones WHERE id = ?').get(row.parent_zone_id);
      if (parent) { zoneName = parent.name; subzoneName = row.zone_name; }
    }
    return { available: true, source: 'stub', floorName: row.floor_name, zoneName, subzoneName };
  } catch (e) {
    console.error('resolveLocation error:', e && e.stack || e);
    return { available: false };
  }
}
function formatLocationLabel(location) {
  if (!location || !location.available) return 'location not available';
  const parts = [location.subzoneName, location.zoneName].filter(Boolean);
  const place = parts.join(', ') || location.floorName || 'unknown zone';
  return location.floorName && location.zoneName ? location.floorName + ' - ' + place : place;
}
const TASK_STATUSES = ['not_started', 'in_progress', 'completed'];
const MAINT_STATUSES = ['reported', 'in_progress', 'fixed'];
const MAINT_PRIORITIES = ['safety', 'guest', 'problem', 'routine'];
const MAINT_PRIORITY_RANK = { safety: 0, guest: 1, problem: 2, routine: 3 };
const DEADLINE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GUEST_REQUEST_STATUSES = ['new', 'in_progress', 'completed'];
const ASSET_STATUSES = ['requested', 'borrowed', 'returned'];
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
    escalationLevel: row.escalation_level || 0,
    escalatedAt: row.escalated_at || undefined,
    ownerStaffId: row.owner_staff_id || undefined,
    sortOrder: row.sort_order == null ? undefined : row.sort_order,
  };
}
function rowToBlocker(row) {
  return {
    id: row.id,
    departmentId: row.department_id,
    waitingOn: row.waiting_on,
    reason: row.reason || undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || undefined,
  };
}
function rowToTicketReply(row) {
  return {
    id: row.id, ticketId: row.ticket_id, from: row.from_dept, text: row.body, createdAt: row.created_at,
    voiceUrl: row.voice_path ? '/uploads/' + row.voice_path : undefined,
    voiceDuration: row.voice_duration || undefined,
  };
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
function rowToAssetRequest(row) {
  return {
    id: row.id,
    itemName: row.item_name,
    notes: row.notes || undefined,
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    returnedAt: row.returned_at || undefined,
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
    roomClean: row.room_clean || undefined,
    taskStatus: row.task_status || undefined,
    groupId: row.group_id || undefined,
    editedAt: row.edited_at || undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : undefined,
    signoff: row.signoff_title ? {
      title: row.signoff_title,
      code: row.signoff_code || undefined,
      amount: row.signoff_amount != null ? row.signoff_amount : undefined,
      target: row.signoff_target || undefined,
      category: row.signoff_category || undefined,
      guestInfo: row.signoff_guest_info || undefined,
      status: row.signoff_status,
      decidedBy: row.signoff_decided_by || undefined,
      decidedAt: row.signoff_decided_at || undefined,
    } : undefined,
    poll: row.poll_question ? {
      question: row.poll_question,
      options: JSON.parse(row.poll_options || '[]'),
      votes: JSON.parse(row.poll_votes || '{}'),
    } : undefined,
    escalationLevel: row.escalation_level || 0,
    affectsGuest: !!row.affects_guest,
    staffName: hide ? null : (row.from_staff_name || undefined),
  };
}
function rowToGroup(row, members) {
  return {
    id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at, members: members || [],
    archivedAt: row.archived_at || undefined, sharedAt: row.shared_at || undefined,
    description: row.description || undefined, eventDate: row.event_date || undefined,
    guestCount: row.guest_count === null || row.guest_count === undefined ? undefined : row.guest_count,
    location: row.location || undefined,
  };
}
function rowToStation(row) {
  return {
    id: row.id, groupId: row.group_id, title: row.title, category: row.category || undefined,
    description: row.description || undefined, icon: row.icon || undefined,
    assignedDeptId: row.assigned_dept_id || undefined, confirmedAt: row.confirmed_at || undefined,
    position: row.position,
  };
}
function rowToRunsheetItem(row) {
  return {
    id: row.id, groupId: row.group_id, timeLabel: row.time_label, title: row.title,
    description: row.description || undefined, teamLabel: row.team_label || undefined, position: row.position,
  };
}
function rowToStory(row, viewed) {
  return {
    id: row.id,
    departmentId: row.department_id,
    staffName: row.staff_name || undefined,
    photoUrl: '/uploads/' + row.photo_path,
    caption: row.caption || undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewed: !!viewed,
  };
}

const URGENT_ESCALATION_MINUTES = 10;
const NORMAL_ESCALATION_MINUTES = 25;
const URGENT_ESCALATION_L2_MINUTES = 20;
const NORMAL_ESCALATION_L2_MINUTES = 50;
const TICKET_AT_RISK_MINUTES = 15;
const TICKET_BREACH_MINUTES = 35;
function checkEscalations() {
  const now = Date.now();
  const urgentCutoffL1 = new Date(now - URGENT_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const normalCutoffL1 = new Date(now - NORMAL_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const urgentCutoffL2 = new Date(now - URGENT_ESCALATION_L2_MINUTES * 60 * 1000).toISOString();
  const normalCutoffL2 = new Date(now - NORMAL_ESCALATION_L2_MINUTES * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  let escalatedCount = 0;

  const msgRows = db.prepare(`
    SELECT * FROM messages
    WHERE deleted_at IS NULL AND status != 'read' AND escalation_level < 2
      AND ((urgent = 1 AND created_at < ?) OR (urgent = 0 AND created_at < ?))
      AND (to_dept IS NULL OR (SELECT on_duty FROM departments WHERE id = to_dept) = 1)
  `).all(urgentCutoffL1, normalCutoffL1);
  for (const row of msgRows) {
    const l2Cutoff = row.urgent ? urgentCutoffL2 : normalCutoffL2;
    const nextLevel = (row.escalation_level || 0) === 0 ? 1 : (row.created_at < l2Cutoff ? 2 : (row.escalation_level || 0));
    if (nextLevel <= (row.escalation_level || 0)) continue;
    console.log('[escalation] unread message', row.id, 'level', nextLevel, row.urgent ? '(urgent)' : '(normal)', row.from_dept, '->', row.to_dept);
    db.prepare('UPDATE messages SET escalated_at = ?, escalation_level = ? WHERE id = ?').run(nowIso, nextLevel, row.id);
    escalatedCount++;
  }

  const ticketAtRiskCutoff = new Date(now - TICKET_AT_RISK_MINUTES * 60 * 1000).toISOString();
  const ticketBreachCutoff = new Date(now - TICKET_BREACH_MINUTES * 60 * 1000).toISOString();
  const ticketRows = db.prepare(`
    SELECT * FROM maintenance_tickets WHERE status = 'reported' AND escalation_level < 2 AND created_at < ?
  `).all(ticketAtRiskCutoff);
  for (const row of ticketRows) {
    const nextLevel = (row.escalation_level || 0) === 0 ? 1 : (row.created_at < ticketBreachCutoff ? 2 : (row.escalation_level || 0));
    if (nextLevel <= (row.escalation_level || 0)) continue;
    console.log('[escalation] unclaimed ticket', row.id, 'level', nextLevel, row.description);
    db.prepare('UPDATE maintenance_tickets SET escalated_at = ?, escalation_level = ? WHERE id = ?').run(nowIso, nextLevel, row.id);
    escalatedCount++;
  }

  return escalatedCount;
}

const OPS_PLANNER_REMINDER_DAYS = [7, 3, 1];
function checkOpsPlannerReminders() {
  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const minDate = new Date(todayUTC).toISOString().slice(0, 10);
  const maxDate = new Date(todayUTC + 8 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    "SELECT * FROM ops_calendar_entries WHERE entry_date >= ? AND entry_date <= ?"
  ).all(minDate, maxDate);
  let sentCount = 0;
  for (const row of rows) {
    const [y, m, d] = row.entry_date.split('-').map(Number);
    const targetUTC = Date.UTC(y, m - 1, d);
    const daysUntil = Math.round((targetUTC - todayUTC) / 86400000);
    if (!OPS_PLANNER_REMINDER_DAYS.includes(daysUntil)) continue;
    const deptIds = JSON.parse(row.department_ids || '[]').filter((id) => DEPT_IDS.has(id));
    const staffIds = JSON.parse(row.staff_ids || '[]');
    if (!deptIds.length && !staffIds.length) continue;

    const already = db.prepare(
      "SELECT department_id, staff_id FROM ops_planner_reminders_sent WHERE entry_id = ? AND interval_days = ?"
    ).all(row.id, daysUntil);
    const sentDepts = new Set(already.filter((r) => r.department_id).map((r) => r.department_id));
    const sentStaff = new Set(already.filter((r) => r.staff_id).map((r) => r.staff_id));
    const now = new Date().toISOString();

    for (const dept of deptIds) {
      if (sentDepts.has(dept)) continue;
      db.prepare(
        "INSERT INTO ops_planner_reminders_sent (id, entry_id, interval_days, department_id, staff_id, title, entry_date, entry_time, sent_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)"
      ).run(crypto.randomUUID(), row.id, daysUntil, dept, row.title, row.entry_date, row.entry_time || null, now);
      sentCount++;
    }
    for (const staffId of staffIds) {
      if (sentStaff.has(staffId)) continue;
      db.prepare(
        "INSERT INTO ops_planner_reminders_sent (id, entry_id, interval_days, department_id, staff_id, title, entry_date, entry_time, sent_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)"
      ).run(crypto.randomUUID(), row.id, daysUntil, staffId, row.title, row.entry_date, row.entry_time || null, now);
      sentCount++;
    }
  }
  return sentCount;
}

function nextSignoffCode() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE signoff_title IS NOT NULL").get();
  return 'RQ-' + String((row ? row.n : 0) + 1).padStart(4, '0');
}

function insertMessage(opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = opts.mentions && opts.mentions.length ? JSON.stringify(opts.mentions) : null;
  const pollOptionsJson = opts.poll ? JSON.stringify(opts.poll.options) : null;
  const signoffCode = opts.signoff ? nextSignoffCode() : null;
  try {
    db.prepare(`
      INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id, broadcast_id, room_number, task_status, group_id, mentions, signoff_title, signoff_amount, signoff_target, signoff_category, signoff_guest_info, signoff_status, signoff_code, poll_question, poll_options, poll_votes, affects_guest, dashboard_conversation_id, room_clean, from_staff_name, client_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.from, opts.to || null, opts.type,
      opts.body || null, opts.fileName || null, opts.filePath || null, opts.fileSize || null,
      opts.duration || null, opts.transcript || null, opts.urgent ? 1 : 0, now, opts.replyToId || null, opts.broadcastId || null, opts.roomNumber || null, opts.taskStatus || null, opts.groupId || null, mentionsJson,
      opts.signoff ? opts.signoff.title : null,
      opts.signoff && opts.signoff.amount != null ? opts.signoff.amount : null,
      opts.signoff && opts.signoff.target ? opts.signoff.target : null,
      opts.signoff && opts.signoff.category ? opts.signoff.category : null,
      opts.signoff && opts.signoff.guestInfo ? opts.signoff.guestInfo : null,
      opts.signoff ? 'pending' : null,
      signoffCode,
      opts.poll ? opts.poll.question : null,
      pollOptionsJson,
      opts.poll ? '{}' : null,
      opts.affectsGuest ? 1 : 0,
      opts.dashboardConversationId || null,
      opts.roomClean || null,
      opts.fromStaffName || null,
      opts.clientMessageId || null
    );
  } catch (err) {
    // A retried send carries the same clientMessageId as the original -
    // hand back the message that already exists instead of erroring.
    if (opts.clientMessageId && String(err && err.message).toLowerCase().includes('unique')) {
      const existing = db.prepare('SELECT * FROM messages WHERE client_message_id = ?').get(opts.clientMessageId);
      if (existing) return existing;
    }
    throw err;
  }
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (opts.groupId && !opts.silent) {
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
  const others = Array.from(ALL_DEPT_IDS).filter((id) => id !== self);
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
  return others.map((id) => {
    const last = lastMsgStmt.get(self, id, id, self);
    const unread = unreadStmt.get(self, id).n;
    const urgentUnread = urgentUnreadStmt.get(self, id).n;
    return {
      departmentId: id,
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
  return {
    id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at,
    profileComplete: !!row.profile_complete, statusLine: row.status_line || undefined, phone: row.phone || undefined,
    photoUrl: row.photo_url || undefined, headDepts: row.head_depts || undefined,
  };
}

function rowToNote(row) {
  return {
    id: row.id, title: row.title || undefined, body: row.body || undefined,
    fileUrl: row.file_path ? '/uploads/' + row.file_path : undefined,
    fileSize: row.file_size || undefined, duration: row.duration || undefined,
    transcript: row.transcript || undefined, createdAt: row.created_at,
  };
}

function rowToCalendarEntry(row) {
  let departmentIds = [];
  try { departmentIds = JSON.parse(row.department_ids || '[]'); } catch (e) { departmentIds = []; }
  let staffIds = [];
  try { staffIds = JSON.parse(row.staff_ids || '[]'); } catch (e) { staffIds = []; }
  return {
    id: row.id, title: row.title, date: row.entry_date, time: row.entry_time || undefined,
    categoryLabel: row.category_label, categoryColor: row.category_color,
    departmentIds, staffIds, notes: row.notes || undefined,
    createdBy: row.created_by || undefined, createdByName: row.created_by_name || undefined,
    createdAt: row.created_at,
  };
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
  if (!staff) return null;
  // Head-of-department contacts (see department_heads below) are a
  // personal identity, not tied to whichever department someone is
  // logged into - a staff member can act as "head_kitchen" only if
  // they're specifically assigned there, which this looks up once
  // per request so every permission check below can treat it as a
  // plain extra department on their account.
  const headRows = db.prepare('SELECT department_id FROM department_heads WHERE staff_id = ?').all(staff.id);
  staff.head_depts = headRows.map((r) => 'head_' + r.department_id);
  const photoRow = db.prepare('SELECT photo_path FROM staff_photos WHERE staff_id = ?').get(staff.id);
  if (photoRow) staff.photo_url = '/uploads/' + photoRow.photo_path;
  return staff;
}

// Admins can VIEW another department's conversations ("Viewing as"), but nobody -
// admin included - may act or read AS a department they aren't signed in as unless
// this explicitly allows it. Never trust a "self"/"from" field on its own.
function canViewAsSelf(requester, self) {
  if (self === requester.department_id || requester.is_admin) return true;
  return !!(requester.head_depts && requester.head_depts.includes(self));
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
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const filePath = path.join(UPLOADS_DIR, path.basename(p));
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'Not found' });
      const size = fs.statSync(filePath).size;
      const range = req.headers.range;
      // Mirrors src/worker.js's R2 range handling - Safari's <audio>/<video>
      // won't play at all without a real 206 response to its Range probe.
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
        const end = m[2] && m[1] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': size });
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
      const conversationId = body.conversationId ? String(body.conversationId).trim() : null;
      const fromDepartmentId = body.fromDepartmentId ? String(body.fromDepartmentId).trim() : null;
      if (!idempotencyKey) return send(res, 400, { error: 'idempotencyKey is required' });
      if (!DEPT_IDS.has(departmentId)) return send(res, 400, { error: 'Unknown department' });
      if (!message) return send(res, 400, { error: 'message is required' });
      if (!fromDepartmentId || !DEPT_IDS.has(fromDepartmentId)) {
        return send(res, 400, { error: 'fromDepartmentId is required and must be a real department' });
      }
      if (fromDepartmentId === departmentId) {
        return send(res, 400, { error: "fromDepartmentId can't be the same as the target department" });
      }

      const existing = db.prepare('SELECT message_id FROM external_notifications WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return send(res, 200, { ok: true, duplicate: true, messageId: existing.message_id });

      const row = insertMessage({
        from: fromDepartmentId, to: departmentId, type: 'text',
        body: message,
        dashboardConversationId: conversationId,
      });
      db.prepare('INSERT INTO external_notifications (idempotency_key, message_id, created_at) VALUES (?, ?, ?)')
        .run(idempotencyKey, row.id, new Date().toISOString());
      return send(res, 201, { ok: true, duplicate: false, messageId: row.id });
    }

    if (req.method === 'POST' && p === '/api/external/guest-requests') {
      const apiKey = req.headers['x-api-key'] || '';
      if (apiKey !== EXTERNAL_API_KEY) return send(res, 401, { error: 'Unauthorized' });
      const body = await readJsonBody(req);
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      const roomNumber = String(body.roomNumber || '').trim();
      const requestText = String(body.requestText || '').trim();
      const guestReference = body.guestReference ? String(body.guestReference).trim().slice(0, 80) : null;
      if (!idempotencyKey) return send(res, 400, { error: 'idempotencyKey is required' });
      if (!roomNumber) return send(res, 400, { error: 'roomNumber is required' });
      if (!requestText) return send(res, 400, { error: 'requestText is required' });

      const existing = db.prepare('SELECT request_id FROM external_guest_request_keys WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return send(res, 200, { ok: true, duplicate: true, id: existing.request_id });

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const text = guestReference ? requestText + ' (' + guestReference + ')' : requestText;
      db.prepare(
        "INSERT INTO guest_requests (id, room_number, request_text, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)"
      ).run(id, roomNumber, text, now, now);
      db.prepare('INSERT INTO external_guest_request_keys (idempotency_key, request_id, created_at) VALUES (?, ?, ?)')
        .run(idempotencyKey, id, now);
      console.log('[guest request notify] reception department: Room ' + roomNumber + ': ' + text);
      return send(res, 201, { ok: true, duplicate: false, id });
    }

    // ---- Guest concierge requests (public, no staff session, reached via a room QR code) ----
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
      console.log('[guest request notify] reception department: Room ' + roomNumber + ': ' + text);
      return send(res, 201, { request: rowToGuestRequest(row) });
    }

    if (req.method === 'GET' && p.startsWith('/api/guest-requests/') && !p.endsWith('/status') && !p.endsWith('/pin')) {
      const id = decodeURIComponent(p.slice('/api/guest-requests/'.length));
      const row = db.prepare('SELECT * FROM guest_requests WHERE id = ?').get(id);
      if (!row) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { request: rowToGuestRequest(row) });
    }

    // ---- Auth gate: every /api/ route except login needs a valid session ----
    if (p.startsWith('/api/') && p !== '/api/auth/login' && p !== '/api/signup') {
      const authed = staffFromToken(req);
      if (!authed) return send(res, 401, { error: 'Not signed in' });
    }

    // ---- Auth ----
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const pin = String(body.pin || '');
      if (!name || (LOGIN_REQUIRE_PIN && !pin)) return send(res, 400, { error: 'Name and PIN are required' });

      const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
      const attemptKey = (req.socket.remoteAddress || 'unknown') + '|' + name.toLowerCase();
      const attempt = loginAttempts.get(attemptKey);
      const windowExpired = attempt && (Date.now() - attempt.first >= LOCKOUT_WINDOW_MS);
      if (attempt && !windowExpired && attempt.count >= 5) {
        return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      }

      const staff = db.prepare('SELECT * FROM staff WHERE LOWER(name) = LOWER(?)').get(name);
      const ok = staff && (LOGIN_REQUIRE_PIN ? hashPin(pin, staff.pin_salt) === staff.pin_hash : true);
      if (!ok) {
        const next = (attempt && !windowExpired) ? { count: attempt.count + 1, first: attempt.first } : { count: 1, first: Date.now() };
        loginAttempts.set(attemptKey, next);
        return send(res, 401, { error: 'Incorrect name or PIN' });
      }
      loginAttempts.delete(attemptKey);

      const token = crypto.randomUUID() + crypto.randomUUID();
      db.prepare('INSERT INTO sessions (token, staff_id, created_at) VALUES (?, ?, ?)').run(token, staff.id, new Date().toISOString());
      const photoRow = db.prepare('SELECT photo_path FROM staff_photos WHERE staff_id = ?').get(staff.id);
      if (photoRow) staff.photo_url = '/uploads/' + photoRow.photo_path;
      return send(res, 200, { token: token, staff: rowToStaff(staff) });
    }

    // ---- Self-service signup: the GM tells someone directly to sign up,
    // so a name + department is all that's needed here - the GM already
    // knows who to expect, and just has to accept or deny it. Nothing is
    // usable until then: this only queues a request, it never creates a
    // real staff account by itself. ----
    if (req.method === 'POST' && p === '/api/signup') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const departmentId = body.departmentId;
      if (!name) return send(res, 400, { error: 'Name is required' });
      if (!DEPT_IDS.has(departmentId)) return send(res, 400, { error: 'Unknown department' });
      const existing = db.prepare("SELECT id FROM signup_requests WHERE LOWER(name) = LOWER(?) AND status = 'pending'").get(name);
      if (existing) return send(res, 409, { error: 'A request for that name is already waiting on approval' });
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO signup_requests (id, name, department_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
        .run(id, name, departmentId, new Date().toISOString());
      return send(res, 201, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/signup-requests') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const rows = db.prepare("SELECT id, name, department_id, created_at FROM signup_requests WHERE status = 'pending' ORDER BY created_at ASC").all();
      return send(res, 200, { requests: rows.map((r) => ({ id: r.id, name: r.name, departmentId: r.department_id, createdAt: r.created_at })) });
    }

    if (req.method === 'POST' && p.startsWith('/api/signup-requests/') && p.endsWith('/approve')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/signup-requests/'.length, -'/approve'.length));
      const reqRow = db.prepare("SELECT * FROM signup_requests WHERE id = ? AND status = 'pending'").get(id);
      if (!reqRow) return send(res, 404, { error: 'Not found' });
      const staffId = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      const throwawayPin = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, profile_complete, created_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?)`)
        .run(staffId, reqRow.name, reqRow.department_id, hashPin(throwawayPin, salt), salt, now);
      db.prepare("UPDATE signup_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(now, id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/signup-requests/') && p.endsWith('/deny')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/signup-requests/'.length, -'/deny'.length));
      db.prepare("UPDATE signup_requests SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
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
      const photoRows = db.prepare('SELECT staff_id, photo_path FROM staff_photos').all();
      const photoByStaffId = {};
      photoRows.forEach((r) => { photoByStaffId[r.staff_id] = '/uploads/' + r.photo_path; });
      return send(res, 200, { staff: rows.map((r) => rowToStaff({ ...r, photo_url: photoByStaffId[r.id] })) });
    }

    // ---- Self-service profile setup: any signed-in user can edit their own name/PIN ----
    if (req.method === 'PATCH' && p === '/api/profile') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const body = await readJsonBody(req);
      if (typeof body.name === 'string' && body.name.trim()) {
        db.prepare('UPDATE staff SET name = ? WHERE id = ?').run(body.name.trim(), requester.id);
      }
      if (typeof body.statusLine === 'string') {
        const statusLine = body.statusLine.trim().slice(0, 60);
        db.prepare('UPDATE staff SET status_line = ? WHERE id = ?').run(statusLine || null, requester.id);
      }
      if (typeof body.phone === 'string') {
        const phone = body.phone.trim().slice(0, 30);
        db.prepare('UPDATE staff SET phone = ? WHERE id = ?').run(phone || null, requester.id);
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
      const deptRequester = staffFromToken(req);
      if (typeof body.onDuty === 'boolean') {
        if (deptRequester.department_id !== id && !deptRequester.is_admin) {
          return send(res, 403, { error: "You can only change your own department's duty status" });
        }
        db.prepare('UPDATE departments SET on_duty = ? WHERE id = ?').run(body.onDuty ? 1 : 0, id);
      }
      if (typeof body.contactName === 'string') {
        if (!deptRequester.is_admin) return send(res, 403, { error: 'Admin access required' });
        db.prepare('UPDATE departments SET contact_name = ? WHERE id = ?').run(body.contactName.trim() || null, id);
      }
      const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
      return send(res, 200, { department: rowToDepartment(row) });
    }

    // Departments are icon-only - the self-service "department photo"
    // endpoints that used to live here are gone. Individual people (see
    // /api/staff/:id/photo) are the only ones who get a photo.

    // ---- Staff photos (personal, not the department's shared photo) ----
    // Used for head-of-department contacts, where the point is a real,
    // recognizable, named person - not the generic department icon.
    if (req.method === 'POST' && p.startsWith('/api/staff/') && p.endsWith('/photo')) {
      const id = decodeURIComponent(p.slice('/api/staff/'.length, -'/photo'.length));
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (requester.id !== id && !requester.is_admin) return send(res, 403, { error: 'You can only change your own photo' });
      const body = await readJsonBody(req);
      if (!body.fileBase64) return send(res, 400, { error: 'Photo is required' });
      const buf = Buffer.from(body.fileBase64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return send(res, 400, { error: 'Photo is too large (8MB max)' });
      const ext = (body.fileMime && body.fileMime.split('/')[1]) ? '.' + body.fileMime.split('/')[1].split(';')[0] : '';
      const safeName = 'staff-' + id + '-' + crypto.randomUUID() + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
      db.prepare(`INSERT INTO staff_photos (staff_id, photo_path, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(staff_id) DO UPDATE SET photo_path = excluded.photo_path, updated_at = excluded.updated_at`)
        .run(id, safeName, new Date().toISOString());
      return send(res, 200, { photoUrl: '/uploads/' + safeName });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/staff/') && p.endsWith('/photo')) {
      const id = decodeURIComponent(p.slice('/api/staff/'.length, -'/photo'.length));
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (requester.id !== id && !requester.is_admin) return send(res, 403, { error: 'You can only change your own photo' });
      db.prepare('DELETE FROM staff_photos WHERE staff_id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    // ---- Hotel profile: this hotel's own name + logo, shown on the
    // Profile page header. Separate from the Hotel Ping product brand,
    // which only appears in the "Powered by" footer. ----
    if (req.method === 'GET' && p === '/api/hotel-profile') {
      const row = db.prepare("SELECT * FROM hotel_profile WHERE id = 'default'").get();
      return send(res, 200, { name: row ? row.name : null, logoUrl: row && row.logo_path ? '/uploads/' + row.logo_path : null });
    }

    if (req.method === 'PUT' && p === '/api/hotel-profile') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin only' });
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      db.prepare(`INSERT INTO hotel_profile (id, name, updated_at) VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
        .run(name || null, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/hotel-profile/logo') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin only' });
      const body = await readJsonBody(req);
      if (!body.fileBase64) return send(res, 400, { error: 'Logo is required' });
      const buf = Buffer.from(body.fileBase64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return send(res, 400, { error: 'Logo is too large (8MB max)' });
      const ext = (body.fileMime && body.fileMime.split('/')[1]) ? '.' + body.fileMime.split('/')[1].split(';')[0] : '';
      const safeName = 'hotel-logo-' + crypto.randomUUID() + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
      db.prepare(`INSERT INTO hotel_profile (id, logo_path, updated_at) VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET logo_path = excluded.logo_path, updated_at = excluded.updated_at`)
        .run(safeName, new Date().toISOString());
      return send(res, 200, { logoUrl: '/uploads/' + safeName });
    }

    if (req.method === 'DELETE' && p === '/api/hotel-profile/logo') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin only' });
      db.prepare("UPDATE hotel_profile SET logo_path = NULL WHERE id = 'default'").run();
      return send(res, 200, { ok: true });
    }

    // ---- Department heads: which specific staff member is the named,
    // directly-reachable contact for each department (see HEAD_DEPT_IDS
    // above and canViewAsSelf/staff.head_depts for how this turns into an
    // extra, personal conversation on their account). ----
    if (req.method === 'GET' && p === '/api/department-heads') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      // Readable by anyone signed in (not just admin) - every department's
      // chat list needs this to know which head contacts to show, and who
      // a head is is meant to be visible, not privileged information.
      const rows = db.prepare(`SELECT dh.department_id, dh.staff_id, s.name, sp.photo_path FROM department_heads dh
        JOIN staff s ON s.id = dh.staff_id
        LEFT JOIN staff_photos sp ON sp.staff_id = dh.staff_id`).all();
      const heads = {};
      rows.forEach((r) => {
        heads[r.department_id] = { staffId: r.staff_id, staffName: r.name, photoUrl: r.photo_path ? '/uploads/' + r.photo_path : null };
      });
      return send(res, 200, { heads });
    }

    if (req.method === 'PUT' && p.startsWith('/api/department-heads/')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const deptId = decodeURIComponent(p.slice('/api/department-heads/'.length));
      if (!DEPT_IDS.has(deptId) || deptId === 'gm') return send(res, 400, { error: 'Unknown department' });
      const body = await readJsonBody(req);
      if (!body.staffId) return send(res, 400, { error: 'staffId is required' });
      const staffRow = db.prepare('SELECT id, department_id FROM staff WHERE id = ?').get(body.staffId);
      if (!staffRow) return send(res, 404, { error: 'Unknown staff member' });
      if (staffRow.department_id !== deptId) return send(res, 400, { error: "That person isn't in this department" });
      db.prepare(`INSERT INTO department_heads (department_id, staff_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(department_id) DO UPDATE SET staff_id = excluded.staff_id, updated_at = excluded.updated_at`)
        .run(deptId, body.staffId, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/department-heads/')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const deptId = decodeURIComponent(p.slice('/api/department-heads/'.length));
      db.prepare('DELETE FROM department_heads WHERE department_id = ?').run(deptId);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/conversations') {
      const self = url.searchParams.get('self');
      if (!ALL_DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      if (!canViewAsSelf(requester, self)) return send(res, 403, { error: "You can only view your own department's conversations" });
      return send(res, 200, { conversations: getConversations(self, requester.is_admin) });
    }

    if (req.method === 'GET' && p === '/api/messages') {
      const self = url.searchParams.get('self');
      const other = url.searchParams.get('with');
      if (!ALL_DEPT_IDS.has(self) || !(ALL_DEPT_IDS.has(other) || (other === 'dashboard' && self === 'gm'))) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      if (!canViewAsSelf(requester, self)) return send(res, 403, { error: "You can only view your own department's conversations" });
      const before = url.searchParams.get('before');
      const params = [self, other, other, self];
      let sql = `SELECT * FROM messages WHERE ((from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?))`;
      if (before) { sql += ` AND created_at < ?`; params.push(before); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(MESSAGE_PAGE_SIZE + 1);
      const rows = db.prepare(sql).all(...params);
      const hasMore = rows.length > MESSAGE_PAGE_SIZE;
      const page = (hasMore ? rows.slice(0, MESSAGE_PAGE_SIZE) : rows).reverse();
      return send(res, 200, { messages: page.map((r) => rowToMessage(r, self, requester.is_admin)).filter(Boolean), hasMore });
    }

    if (req.method === 'GET' && p === '/api/groups') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      const groupRows = db.prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
      const groups = groupRows.map((g) => {
        const members = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(g.id).map((m) => m.department_id);
        const isMember = members.includes(self);
        if (g.archived_at && !requester.is_admin && !g.shared_at) return null;
        const last = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(g.id);
        const readRow = db.prepare('SELECT last_read_at FROM group_reads WHERE group_id = ? AND department_id = ?').get(g.id, self);
        const since = readRow ? readRow.last_read_at : '1970-01-01T00:00:00.000Z';
        const unread = db.prepare(
          'SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND from_dept != ? AND created_at > ? AND deleted_at IS NULL'
        ).get(g.id, self, since);
        return {
          id: g.id, name: g.name, createdBy: g.created_by, createdAt: g.created_at,
          archivedAt: g.archived_at || undefined, sharedAt: g.shared_at || undefined,
          description: g.description || undefined, eventDate: g.event_date || undefined,
          guestCount: g.guest_count === null || g.guest_count === undefined ? undefined : g.guest_count,
          location: g.location || undefined,
          members, isMember,
          lastMessage: last && (isMember || requester.is_admin) ? rowToMessage(last, self, requester.is_admin) : null,
          unreadCount: isMember ? unread.n : 0,
        };
      }).filter(Boolean);
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

    if (req.method === 'PATCH' && p.startsWith('/api/groups/') && p.split('/').length === 4) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length));
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      const requester = staffFromToken(req);
      if (group.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that created this event can edit its details' });
      }
      const body = await readJsonBody(req);
      if (typeof body.description === 'string') {
        db.prepare('UPDATE groups SET description = ? WHERE id = ?').run(body.description.trim().slice(0, 400) || null, id);
      }
      if (typeof body.eventDate === 'string' || body.eventDate === null) {
        db.prepare('UPDATE groups SET event_date = ? WHERE id = ?').run(body.eventDate ? String(body.eventDate).trim().slice(0, 60) : null, id);
      }
      if (typeof body.guestCount === 'number' || body.guestCount === null) {
        const gc = body.guestCount === null ? null : Math.max(0, Math.round(body.guestCount));
        db.prepare('UPDATE groups SET guest_count = ? WHERE id = ?').run(gc, id);
      }
      if (typeof body.location === 'string' || body.location === null) {
        db.prepare('UPDATE groups SET location = ? WHERE id = ?').run(body.location ? String(body.location).trim().slice(0, 120) : null, id);
      }
      const members = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(id).map((m) => m.department_id);
      const row2 = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      return send(res, 200, { group: rowToGroup(row2, members) });
    }

    if (req.method === 'GET' && p.startsWith('/api/groups/') && p.endsWith('/stations')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/stations'.length));
      const rows = db.prepare('SELECT * FROM event_stations WHERE group_id = ? ORDER BY position ASC, created_at ASC').all(id);
      return send(res, 200, { stations: rows.map(rowToStation) });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/stations')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/stations'.length));
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      const requester = staffFromToken(req);
      if (group.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that created this event can add stations' });
      }
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      if (!title) return send(res, 400, { error: 'Station title is required' });
      if (title.length > 80) return send(res, 400, { error: 'Station title is too long' });
      const category = body.category ? String(body.category).trim().slice(0, 60) : null;
      const description = body.description ? String(body.description).trim().slice(0, 200) : null;
      const icon = body.icon ? String(body.icon).trim().slice(0, 30) : null;
      const posRow = db.prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_stations WHERE group_id = ?').get(id);
      const stationId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO event_stations (id, group_id, title, category, description, icon, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(stationId, id, title, category, description, icon, posRow.maxPos + 1, new Date().toISOString());
      const row = db.prepare('SELECT * FROM event_stations WHERE id = ?').get(stationId);
      return send(res, 201, { station: rowToStation(row) });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/stations/')) {
      const id = decodeURIComponent(p.slice('/api/stations/'.length));
      const station = db.prepare('SELECT * FROM event_stations WHERE id = ?').get(id);
      if (!station) return send(res, 404, { error: 'Station not found' });
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(station.group_id);
      const requester = staffFromToken(req);
      const canManage = group && (group.created_by === requester.department_id || requester.is_admin);
      const body = await readJsonBody(req);

      if (typeof body.assignedDeptId !== 'undefined') {
        if (!canManage) return send(res, 403, { error: 'Only the department that created this event can assign stations' });
        if (body.assignedDeptId !== null && !DEPT_IDS.has(body.assignedDeptId)) return send(res, 400, { error: 'Unknown department' });
        db.prepare('UPDATE event_stations SET assigned_dept_id = ?, confirmed_at = NULL WHERE id = ?').run(body.assignedDeptId || null, id);
      }
      if (body.confirm === true) {
        if (station.assigned_dept_id !== requester.department_id && !requester.is_admin) {
          return send(res, 403, { error: 'Only the assigned department can confirm this station' });
        }
        db.prepare('UPDATE event_stations SET confirmed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      }
      if (typeof body.title === 'string' || typeof body.category === 'string' || typeof body.description === 'string') {
        if (!canManage) return send(res, 403, { error: 'Only the department that created this event can edit stations' });
        if (typeof body.title === 'string') {
          const title = body.title.trim();
          if (!title) return send(res, 400, { error: 'Station title is required' });
          db.prepare('UPDATE event_stations SET title = ? WHERE id = ?').run(title.slice(0, 80), id);
        }
        if (typeof body.category === 'string') {
          db.prepare('UPDATE event_stations SET category = ? WHERE id = ?').run(body.category.trim().slice(0, 60) || null, id);
        }
        if (typeof body.description === 'string') {
          db.prepare('UPDATE event_stations SET description = ? WHERE id = ?').run(body.description.trim().slice(0, 200) || null, id);
        }
      }
      const row = db.prepare('SELECT * FROM event_stations WHERE id = ?').get(id);
      return send(res, 200, { station: rowToStation(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/stations/')) {
      const id = decodeURIComponent(p.slice('/api/stations/'.length));
      const station = db.prepare('SELECT group_id FROM event_stations WHERE id = ?').get(id);
      if (!station) return send(res, 404, { error: 'Station not found' });
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(station.group_id);
      const requester = staffFromToken(req);
      if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
        return send(res, 403, { error: 'Only the department that created this event can remove stations' });
      }
      db.prepare('DELETE FROM event_stations WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p.startsWith('/api/groups/') && p.endsWith('/runsheet')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/runsheet'.length));
      const rows = db.prepare('SELECT * FROM event_runsheet_items WHERE group_id = ? ORDER BY position ASC, created_at ASC').all(id);
      return send(res, 200, { items: rows.map(rowToRunsheetItem) });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/runsheet')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/runsheet'.length));
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      const requester = staffFromToken(req);
      if (group.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that created this event can edit the run sheet' });
      }
      const body = await readJsonBody(req);
      const timeLabel = String(body.timeLabel || '').trim();
      const title = String(body.title || '').trim();
      if (!timeLabel) return send(res, 400, { error: 'A time is required' });
      if (!title) return send(res, 400, { error: 'A title is required' });
      if (timeLabel.length > 20) return send(res, 400, { error: 'Time is too long' });
      if (title.length > 100) return send(res, 400, { error: 'Title is too long' });
      const description = body.description ? String(body.description).trim().slice(0, 300) : null;
      const teamLabel = body.teamLabel ? String(body.teamLabel).trim().slice(0, 60) : null;
      const posRow = db.prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_runsheet_items WHERE group_id = ?').get(id);
      const itemId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO event_runsheet_items (id, group_id, time_label, title, description, team_label, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(itemId, id, timeLabel, title, description, teamLabel, posRow.maxPos + 1, new Date().toISOString());
      const row = db.prepare('SELECT * FROM event_runsheet_items WHERE id = ?').get(itemId);
      return send(res, 201, { item: rowToRunsheetItem(row) });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/runsheet/')) {
      const id = decodeURIComponent(p.slice('/api/runsheet/'.length));
      const item = db.prepare('SELECT * FROM event_runsheet_items WHERE id = ?').get(id);
      if (!item) return send(res, 404, { error: 'Run sheet item not found' });
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(item.group_id);
      const requester = staffFromToken(req);
      if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
        return send(res, 403, { error: 'Only the department that created this event can edit the run sheet' });
      }
      const body = await readJsonBody(req);
      if (typeof body.timeLabel === 'string' && body.timeLabel.trim()) {
        db.prepare('UPDATE event_runsheet_items SET time_label = ? WHERE id = ?').run(body.timeLabel.trim().slice(0, 20), id);
      }
      if (typeof body.title === 'string' && body.title.trim()) {
        db.prepare('UPDATE event_runsheet_items SET title = ? WHERE id = ?').run(body.title.trim().slice(0, 100), id);
      }
      if (typeof body.description === 'string') {
        db.prepare('UPDATE event_runsheet_items SET description = ? WHERE id = ?').run(body.description.trim().slice(0, 300) || null, id);
      }
      if (typeof body.teamLabel === 'string') {
        db.prepare('UPDATE event_runsheet_items SET team_label = ? WHERE id = ?').run(body.teamLabel.trim().slice(0, 60) || null, id);
      }
      const row = db.prepare('SELECT * FROM event_runsheet_items WHERE id = ?').get(id);
      return send(res, 200, { item: rowToRunsheetItem(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/runsheet/')) {
      const id = decodeURIComponent(p.slice('/api/runsheet/'.length));
      const item = db.prepare('SELECT group_id FROM event_runsheet_items WHERE id = ?').get(id);
      if (!item) return send(res, 404, { error: 'Run sheet item not found' });
      const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(item.group_id);
      const requester = staffFromToken(req);
      if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
        return send(res, 403, { error: 'Only the department that created this event can edit the run sheet' });
      }
      db.prepare('DELETE FROM event_runsheet_items WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
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
      const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ?').get(id);
      if (msgCount.n > 0) {
        return send(res, 400, { error: "This event already has messages in it and can't be deleted. End it instead." });
      }
      db.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/archive')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/archive'.length));
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      if (group.archived_at) return send(res, 400, { error: 'This event has already ended' });
      const requester = staffFromToken(req);
      if (group.created_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that created this event can end it' });
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE groups SET archived_at = ? WHERE id = ?').run(now, id);
      const actorName = DEPT_NAMES[requester.department_id] || requester.department_id;
      insertMessage({
        from: requester.department_id, groupId: id, type: 'text',
        body: actorName + " ended this event. It's kept here for training.",
        silent: true,
      });
      const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      return send(res, 200, { group: rowToGroup(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/groups/') && p.endsWith('/share')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/share'.length));
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      if (!group) return send(res, 404, { error: 'Event not found' });
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      if (!group.archived_at) return send(res, 400, { error: 'End the event before sharing it' });
      const now = new Date().toISOString();
      db.prepare('UPDATE groups SET shared_at = ? WHERE id = ?').run(now, id);
      const actorName = DEPT_NAMES[requester.department_id] || requester.department_id;
      insertMessage({
        from: requester.department_id, groupId: id, type: 'text',
        body: actorName + ' shared this event with every department.',
        silent: true,
      });
      for (const deptId of DEPT_IDS) {
        if (deptId !== requester.department_id) console.log('[share notify]', deptId, 'event shared:', group.name);
      }
      const row2 = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
      return send(res, 200, { group: rowToGroup(row2) });
    }

    if (req.method === 'GET' && p.startsWith('/api/groups/') && p.endsWith('/messages')) {
      const id = decodeURIComponent(p.slice('/api/groups/'.length, -'/messages'.length));
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const requester = staffFromToken(req);
      if (!canViewAsSelf(requester, self)) return send(res, 403, { error: "You can only view your own department's conversations" });
      const group = db.prepare('SELECT archived_at, shared_at FROM groups WHERE id = ?').get(id);
      if (!requester.is_admin) {
        if (group && group.archived_at) {
          if (!group.shared_at) return send(res, 403, { error: 'This event has ended and is only visible to the General Manager' });
        } else {
          const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(id, self);
          if (!member) return send(res, 403, { error: 'Not a member of this group' });
        }
      }
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

    if (req.method === 'GET' && p === '/api/signoffs') {
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      const rows = db.prepare(
        "SELECT * FROM messages WHERE signoff_status IS NOT NULL AND (from_dept = ? OR to_dept = ?) AND deleted_at IS NULL ORDER BY created_at DESC"
      ).all(dept, dept);
      const items = rows.map((m) => rowToMessage(m, dept, requester.is_admin)).filter(Boolean);
      return send(res, 200, { items });
    }

    if (req.method === 'GET' && p === '/api/missed') {
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      const items = [];

      const msgRows = db.prepare(
        `SELECT * FROM messages m WHERE m.to_dept = ? AND m.deleted_at IS NULL
         AND (m.signoff_status IS NULL OR m.signoff_status != 'pending')
         AND NOT EXISTS (
           SELECT 1 FROM messages r WHERE r.from_dept = m.to_dept AND r.to_dept = m.from_dept
             AND r.deleted_at IS NULL AND r.created_at > m.created_at
         )
         ORDER BY m.created_at ASC`
      ).all(dept);
      for (const m of msgRows) {
        items.push({ kind: 'message', id: m.id, createdAt: m.created_at, message: rowToMessage(m, dept, false) });
      }

      const pendingSignoffRows = db.prepare(
        "SELECT * FROM messages WHERE to_dept = ? AND signoff_status = 'pending' AND deleted_at IS NULL ORDER BY created_at ASC"
      ).all(dept);
      for (const m of pendingSignoffRows) {
        items.push({ kind: 'approval', id: m.id, createdAt: m.created_at, message: rowToMessage(m, dept, false) });
      }

      if (dept === 'maintenance') {
        const ticketRows = db.prepare(
          "SELECT * FROM maintenance_tickets WHERE status != 'fixed' ORDER BY created_at ASC"
        ).all();
        for (const t of ticketRows) {
          items.push({ kind: 'ticket', id: t.id, createdAt: t.created_at, ticket: rowToTicket(t) });
        }
      }

      if (dept === 'foh') {
        const reqRows = db.prepare(
          "SELECT * FROM guest_requests WHERE status = 'new' ORDER BY created_at ASC"
        ).all();
        for (const r of reqRows) {
          items.push({ kind: 'guestRequest', id: r.id, createdAt: r.created_at, request: rowToGuestRequest(r) });
        }
      }

      const opsReminderRows = db.prepare(
        "SELECT * FROM ops_planner_reminders_sent WHERE read_at IS NULL AND (department_id = ? OR staff_id = ?) ORDER BY sent_at ASC"
      ).all(dept, requester.id);
      for (const r of opsReminderRows) {
        const label = r.interval_days === 1 ? 'Tomorrow' : 'In ' + r.interval_days + ' days';
        items.push({
          kind: 'planner', id: r.id, createdAt: r.sent_at,
          planner: { id: r.id, title: r.title, startsAt: label + (r.entry_time ? ' at ' + r.entry_time : '') + ' (' + r.entry_date + ')', details: undefined },
        });
      }

      items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      return send(res, 200, { items });
    }

    if (req.method === 'POST' && p.startsWith('/api/planner-notifications/') && p.endsWith('/read')) {
      const id = decodeURIComponent(p.slice('/api/planner-notifications/'.length, -'/read'.length));
      const requester = staffFromToken(req);
      const existing = db.prepare("SELECT department_id, staff_id FROM ops_planner_reminders_sent WHERE id = ?").get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      if (existing.department_id && existing.department_id !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Not part of this department' });
      }
      if (existing.staff_id && existing.staff_id !== requester.id && !requester.is_admin) {
        return send(res, 403, { error: 'Not addressed to you' });
      }
      db.prepare('UPDATE ops_planner_reminders_sent SET read_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/help-alerts') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      const deviceCoords = (typeof body.lat === 'number' && typeof body.lng === 'number')
        ? { lat: body.lat, lng: body.lng, accuracy: typeof body.accuracy === 'number' ? body.accuracy : null }
        : null;
      const location = resolveLocation(requester, deviceCoords);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO help_alerts (id, department_id, raised_by_name, raised_by_staff_id, created_at,
           location_available, location_source, floor_name, zone_name, subzone_name, location_accuracy_m)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, requester.department_id, requester.name || null, requester.id, now,
        location.available ? 1 : 0, location.source || null, location.floorName || null,
        location.zoneName || null, location.subzoneName || null,
        location.accuracyMeters != null ? location.accuracyMeters : null
      );
      const locationLabel = formatLocationLabel(location);
      for (const deptId of HELP_ALERT_RESPONDER_DEPTS) {
        if (deptId === requester.department_id) continue;
        console.log('[help alert]', deptId, ': ', (DEPT_NAMES[requester.department_id] || requester.department_id), 'needs help now -', locationLabel);
      }
      return send(res, 201, { alert: {
        id, departmentId: requester.department_id, raisedByName: requester.name || null, createdAt: now,
        respondedByName: null, respondedAt: null, location,
      } });
    }

    if (req.method === 'GET' && p === '/api/help-alerts') {
      const requester = staffFromToken(req);
      const cutoffMs = Date.now() - HELP_ALERT_WINDOW_MINUTES * 60000;
      const rows = db.prepare('SELECT * FROM help_alerts WHERE created_at > ? ORDER BY created_at DESC').all(new Date(cutoffMs).toISOString());
      const isResponder = HELP_ALERT_RESPONDER_DEPTS.includes(requester.department_id) || requester.is_admin;
      const alerts = rows
        .filter((r) => isResponder || r.department_id === requester.department_id)
        .map((r) => ({
          id: r.id, departmentId: r.department_id, raisedByName: r.raised_by_name || null, createdAt: r.created_at,
          respondedByName: r.responded_by_name || null, respondedAt: r.responded_at || null,
          location: {
            available: !!r.location_available, source: r.location_source || undefined,
            floorName: r.floor_name || undefined, zoneName: r.zone_name || undefined,
            subzoneName: r.subzone_name || undefined, accuracyMeters: r.location_accuracy_m != null ? r.location_accuracy_m : undefined,
          },
        }));
      return send(res, 200, { alerts });
    }

    if (req.method === 'POST' && p.startsWith('/api/help-alerts/') && p.endsWith('/respond')) {
      const id = decodeURIComponent(p.slice('/api/help-alerts/'.length, -'/respond'.length));
      const requester = staffFromToken(req);
      if (!HELP_ALERT_RESPONDER_DEPTS.includes(requester.department_id) && !requester.is_admin) {
        return send(res, 403, { error: 'Only a designated responder can respond to this' });
      }
      const existing = db.prepare('SELECT * FROM help_alerts WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      if (!existing.responded_at) {
        db.prepare('UPDATE help_alerts SET responded_by_name = ?, responded_at = ? WHERE id = ?')
          .run(requester.name || 'GM', new Date().toISOString(), id);
      }
      const row = db.prepare('SELECT * FROM help_alerts WHERE id = ?').get(id);
      return send(res, 200, { alert: {
        id: row.id, departmentId: row.department_id, createdAt: row.created_at,
        respondedByName: row.responded_by_name || null, respondedAt: row.responded_at || null,
      } });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/help-alerts/') && p.endsWith('/location')) {
      const id = decodeURIComponent(p.slice('/api/help-alerts/'.length, -'/location'.length));
      const requester = staffFromToken(req);
      const existing = db.prepare('SELECT * FROM help_alerts WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      if (existing.raised_by_staff_id !== requester.id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the person who raised this alert can update its location' });
      }
      const body = await readJsonBody(req);
      if (!body.zoneId) return send(res, 400, { error: 'zoneId is required' });
      const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(body.zoneId);
      if (!zone) return send(res, 404, { error: 'Unknown zone' });
      const floor = db.prepare('SELECT name FROM floors WHERE id = ?').get(zone.floor_id);
      let zoneName = zone.name, subzoneName = null;
      if (zone.parent_zone_id) {
        const parent = db.prepare('SELECT name FROM zones WHERE id = ?').get(zone.parent_zone_id);
        if (parent) { zoneName = parent.name; subzoneName = zone.name; }
      }
      db.prepare(
        `UPDATE help_alerts SET location_available = 1, location_source = 'manual',
           floor_name = ?, zone_name = ?, subzone_name = ?, location_accuracy_m = NULL WHERE id = ?`
      ).run(floor ? floor.name : null, zoneName, subzoneName, id);
      return send(res, 200, { location: { available: true, source: 'manual', floorName: floor ? floor.name : null, zoneName, subzoneName } });
    }

    if (req.method === 'GET' && p === '/api/floors') {
      const floorRows = db.prepare('SELECT * FROM floors ORDER BY position, created_at').all();
      const zoneRows = db.prepare('SELECT * FROM zones ORDER BY position, created_at').all();
      const zonesByFloor = {};
      for (const z of zoneRows) (zonesByFloor[z.floor_id] = zonesByFloor[z.floor_id] || []).push(z);
      const floors = floorRows.map((f) => {
        const zones = zonesByFloor[f.id] || [];
        const top = zones.filter((z) => !z.parent_zone_id);
        const bySubzone = {};
        for (const z of zones) if (z.parent_zone_id) (bySubzone[z.parent_zone_id] = bySubzone[z.parent_zone_id] || []).push(z);
        return {
          id: f.id, name: f.name, position: f.position,
          planImageUrl: f.plan_image_path ? '/uploads/' + f.plan_image_path : null,
          zones: top.map((z) => ({
            id: z.id, name: z.name, lat: z.lat, lng: z.lng,
            subzones: (bySubzone[z.id] || []).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })),
          })),
        };
      });
      return send(res, 200, { floors });
    }

    if (req.method === 'POST' && p === '/api/floors') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      if (!body.name || !body.name.trim()) return send(res, 400, { error: 'Floor name is required' });
      const id = crypto.randomUUID();
      const n = db.prepare('SELECT COUNT(*) AS n FROM floors').get().n;
      db.prepare('INSERT INTO floors (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, body.name.trim(), n, new Date().toISOString());
      return send(res, 201, { floor: { id, name: body.name.trim(), position: n, planImageUrl: null, zones: [] } });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/floors/') && !p.includes('/plan')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/floors/'.length));
      const existing = db.prepare('SELECT id FROM floors WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      const body = await readJsonBody(req);
      if (typeof body.name === 'string' && body.name.trim()) db.prepare('UPDATE floors SET name = ? WHERE id = ?').run(body.name.trim(), id);
      if (typeof body.position === 'number') db.prepare('UPDATE floors SET position = ? WHERE id = ?').run(body.position, id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/floors/')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/floors/'.length));
      const zoneIds = db.prepare('SELECT id FROM zones WHERE floor_id = ?').all(id).map((z) => z.id);
      for (const zid of zoneIds) db.prepare('DELETE FROM department_zone_stub WHERE zone_id = ?').run(zid);
      db.prepare('DELETE FROM zones WHERE floor_id = ?').run(id);
      db.prepare('DELETE FROM floors WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/floors/') && p.endsWith('/plan')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/floors/'.length, -'/plan'.length));
      const existing = db.prepare('SELECT id FROM floors WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      const body = await readJsonBody(req);
      if (!body.fileBase64) return send(res, 400, { error: 'Plan image is required' });
      const buf = Buffer.from(body.fileBase64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return send(res, 400, { error: 'Plan image is too large (8MB max)' });
      const ext = (body.fileMime && body.fileMime.split('/')[1]) ? '.' + body.fileMime.split('/')[1].split(';')[0] : '';
      const safeName = 'floor-' + id + '-' + crypto.randomUUID() + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
      db.prepare('UPDATE floors SET plan_image_path = ? WHERE id = ?').run(safeName, id);
      return send(res, 200, { planImageUrl: '/uploads/' + safeName });
    }

    if (req.method === 'POST' && p === '/api/zones') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      if (!body.floorId || !body.name || !body.name.trim()) return send(res, 400, { error: 'floorId and name are required' });
      const floor = db.prepare('SELECT id FROM floors WHERE id = ?').get(body.floorId);
      if (!floor) return send(res, 404, { error: 'Unknown floor' });
      if (body.parentZoneId) {
        const parent = db.prepare('SELECT id FROM zones WHERE id = ? AND floor_id = ?').get(body.parentZoneId, body.floorId);
        if (!parent) return send(res, 404, { error: 'Unknown parent zone' });
      }
      const id = crypto.randomUUID();
      const n = db.prepare('SELECT COUNT(*) AS n FROM zones WHERE floor_id = ?').get(body.floorId).n;
      const lat = typeof body.lat === 'number' ? body.lat : null;
      const lng = typeof body.lng === 'number' ? body.lng : null;
      db.prepare(
        'INSERT INTO zones (id, floor_id, parent_zone_id, name, position, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, body.floorId, body.parentZoneId || null, body.name.trim(), n, lat, lng, new Date().toISOString());
      return send(res, 201, { zone: { id, name: body.name.trim(), lat, lng, subzones: [] } });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/zones/')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/zones/'.length));
      const existing = db.prepare('SELECT id FROM zones WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Not found' });
      const body = await readJsonBody(req);
      if (typeof body.name === 'string' && body.name.trim()) db.prepare('UPDATE zones SET name = ? WHERE id = ?').run(body.name.trim(), id);
      if (typeof body.lat === 'number' && typeof body.lng === 'number') db.prepare('UPDATE zones SET lat = ?, lng = ? WHERE id = ?').run(body.lat, body.lng, id);
      else if (body.lat === null && body.lng === null) db.prepare('UPDATE zones SET lat = NULL, lng = NULL WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/zones/')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const id = decodeURIComponent(p.slice('/api/zones/'.length));
      const childIds = db.prepare('SELECT id FROM zones WHERE parent_zone_id = ?').all(id).map((z) => z.id);
      for (const cid of childIds) db.prepare('DELETE FROM department_zone_stub WHERE zone_id = ?').run(cid);
      db.prepare('DELETE FROM zones WHERE parent_zone_id = ?').run(id);
      db.prepare('DELETE FROM department_zone_stub WHERE zone_id = ?').run(id);
      db.prepare('DELETE FROM zones WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/department-zone-stub') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const rows = db.prepare(
        `SELECT dzs.department_id, dzs.zone_id, dzs.updated_at, z.name AS zone_name, z.parent_zone_id, f.name AS floor_name
         FROM department_zone_stub dzs JOIN zones z ON z.id = dzs.zone_id JOIN floors f ON f.id = z.floor_id`
      ).all();
      const stubs = {};
      for (const r of rows) stubs[r.department_id] = { zoneId: r.zone_id, floorName: r.floor_name, zoneName: r.zone_name, updatedAt: r.updated_at };
      return send(res, 200, { stubs });
    }

    if (req.method === 'PUT' && p.startsWith('/api/department-zone-stub/')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const deptId = decodeURIComponent(p.slice('/api/department-zone-stub/'.length));
      if (!DEPT_IDS.has(deptId)) return send(res, 404, { error: 'Unknown department' });
      const body = await readJsonBody(req);
      if (!body.zoneId) return send(res, 400, { error: 'zoneId is required' });
      const zone = db.prepare('SELECT id FROM zones WHERE id = ?').get(body.zoneId);
      if (!zone) return send(res, 404, { error: 'Unknown zone' });
      db.prepare(
        'INSERT INTO department_zone_stub (department_id, zone_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(department_id) DO UPDATE SET zone_id = excluded.zone_id, updated_at = excluded.updated_at'
      ).run(deptId, body.zoneId, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/department-zone-stub/')) {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const deptId = decodeURIComponent(p.slice('/api/department-zone-stub/'.length));
      db.prepare('DELETE FROM department_zone_stub WHERE department_id = ?').run(deptId);
      return send(res, 200, { ok: true });
    }

    function rowToRoom(row) {
      return {
        id: row.id, label: row.label, status: row.status,
        cleanedAt: row.cleaned_at || null, cleanedByName: row.cleaned_by_name || null,
      };
    }
    const canManageRooms = (staff) => staff.department_id === 'housekeeping' || staff.is_admin;

    if (req.method === 'GET' && p === '/api/rooms') {
      const rows = db.prepare('SELECT * FROM rooms ORDER BY position, created_at').all();
      return send(res, 200, { rooms: rows.map(rowToRoom) });
    }

    if (req.method === 'POST' && p === '/api/rooms') {
      const requester = staffFromToken(req);
      if (!canManageRooms(requester)) return send(res, 403, { error: 'Only housekeeping can do that' });
      const body = await readJsonBody(req);
      let pos = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
      const now = new Date().toISOString();
      let labels = [];
      if (typeof body.start === 'number' && typeof body.end === 'number') {
        if (body.end < body.start || body.end - body.start > 300) {
          return send(res, 400, { error: 'Check that range' });
        }
        const prefix = typeof body.prefix === 'string' ? body.prefix : '';
        for (let n = body.start; n <= body.end; n++) labels.push(prefix + n);
      } else if (typeof body.label === 'string' && body.label.trim()) {
        labels = [body.label.trim()];
      } else {
        return send(res, 400, { error: 'label, or start/end, is required' });
      }
      const created = [];
      for (const label of labels) {
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO rooms (id, label, position, status, created_at) VALUES (?, ?, ?, 'dirty', ?)").run(id, label, pos, now);
        created.push({ id, label, status: 'dirty', cleanedAt: null, cleanedByName: null });
        pos++;
      }
      return send(res, 201, { rooms: created });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/rooms/')) {
      const requester = staffFromToken(req);
      if (!canManageRooms(requester)) return send(res, 403, { error: 'Only housekeeping can do that' });
      const id = decodeURIComponent(p.slice('/api/rooms/'.length));
      db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/rooms/reset-all') {
      const requester = staffFromToken(req);
      if (!canManageRooms(requester)) return send(res, 403, { error: 'Only housekeeping can do that' });
      db.prepare("UPDATE rooms SET status = 'dirty', cleaned_at = NULL, cleaned_by_name = NULL").run();
      const rows = db.prepare('SELECT * FROM rooms ORDER BY position, created_at').all();
      return send(res, 200, { rooms: rows.map(rowToRoom) });
    }

    if (req.method === 'POST' && p.startsWith('/api/rooms/') && (p.endsWith('/clean') || p.endsWith('/dirty'))) {
      const requester = staffFromToken(req);
      if (!canManageRooms(requester)) return send(res, 403, { error: 'Only housekeeping can do that' });
      const clean = p.endsWith('/clean');
      const suffix = clean ? '/clean' : '/dirty';
      const id = decodeURIComponent(p.slice('/api/rooms/'.length, -suffix.length));
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
      if (!room) return send(res, 404, { error: 'Not found' });
      const now = new Date().toISOString();
      if (clean) {
        const wasDirty = room.status !== 'clean';
        db.prepare("UPDATE rooms SET status = 'clean', cleaned_at = ?, cleaned_by_name = ? WHERE id = ?").run(now, requester.name || null, id);
        if (wasDirty && requester.department_id !== 'foh') {
          insertMessage({ from: requester.department_id, to: 'foh', type: 'text', body: 'Room ' + room.label + ' is clean and ready.', roomClean: room.label });
        }
      } else {
        db.prepare("UPDATE rooms SET status = 'dirty', cleaned_at = NULL, cleaned_by_name = NULL WHERE id = ?").run(id);
      }
      const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
      return send(res, 200, { room: rowToRoom(row) });
    }

    if (req.method === 'GET' && p === '/api/blockers') {
      const rows = db.prepare("SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC").all();
      return send(res, 200, { blockers: rows.map(rowToBlocker) });
    }

    if (req.method === 'POST' && p === '/api/blockers') {
      const body = await readJsonBody(req);
      const waitingOn = String(body.waitingOn || '').trim();
      if (!waitingOn) return send(res, 400, { error: "Say what you're waiting on" });
      const reason = body.reason ? String(body.reason).trim().slice(0, 200) : null;
      const requester = staffFromToken(req);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO blockers (id, department_id, waiting_on, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, requester.department_id, waitingOn, reason, requester.department_id, now);
      const row = db.prepare('SELECT * FROM blockers WHERE id = ?').get(id);
      return send(res, 200, { blocker: rowToBlocker(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/blockers/') && p.endsWith('/resolve')) {
      const id = decodeURIComponent(p.slice('/api/blockers/'.length, -'/resolve'.length));
      const existing = db.prepare('SELECT * FROM blockers WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Blocker not found' });
      const requester = staffFromToken(req);
      if (existing.department_id !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department that reported this can clear it' });
      }
      db.prepare('UPDATE blockers SET resolved_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/ops-overview') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });

      const escalatedMsgRows = db.prepare(
        "SELECT * FROM messages WHERE escalation_level > 0 AND status != 'read' AND deleted_at IS NULL ORDER BY escalation_level DESC, created_at ASC"
      ).all();
      const escalatedTicketRows = db.prepare(
        "SELECT * FROM maintenance_tickets WHERE escalation_level > 0 AND status = 'reported' ORDER BY escalation_level DESC, created_at ASC"
      ).all();
      const unownedTicketRows = db.prepare(
        "SELECT * FROM maintenance_tickets WHERE status != 'fixed' AND owner_staff_id IS NULL ORDER BY created_at ASC"
      ).all();
      const blockerRows = db.prepare("SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC").all();
      const blockers = blockerRows.map(rowToBlocker);
      const byDept = {};
      blockers.forEach((b) => { byDept[b.departmentId] = b; });
      const visited = new Set();
      const chains = [];
      blockers.forEach((b) => {
        if (visited.has(b.id)) return;
        const chain = [b];
        visited.add(b.id);
        let cursor = byDept[b.waitingOn];
        while (cursor && !visited.has(cursor.id) && chain.length < 10) {
          chain.push(cursor);
          visited.add(cursor.id);
          cursor = byDept[cursor.waitingOn];
        }
        if (chain.length > 1) chains.push(chain);
      });

      const openTicketCount = db.prepare("SELECT COUNT(*) AS n FROM maintenance_tickets WHERE status != 'fixed'").get();
      const openGuestCount = db.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE status != 'completed'").get();
      const roomTotalCount = db.prepare("SELECT COUNT(*) AS n FROM rooms").get();
      const roomCleanCount = db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE status = 'clean'").get();

      return send(res, 200, {
        escalatedMessages: escalatedMsgRows.map((r) => rowToMessage(r, r.to_dept, true)),
        escalatedTickets: escalatedTicketRows.map(rowToTicket),
        unownedTickets: unownedTicketRows.map(rowToTicket),
        blockerChains: chains,
        allBlockers: blockers,
        exceptions: {
          openTickets: openTicketCount.n,
          openGuestRequests: openGuestCount.n,
        },
        rooms: { clean: roomCleanCount.n, total: roomTotalCount.n },
      });
    }

    if (req.method === 'POST' && p === '/api/messages/read') {
      const body = await readJsonBody(req);
      if (!ALL_DEPT_IDS.has(body.self) || !ALL_DEPT_IDS.has(body.with)) return send(res, 400, { error: 'Unknown department' });
      const readRequester = staffFromToken(req);
      if (!canViewAsSelf(readRequester, body.self)) return send(res, 403, { error: "You can only mark your own department's messages as read" });
      markThreadRead(body.self, body.with);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/messages') {
      const body = await readJsonBody(req);
      const { from, to, groupId, type, text, urgent, affectsGuest, fileName, fileBase64, fileMime, duration, transcript, replyToId, roomNumber, taskStatus, mentions, signoff, poll, clientMessageId } = body;
      if (!ALL_DEPT_IDS.has(from)) return send(res, 400, { error: 'Unknown department' });
      const sendRequester = staffFromToken(req);
      const sendingAsOwnHead = HEAD_DEPT_IDS.has(from) && sendRequester.head_depts && sendRequester.head_depts.includes(from);
      if (from !== sendRequester.department_id && !sendingAsOwnHead) {
        return send(res, 403, { error: 'You can only send messages as your own department' });
      }
      let validMembers = null;
      if (groupId) {
        const group = db.prepare('SELECT archived_at FROM groups WHERE id = ?').get(groupId);
        if (group && group.archived_at) return send(res, 400, { error: 'This event has ended and is now read only' });
        const memberRows = db.prepare('SELECT department_id FROM group_members WHERE group_id = ?').all(groupId);
        validMembers = new Set(memberRows.map((m) => m.department_id));
        if (!validMembers.has(from)) return send(res, 403, { error: 'Not a member of this group' });
      } else if (!ALL_DEPT_IDS.has(to) && to !== 'dashboard') {
        return send(res, 400, { error: 'Unknown department' });
      } else if (to === 'dashboard' && from !== 'gm') {
        return send(res, 403, { error: 'Only the GM can message Head Office directly' });
      }
      if (!['text', 'image', 'file', 'audio'].includes(type)) return send(res, 400, { error: 'Invalid message type' });
      if (type === 'text' && !text?.trim() && !poll) return send(res, 400, { error: 'Message text is required' });
      if (roomNumber && String(roomNumber).length > 20) return send(res, 400, { error: 'Room number is too long' });
      if (taskStatus && !TASK_STATUSES.includes(taskStatus)) return send(res, 400, { error: 'Invalid task status' });
      let signoffData = null;
      if (signoff) {
        if (groupId) return send(res, 400, { error: "Sign-off requests can't be sent in event groups" });
        const title = String(signoff.title || '').trim();
        if (!title) return send(res, 400, { error: 'Sign-off title is required' });
        if (title.length > 120) return send(res, 400, { error: 'Sign-off title is too long' });
        let amount = null;
        if (signoff.amount !== undefined && signoff.amount !== null && signoff.amount !== '') {
          amount = Number(signoff.amount);
          if (!Number.isFinite(amount) || amount < 0) return send(res, 400, { error: 'Invalid sign-off amount' });
        }
        const target = signoff.target ? String(signoff.target).trim().slice(0, 120) : null;
        const category = signoff.category ? String(signoff.category).trim().slice(0, 60) : null;
        const guestInfo = signoff.guestInfo ? String(signoff.guestInfo).trim().slice(0, 120) : null;
        signoffData = { title, amount, target, category, guestInfo };
      }
      let pollData = null;
      if (poll) {
        const question = String(poll.question || '').trim();
        if (!question) return send(res, 400, { error: 'Poll question is required' });
        if (question.length > 140) return send(res, 400, { error: 'Poll question is too long' });
        const options = Array.isArray(poll.options)
          ? poll.options.map((o) => String(o || '').trim()).filter(Boolean)
          : [];
        if (options.length < 2 || options.length > 4) return send(res, 400, { error: 'A poll needs 2-4 options' });
        if (options.some((o) => o.length > 60)) return send(res, 400, { error: 'Poll option is too long' });
        pollData = { question, options };
      }
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
        affectsGuest: !!affectsGuest,
        replyToId: replyToId || null,
        roomNumber: roomNumber ? String(roomNumber).trim() : null,
        taskStatus: taskStatus || null,
        mentions: validMentions,
        signoff: signoffData,
        poll: pollData,
        fromStaffName: sendRequester.name || null,
        clientMessageId: clientMessageId && String(clientMessageId).trim() ? String(clientMessageId).trim().slice(0, 100) : null,
      });
      return send(res, 201, { message: rowToMessage(row, from, false) });
    }

    // No one deletes a message - see src/worker.js for the full reasoning.
    if (req.method === 'DELETE' && p.startsWith('/api/messages/')) {
      return send(res, 403, { error: "Messages can't be deleted once sent - this is permanent, for every role including admin." });
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

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/affects-guest')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/affects-guest'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
        || (existing.group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(existing.group_id, requester.department_id));
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const nextValue = existing.affects_guest ? 0 : 1;
      db.prepare('UPDATE messages SET affects_guest = ? WHERE id = ?').run(nextValue, id);
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
      if (nextCompleted && existing.room_clean && requester.department_id === existing.to_dept) {
        insertMessage({ from: requester.department_id, to: existing.from_dept, type: 'text', body: '✅ Room ' + existing.room_clean + ' confirmed received.' });
      }
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

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/signoff-decision')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/signoff-decision'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      if (!existing.signoff_status) return send(res, 400, { error: "This message isn't a sign-off request" });
      const requester = staffFromToken(req);
      if (existing.to_dept !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: 'Only the department this was sent to can decide' });
      }
      if (existing.signoff_status !== 'pending') return send(res, 400, { error: 'This request has already been decided' });
      const bodyIn = await readJsonBody(req);
      if (!['approved', 'declined'].includes(bodyIn.decision)) return send(res, 400, { error: 'Invalid decision' });
      const now = new Date().toISOString();
      const decisionResult = db.prepare(
        "UPDATE messages SET signoff_status = ?, signoff_decided_by = ?, signoff_decided_at = ? WHERE id = ? AND signoff_status = 'pending'"
      ).run(bodyIn.decision, requester.name, now, id);
      if (!decisionResult.changes) return send(res, 400, { error: 'This request has already been decided' });
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      const verb = bodyIn.decision === 'approved' ? 'Approved' : 'Declined';
      // The decision lives on the original request (signoff_status/decided_by/decided_at) -
      // one message is the whole record. Notify by push only (no local dev simulation for
      // 1:1 push exists yet), not by sending a second chat message that would fragment it.
      console.log('[signoff notify]', existing.from_dept, verb.toLowerCase(), 'sign-off:', existing.signoff_title);
      return send(res, 200, { message: rowToMessage(row, requester.department_id, requester.is_admin) });
    }

    if (req.method === 'POST' && p.startsWith('/api/messages/') && p.endsWith('/vote')) {
      const id = decodeURIComponent(p.slice('/api/messages/'.length, -'/vote'.length));
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Message not found' });
      if (!existing.poll_question) return send(res, 400, { error: "This message isn't a poll" });
      const requester = staffFromToken(req);
      const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
        || (existing.group_id && db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?').get(existing.group_id, requester.department_id));
      if (!inConversation && !requester.is_admin) return send(res, 403, { error: 'Not part of this conversation' });
      const bodyIn = await readJsonBody(req);
      const options = JSON.parse(existing.poll_options || '[]');
      const optionIndex = Number(bodyIn.optionIndex);
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
        return send(res, 400, { error: 'Invalid poll option' });
      }
      db.prepare(
        "UPDATE messages SET poll_votes = json_set(COALESCE(poll_votes, '{}'), '$.' || ?, ?) WHERE id = ?"
      ).run(requester.department_id, optionIndex, id);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
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
      if (!ALL_DEPT_IDS.has(to)) return send(res, 400, { error: 'Unknown department' });
      const row = insertMessage({
        from: requester.department_id, to, type: existing.type,
        body: existing.body, fileName: existing.file_name, filePath: existing.file_path, fileSize: existing.file_size,
        duration: existing.duration, transcript: existing.transcript, urgent: false,
        fromStaffName: requester.name || null,
      });
      return send(res, 201, { message: rowToMessage(row, requester.department_id, false) });
    }

    if (req.method === 'GET' && p === '/api/notes') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const rows = db.prepare(
        'SELECT * FROM personal_notes WHERE staff_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
      ).all(requester.id);
      return send(res, 200, { notes: rows.map(rowToNote) });
    }

    if (req.method === 'POST' && p === '/api/notes') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const body = await readJsonBody(req);
      const title = body.title ? String(body.title).trim().slice(0, 120) : null;
      const text = body.body ? String(body.body).trim() : null;
      const duration = body.duration || null;
      const transcript = body.transcript ? String(body.transcript).trim() : null;
      let filePathOnDisk = null;
      let fileSize = null;
      if (body.fileBase64) {
        const buf = Buffer.from(body.fileBase64, 'base64');
        if (buf.length > 25 * 1024 * 1024) return send(res, 400, { error: 'File is too large (25MB max)' });
        const ext = (body.fileMime && body.fileMime.split('/')[1]) ? '.' + body.fileMime.split('/')[1].split(';')[0] : '';
        const safeName = 'note-' + crypto.randomUUID() + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
        filePathOnDisk = safeName;
        fileSize = buf.length;
      }
      if (!text && !filePathOnDisk) return send(res, 400, { error: "A note needs either text or a recording" });
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO personal_notes (id, staff_id, staff_name, title, body, file_path, file_size, duration, transcript, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, requester.id, requester.name || null, title, text, filePathOnDisk, fileSize, duration, transcript, now);
      const row = db.prepare('SELECT * FROM personal_notes WHERE id = ?').get(id);
      return send(res, 201, { note: rowToNote(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/notes/')) {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const id = decodeURIComponent(p.slice('/api/notes/'.length));
      const existing = db.prepare('SELECT * FROM personal_notes WHERE id = ?').get(id);
      if (!existing || existing.deleted_at) return send(res, 404, { error: 'Note not found' });
      if (existing.staff_id !== requester.id) return send(res, 403, { error: 'Not your note' });
      db.prepare('UPDATE personal_notes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/calendar-entries') {
      const monthParam = (url.searchParams.get('month') || '').trim();
      const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : new Date().toISOString().slice(0, 7);
      const rows = db.prepare(
        'SELECT * FROM ops_calendar_entries WHERE entry_date LIKE ? ORDER BY entry_date ASC, entry_time ASC'
      ).all(month + '%');
      return send(res, 200, { month, entries: rows.map(rowToCalendarEntry) });
    }

    if (req.method === 'POST' && p === '/api/calendar-entries') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const body = await readJsonBody(req);
      const title = body.title ? String(body.title).trim().slice(0, 120) : '';
      const date = body.date ? String(body.date).trim() : '';
      if (!title) return send(res, 400, { error: 'Title is required' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'A valid date is required' });
      const time = body.time && /^\d{2}:\d{2}$/.test(body.time) ? body.time : null;
      const categoryLabel = body.categoryLabel ? String(body.categoryLabel).trim().slice(0, 40) : 'Event';
      const categoryColor = /^#[0-9a-fA-F]{6}$/.test(body.categoryColor || '') ? body.categoryColor : '#3E63C9';
      const departmentIds = Array.isArray(body.departmentIds) ? body.departmentIds.filter((d) => DEPT_IDS.has(d)) : [];
      let staffIds = [];
      if (Array.isArray(body.staffIds) && body.staffIds.length) {
        const candidateIds = body.staffIds.filter((s) => typeof s === 'string' && s).slice(0, 30);
        staffIds = candidateIds.filter((sid) => db.prepare('SELECT 1 FROM staff WHERE id = ?').get(sid));
      }
      const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO ops_calendar_entries (id, title, entry_date, entry_time, category_label, category_color, department_ids, staff_ids, notes, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, title, date, time, categoryLabel, categoryColor, JSON.stringify(departmentIds), JSON.stringify(staffIds), notes, requester.id, requester.name || null, now);
      const row = db.prepare('SELECT * FROM ops_calendar_entries WHERE id = ?').get(id);
      return send(res, 201, { entry: rowToCalendarEntry(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/calendar-entries/')) {
      const id = decodeURIComponent(p.slice('/api/calendar-entries/'.length));
      const existing = db.prepare('SELECT id FROM ops_calendar_entries WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Entry not found' });
      db.prepare('DELETE FROM ops_calendar_entries WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
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
      const rows = targets.map((to) => insertMessage({ from, to, type: 'text', body: text, urgent: !!body.urgent, broadcastId, fromStaffName: requester.name || null }));
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

    if (req.method === 'POST' && p === '/api/priority-broadcast') {
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'Alert text is required' });
      const now = new Date().toISOString();
      db.prepare('UPDATE priority_broadcasts SET cleared_at = ? WHERE cleared_at IS NULL').run(now);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO priority_broadcasts (id, text, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, text, requester.id, now);
      return send(res, 201, { broadcast: { id, text, createdAt: now } });
    }

    if (req.method === 'GET' && p === '/api/priority-broadcast/active') {
      const requesterActive = staffFromToken(req);
      if (!requesterActive) return send(res, 401, { error: 'Not signed in' });
      const row = db.prepare('SELECT * FROM priority_broadcasts WHERE cleared_at IS NULL ORDER BY created_at DESC LIMIT 1').get();
      if (!row) return send(res, 200, { broadcast: null, acceptedDepts: [] });
      const acks = db.prepare('SELECT department_id FROM priority_broadcast_acks WHERE broadcast_id = ?').all(row.id);
      return send(res, 200, {
        broadcast: { id: row.id, text: row.text, createdAt: row.created_at },
        acceptedDepts: acks.map((a) => a.department_id),
      });
    }

    if (req.method === 'POST' && p.startsWith('/api/priority-broadcast/') && p.endsWith('/accept')) {
      const id = decodeURIComponent(p.slice('/api/priority-broadcast/'.length, -'/accept'.length));
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      const broadcast = db.prepare('SELECT * FROM priority_broadcasts WHERE id = ? AND cleared_at IS NULL').get(id);
      if (!broadcast) return send(res, 404, { error: 'That alert is no longer active' });
      const dept = requester.department_id;
      const already = db.prepare('SELECT 1 FROM priority_broadcast_acks WHERE broadcast_id = ? AND department_id = ?').get(id, dept);
      if (!already) {
        db.prepare('INSERT INTO priority_broadcast_acks (broadcast_id, department_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?)')
          .run(id, dept, requester.id, new Date().toISOString());
        if (dept !== 'gm') {
          insertMessage({ from: dept, to: 'gm', type: 'text', body: '✅ ' + (DEPT_NAMES[dept] || dept) + ' accepted: ' + broadcast.text });
        }
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/priority-broadcast/') && p.endsWith('/clear')) {
      const id = decodeURIComponent(p.slice('/api/priority-broadcast/'.length, -'/clear'.length));
      const requester = staffFromToken(req);
      if (!requester) return send(res, 401, { error: 'Not signed in' });
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      db.prepare('UPDATE priority_broadcasts SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL').run(new Date().toISOString(), id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/typing') {
      const body = await readJsonBody(req);
      const requester = staffFromToken(req);
      const self = requester.department_id;
      if (!ALL_DEPT_IDS.has(body.to)) return send(res, 400, { error: 'Unknown department' });
      db.prepare(`
        INSERT INTO typing_status (from_dept, to_dept, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(from_dept, to_dept) DO UPDATE SET updated_at = excluded.updated_at
      `).run(self, body.to, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/typing') {
      const self = url.searchParams.get('self');
      if (!ALL_DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const cutoff = new Date(Date.now() - 6000).toISOString();
      const rows = db.prepare('SELECT from_dept FROM typing_status WHERE to_dept = ? AND updated_at > ?').all(self, cutoff);
      return send(res, 200, { typing: rows.map((r) => r.from_dept) });
    }

    if (req.method === 'GET' && p === '/api/muted') {
      const self = url.searchParams.get('self');
      if (!DEPT_IDS.has(self)) return send(res, 400, { error: 'Unknown department' });
      const mutedRequester = staffFromToken(req);
      if (!canViewAsSelf(mutedRequester, self)) return send(res, 403, { error: "You can only view your own department's settings" });
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

    const GM_MUTABLE_DEPTS = Array.from(DEPT_IDS).filter((d) => d !== 'gm');
    if (req.method === 'GET' && p === '/api/gm/mute-departments') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const rows = db.prepare("SELECT other_dept_id FROM muted_conversations WHERE department_id = 'gm'").all();
      const mutedSet = new Set(rows.map((r) => r.other_dept_id));
      const on = GM_MUTABLE_DEPTS.every((d) => mutedSet.has(d));
      return send(res, 200, { muteDepartments: on });
    }
    if (req.method === 'POST' && p === '/api/gm/mute-departments') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const body = await readJsonBody(req);
      const on = !!body.on;
      const now = new Date().toISOString();
      for (const d of GM_MUTABLE_DEPTS) {
        if (on) db.prepare("INSERT OR IGNORE INTO muted_conversations (department_id, other_dept_id, muted_at) VALUES ('gm', ?, ?)").run(d, now);
        else db.prepare("DELETE FROM muted_conversations WHERE department_id = 'gm' AND other_dept_id = ?").run(d);
      }
      return send(res, 200, { muteDepartments: on });
    }

    if (req.method === 'GET' && p === '/api/quick-replies') {
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      let rows = db.prepare('SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC').all(dept);
      if (rows.length === 0) {
        const now = new Date().toISOString();
        DEFAULT_QUICK_REPLIES.forEach((text, i) => {
          db.prepare('INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), dept, text, i, now);
        });
        rows = db.prepare('SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC').all(dept);
      }
      return send(res, 200, { replies: rows.map((r) => ({ id: r.id, text: r.text })) });
    }

    if (req.method === 'POST' && p === '/api/quick-replies') {
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 24);
      if (!text) return send(res, 400, { error: 'Text is required' });
      const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM quick_replies WHERE department_id = ?').get(dept);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, dept, text, maxPos.m + 1, new Date().toISOString());
      return send(res, 201, { reply: { id, text } });
    }

    if (req.method === 'PATCH' && p.startsWith('/api/quick-replies/')) {
      const id = decodeURIComponent(p.slice('/api/quick-replies/'.length));
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      const existing = db.prepare('SELECT 1 FROM quick_replies WHERE id = ? AND department_id = ?').get(id, dept);
      if (!existing) return send(res, 404, { error: 'Not found' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 24);
      if (!text) return send(res, 400, { error: 'Text is required' });
      db.prepare('UPDATE quick_replies SET text = ? WHERE id = ?').run(text, id);
      return send(res, 200, { reply: { id, text } });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/quick-replies/')) {
      const id = decodeURIComponent(p.slice('/api/quick-replies/'.length));
      const requester = staffFromToken(req);
      const dept = requester.department_id;
      db.prepare('DELETE FROM quick_replies WHERE id = ? AND department_id = ?').run(id, dept);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/stories') {
      const now = new Date().toISOString();
      db.prepare('DELETE FROM story_views WHERE story_id IN (SELECT id FROM stories WHERE expires_at < ?)').run(now);
      db.prepare('DELETE FROM stories WHERE expires_at < ?').run(now);
      const rows = db.prepare('SELECT * FROM stories WHERE expires_at >= ? ORDER BY created_at ASC').all(now);
      const requester = staffFromToken(req);
      const viewerDept = requester.department_id;
      const viewedRows = db.prepare('SELECT story_id FROM story_views WHERE department_id = ?').all(viewerDept);
      const viewedIds = new Set(viewedRows.map((r) => r.story_id));
      return send(res, 200, { stories: rows.map((r) => rowToStory(r, r.department_id === viewerDept || viewedIds.has(r.id))) });
    }

    if (req.method === 'POST' && p === '/api/stories') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      if (!body.fileBase64) return send(res, 400, { error: 'Photo is required' });
      const buf = Buffer.from(body.fileBase64, 'base64');
      if (buf.length > 10 * 1024 * 1024) return send(res, 400, { error: 'Photo is too large (10MB max)' });
      const ext = (body.fileMime && body.fileMime.split('/')[1]) ? '.' + body.fileMime.split('/')[1].split(';')[0] : '';
      const safeName = 'story-' + crypto.randomUUID() + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
      const id = crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      const caption = body.caption ? String(body.caption).trim().slice(0, 200) : null;
      db.prepare(
        'INSERT INTO stories (id, department_id, staff_name, photo_path, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, requester.department_id, requester.name, safeName, caption, now.toISOString(), expiresAt);
      const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
      return send(res, 201, { story: rowToStory(row, true) });
    }

    if (req.method === 'POST' && p.startsWith('/api/stories/') && p.endsWith('/view')) {
      const id = decodeURIComponent(p.slice('/api/stories/'.length, -'/view'.length));
      const story = db.prepare('SELECT 1 FROM stories WHERE id = ?').get(id);
      if (!story) return send(res, 404, { error: 'Story not found' });
      const requester = staffFromToken(req);
      db.prepare(
        'INSERT INTO story_views (story_id, department_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT(story_id, department_id) DO NOTHING'
      ).run(id, requester.department_id, new Date().toISOString());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/stories/')) {
      const id = decodeURIComponent(p.slice('/api/stories/'.length));
      const existing = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Story not found' });
      const requester = staffFromToken(req);
      if (existing.department_id !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: "You can only delete your own department's stories" });
      }
      db.prepare('DELETE FROM story_views WHERE story_id = ?').run(id);
      db.prepare('DELETE FROM stories WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
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
      let voicePath = null;
      let voiceDuration = null;
      if (body.voiceBase64) {
        const buf = Buffer.from(body.voiceBase64, 'base64');
        const ext = (body.voiceMime && body.voiceMime.split('/')[1]) ? '.' + body.voiceMime.split('/')[1].split(';')[0] : '.webm';
        const safeName = crypto.randomUUID() + ext;
        fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buf);
        voicePath = safeName;
        voiceDuration = Number.isFinite(Number(body.voiceDuration)) ? Math.round(Number(body.voiceDuration)) : null;
      }
      if (!text && !voicePath) return send(res, 400, { error: 'Message is required' });
      const requester = staffFromToken(req);
      const replyId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO maintenance_replies (id, ticket_id, from_dept, body, created_at, voice_path, voice_duration) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(replyId, id, requester.department_id, text || '', now, voicePath, voiceDuration);
      const row = db.prepare('SELECT * FROM maintenance_replies WHERE id = ?').get(replyId);

      const notifyTarget = requester.department_id === 'maintenance' ? existing.created_by : 'maintenance';
      if (notifyTarget !== requester.department_id) {
        console.log('[maintenance reply notify]', notifyTarget, ':', text || '(voice reply)');
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
      const maintRequester = staffFromToken(req);
      if (maintRequester.department_id !== 'maintenance' && !maintRequester.is_admin) {
        return send(res, 403, { error: "Only Maintenance can update a ticket's status" });
      }
      const now = new Date().toISOString();
      const newOwner = !existing.owner_staff_id && status !== 'reported' ? maintRequester.id : existing.owner_staff_id;
      db.prepare('UPDATE maintenance_tickets SET status = ?, updated_at = ?, resolved_at = ?, owner_staff_id = ? WHERE id = ?')
        .run(status, now, status === 'fixed' ? now : null, newOwner, id);
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

    if (req.method === 'POST' && p.startsWith('/api/maintenance/') && p.endsWith('/owner')) {
      const id = decodeURIComponent(p.slice('/api/maintenance/'.length, -'/owner'.length));
      const existing = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Ticket not found' });
      const requester = staffFromToken(req);
      if (requester.department_id !== 'maintenance' && !requester.is_admin) {
        return send(res, 403, { error: "Only Maintenance can assign a ticket's owner" });
      }
      const body = await readJsonBody(req);
      const staffId = body.staffId || null;
      if (staffId) {
        const staffRow = db.prepare("SELECT id FROM staff WHERE id = ? AND department_id = 'maintenance'").get(staffId);
        if (!staffRow) return send(res, 400, { error: 'Not a Maintenance staff member' });
      }
      db.prepare('UPDATE maintenance_tickets SET owner_staff_id = ? WHERE id = ?').run(staffId, id);
      const row = db.prepare('SELECT * FROM maintenance_tickets WHERE id = ?').get(id);
      return send(res, 200, { ticket: rowToTicket(row) });
    }

    if (req.method === 'POST' && p === '/api/maintenance/reorder') {
      const body = await readJsonBody(req);
      const order = Array.isArray(body.order) ? body.order : [];
      if (!order.length) return send(res, 400, { error: 'order is required' });
      const update = db.prepare('UPDATE maintenance_tickets SET sort_order = ? WHERE id = ?');
      order.forEach((id, i) => update.run(i * 10, id));
      const rows = db.prepare(`SELECT * FROM maintenance_tickets WHERE id IN (${order.map(() => '?').join(',')})`).all(...order);
      return send(res, 200, { tickets: rows.map(rowToTicket) });
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
      if (requester.department_id !== 'foh') {
        return send(res, 403, { error: 'Reception access required' });
      }
      const rows = db.prepare('SELECT * FROM guest_requests ORDER BY created_at DESC').all();
      return send(res, 200, { requests: rows.map(rowToGuestRequest) });
    }

    if (req.method === 'POST' && p.startsWith('/api/guest-requests/') && p.endsWith('/status')) {
      const requester = staffFromToken(req);
      if (requester.department_id !== 'foh') {
        return send(res, 403, { error: 'Reception access required' });
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
      if (requester.department_id !== 'foh') {
        return send(res, 403, { error: 'Reception access required' });
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

    if (req.method === 'GET' && p === '/api/assets') {
      const rows = db.prepare('SELECT * FROM asset_requests ORDER BY created_at DESC').all();
      return send(res, 200, { requests: rows.map(rowToAssetRequest) });
    }

    if (req.method === 'POST' && p === '/api/assets') {
      const requester = staffFromToken(req);
      const body = await readJsonBody(req);
      const itemName = String(body.itemName || '').trim();
      if (!itemName) return send(res, 400, { error: 'An item name is required' });
      if (itemName.length > 80) return send(res, 400, { error: 'Item name is too long' });
      const notes = body.notes ? String(body.notes).trim().slice(0, 200) : null;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO asset_requests (id, item_name, notes, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)"
      ).run(id, itemName, notes, requester.department_id, now, now);
      const row = db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(id);
      console.log('[asset notify] all departments:', (DEPT_NAMES[requester.department_id] || requester.department_id), 'needs:', itemName);
      return send(res, 201, { request: rowToAssetRequest(row) });
    }

    if (req.method === 'POST' && p.startsWith('/api/assets/') && p.endsWith('/status')) {
      const id = decodeURIComponent(p.slice('/api/assets/'.length, -'/status'.length));
      const body = await readJsonBody(req);
      const status = body.status;
      if (!ASSET_STATUSES.includes(status)) return send(res, 400, { error: 'Invalid status' });
      const existing = db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Request not found' });
      const assetRequester = staffFromToken(req);
      if (existing.requested_by !== assetRequester.department_id && !assetRequester.is_admin) {
        return send(res, 403, { error: "You can only update your own department's requests" });
      }
      const now = new Date().toISOString();
      db.prepare('UPDATE asset_requests SET status = ?, updated_at = ?, returned_at = ? WHERE id = ?')
        .run(status, now, status === 'returned' ? now : null, id);
      const row = db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(id);
      return send(res, 200, { request: rowToAssetRequest(row) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/assets/')) {
      const id = decodeURIComponent(p.slice('/api/assets/'.length));
      const existing = db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(id);
      if (!existing) return send(res, 404, { error: 'Request not found' });
      const requester = staffFromToken(req);
      if (existing.requested_by !== requester.department_id && !requester.is_admin) {
        return send(res, 403, { error: "You can only remove your own department's requests" });
      }
      db.prepare('DELETE FROM asset_requests WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/escalations/check') {
      const requester = staffFromToken(req);
      if (!requester.is_admin) return send(res, 403, { error: 'Admin access required' });
      const count = checkEscalations();
      const remindersSent = checkOpsPlannerReminders();
      return send(res, 200, { escalated: count, plannerRemindersSent: remindersSent });
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
