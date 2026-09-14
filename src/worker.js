const DEPT_IDS = new Set(["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"]);
const DEPT_NAMES = {
  gm: "General Manager", foh: "Head Receptionist", concierge: "Head Concierge", restaurant: "Restaurant Manager",
  kitchen: "Head Chef", bar: "Bar Manager", housekeeping: "Head Housekeeper", maintenance: "Maintenance Manager",
  dashboard: "Dashboard",
};
const PIN_RE = /^\d{4,6}$/;
const TASK_STATUSES = ["not_started", "in_progress", "completed"];
const MAINT_STATUSES = ["reported", "in_progress", "fixed"];
const MAINT_PRIORITIES = ["safety", "guest", "problem", "routine"];
const MAINT_PRIORITY_RANK = { safety: 0, guest: 1, problem: 2, routine: 3 };
const DEADLINE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GUEST_REQUEST_STATUSES = ["new", "in_progress", "completed"];
const ASSET_STATUSES = ["requested", "borrowed", "returned"];
const DEFAULT_QUICK_REPLIES = ["On it", "Done", "5 mins", "On my way", "Noted", "Course away", "Hold 10 mins", "Ready for dessert"];

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }, headers || {}),
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: 100000 },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}
function randomSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}
function newToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

/* ---------------- base64url helpers ---------------- */
function b64urlToBytes(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/* ---------------- Web Push (VAPID + aes128gcm) ---------------- */
async function vapidAuthHeader(env, endpointUrl) {
  const aud = new URL(endpointUrl).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.VAPID_SUBJECT };
  const enc = new TextEncoder();
  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify(header))) + "." + bytesToB64url(enc.encode(JSON.stringify(claims)));

  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(signingInput)
  );
  const jwt = signingInput + "." + bytesToB64url(new Uint8Array(sig));
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(sig);
}
async function hkdfExpand(prk, info, length) {
  const out = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return out.slice(0, length);
}

async function encryptPushPayload(payloadObj, p256dhB64, authB64) {
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payloadObj));

  const uaPublicBytes = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const prk = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ikm = await hkdfExpand(prk, keyInfo, 32);

  const prk2 = await hmacSha256(salt, ikm);
  const cekInfo = enc.encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = enc.encode("Content-Encoding: nonce\0");
  const cekBytes = await hkdfExpand(prk2, cekInfo, 16);
  const nonce = await hkdfExpand(prk2, nonceInfo, 12);

  const cekKey = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const recordPlaintext = concatBytes(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, recordPlaintext)
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([asPublicBytes.length]), asPublicBytes);
  return concatBytes(header, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  const body = await encryptPushPayload(payloadObj, subscription.p256dh, subscription.auth);
  const auth = await vapidAuthHeader(env, subscription.endpoint);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": auth,
    },
    body,
  });
  return res;
}

async function notifyDepartment(env, deptId, payloadObj, fromDeptId) {
  const dept = await env.DB.prepare("SELECT on_duty FROM departments WHERE id = ?").bind(deptId).first();
  if (!dept || !dept.on_duty) return;
  if (fromDeptId) {
    const muted = await env.DB.prepare(
      "SELECT 1 FROM muted_conversations WHERE department_id = ? AND other_dept_id = ?"
    ).bind(deptId, fromDeptId).first();
    if (muted) return;
  }
  const staffRows = await env.DB.prepare("SELECT id FROM staff WHERE department_id = ?").bind(deptId).all();
  for (const s of staffRows.results) {
    const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE staff_id = ?").bind(s.id).all();
    for (const sub of subs.results) {
      try {
        const res = await sendWebPush(env, sub, payloadObj);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
        }
      } catch (e) {
        // best-effort - don't fail the message send if a push fails
      }
    }
  }
}

async function notifyAdmins(env, payloadObj) {
  const staffRows = await env.DB.prepare("SELECT id FROM staff WHERE is_admin = 1").all();
  for (const s of staffRows.results) {
    const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE staff_id = ?").bind(s.id).all();
    for (const sub of subs.results) {
      try {
        const res = await sendWebPush(env, sub, payloadObj);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
        }
      } catch (e) {
        // best-effort
      }
    }
  }
}

const URGENT_ESCALATION_MINUTES = 10;
const NORMAL_ESCALATION_MINUTES = 25;
const URGENT_ESCALATION_L2_MINUTES = 20;
const NORMAL_ESCALATION_L2_MINUTES = 50;
const TICKET_AT_RISK_MINUTES = 15;
const TICKET_BREACH_MINUTES = 35;

async function checkEscalations(env) {
  const now = Date.now();
  const urgentCutoffL1 = new Date(now - URGENT_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const normalCutoffL1 = new Date(now - NORMAL_ESCALATION_MINUTES * 60 * 1000).toISOString();
  const urgentCutoffL2 = new Date(now - URGENT_ESCALATION_L2_MINUTES * 60 * 1000).toISOString();
  const normalCutoffL2 = new Date(now - NORMAL_ESCALATION_L2_MINUTES * 60 * 1000).toISOString();
  let escalatedCount = 0;

  const msgRows = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE deleted_at IS NULL AND status != 'read' AND escalation_level < 2
       AND ((urgent = 1 AND created_at < ?) OR (urgent = 0 AND created_at < ?))
       AND (to_dept IS NULL OR (SELECT on_duty FROM departments WHERE id = to_dept) = 1)`
  ).bind(urgentCutoffL1, normalCutoffL1).all();
  for (const row of msgRows.results) {
    const l2Cutoff = row.urgent ? urgentCutoffL2 : normalCutoffL2;
    const nextLevel = (row.escalation_level || 0) === 0 ? 1 : (row.created_at < l2Cutoff ? 2 : (row.escalation_level || 0));
    if (nextLevel <= (row.escalation_level || 0)) continue;
    const preview = row.type === "text" ? row.body : (row.type === "image" ? "a photo" : row.type === "file" ? "a file" : "a voice message");
    const stillLabel = nextLevel === 2 ? "Still unread — " : "";
    await notifyAdmins(env, {
      title: (row.urgent ? "⚠️ " : "") + stillLabel + (row.urgent ? "Unread urgent message" : "Unread message"),
      body: (DEPT_NAMES[row.from_dept] || row.from_dept) + " → " + (DEPT_NAMES[row.to_dept] || row.to_dept) + ": " + preview,
      url: "/",
      tag: "hotel-ping-escalation-" + row.id + "-" + nextLevel,
    });
    await env.DB.prepare("UPDATE messages SET escalated_at = ?, escalation_level = ? WHERE id = ?")
      .bind(new Date().toISOString(), nextLevel, row.id).run();
    escalatedCount++;
  }

  const ticketAtRiskCutoff = new Date(now - TICKET_AT_RISK_MINUTES * 60 * 1000).toISOString();
  const ticketBreachCutoff = new Date(now - TICKET_BREACH_MINUTES * 60 * 1000).toISOString();
  const ticketRows = await env.DB.prepare(
    `SELECT * FROM maintenance_tickets WHERE status = 'reported' AND escalation_level < 2 AND created_at < ?`
  ).bind(ticketAtRiskCutoff).all();
  for (const row of ticketRows.results) {
    const nextLevel = (row.escalation_level || 0) === 0 ? 1 : (row.created_at < ticketBreachCutoff ? 2 : (row.escalation_level || 0));
    if (nextLevel <= (row.escalation_level || 0)) continue;
    await notifyAdmins(env, {
      title: nextLevel === 2 ? "🔴 Maintenance ticket still unclaimed" : "🟡 Maintenance ticket needs claiming",
      body: row.description,
      url: "/",
      tag: "hotel-ping-ticket-escalation-" + row.id + "-" + nextLevel,
    });
    await env.DB.prepare("UPDATE maintenance_tickets SET escalated_at = ?, escalation_level = ? WHERE id = ?")
      .bind(new Date().toISOString(), nextLevel, row.id).run();
    escalatedCount++;
  }

  return escalatedCount;
}

async function insertMessage(env, ctx, opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = opts.mentions && opts.mentions.length ? JSON.stringify(opts.mentions) : null;
  const pollOptionsJson = opts.poll ? JSON.stringify(opts.poll.options) : null;
  await env.DB.prepare(
    `INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id, broadcast_id, room_number, task_status, group_id, mentions, signoff_title, signoff_amount, signoff_target, signoff_category, signoff_guest_info, signoff_status, poll_question, poll_options, poll_votes, affects_guest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, opts.from, opts.to || null, opts.type,
    opts.body || null, opts.fileName || null, opts.filePath || null, opts.fileSize || null,
    opts.duration || null, opts.transcript || null, opts.urgent ? 1 : 0, now, opts.replyToId || null, opts.broadcastId || null, opts.roomNumber || null, opts.taskStatus || null, opts.groupId || null, mentionsJson,
    opts.signoff ? opts.signoff.title : null,
    opts.signoff && opts.signoff.amount != null ? opts.signoff.amount : null,
    opts.signoff && opts.signoff.target ? opts.signoff.target : null,
    opts.signoff && opts.signoff.category ? opts.signoff.category : null,
    opts.signoff && opts.signoff.guestInfo ? opts.signoff.guestInfo : null,
    opts.signoff ? "pending" : null,
    opts.poll ? opts.poll.question : null,
    pollOptionsJson,
    opts.poll ? "{}" : null,
    opts.affectsGuest ? 1 : 0
  ).run();

  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
  if (opts.silent) return row;

  const previewMap = { text: opts.body || "", image: "📷 Photo", file: "📎 " + (opts.fileName || "File"), audio: "🎤 Voice message" };
  const notifyBody = opts.urgent ? "🔴 Urgent: " + (previewMap[opts.type] || "New message") : (previewMap[opts.type] || "New message");
  let notifyPromise;
  if (opts.groupId) {
    const members = await env.DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(opts.groupId).all();
    const others = members.results.map((m) => m.department_id).filter((d) => d !== opts.from);
    const mentioned = new Set(opts.mentions || []);
    notifyPromise = Promise.all(others.map((deptId) => notifyDepartment(env, deptId, {
      title: DEPT_NAMES[opts.from] || opts.from,
      body: mentioned.has(deptId) ? "🔔 You were mentioned: " + notifyBody : notifyBody,
      url: "/",
      tag: "hotel-ping-group-" + opts.groupId,
      icon: "/avatars/" + opts.from + ".png",
    }, opts.from))).catch(function(e){ console.error("notifyDepartment (group) top-level error:", e && e.stack || e); });
  } else {
    notifyPromise = notifyDepartment(env, opts.to, {
      title: DEPT_NAMES[opts.from] || opts.from,
      body: notifyBody,
      url: "/",
      tag: "hotel-ping-" + opts.to,
      icon: "/avatars/" + opts.from + ".png",
    }, opts.from).catch(function(e){ console.error("notifyDepartment top-level error:", e && e.stack || e); });
  }
  if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

  return row;
}

function rowToHandoverNote(row) {
  return { id: row.id, departmentId: row.department_id, staffId: row.staff_id, staffName: row.staff_name, body: row.body, createdAt: row.created_at };
}
function rowToDepartment(row) {
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty, photoUrl: row.photo_path ? "/uploads/" + row.photo_path : undefined };
}
function rowToTicket(row) {
  return {
    id: row.id,
    roomNumber: row.room_number || undefined,
    description: row.description,
    photoUrl: row.photo_path ? "/uploads/" + row.photo_path : undefined,
    status: row.status,
    priority: row.priority || "problem",
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
function rowToStory(row, viewed) {
  return {
    id: row.id,
    departmentId: row.department_id,
    staffName: row.staff_name || undefined,
    photoUrl: "/uploads/" + row.photo_path,
    caption: row.caption || undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewed: !!viewed,
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
function rowToMessage(row, viewerDeptId, isAdmin) {
  const deleted = !!row.deleted_at;
  if (deleted && !isAdmin && viewerDeptId !== row.from_dept) {
    // A department that didn't send it and isn't reviewing as management sees nothing at all.
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
    fileUrl: hide || !row.file_path ? null : "/uploads/" + row.file_path,
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
    signoff: row.signoff_title ? {
      title: row.signoff_title,
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
      options: JSON.parse(row.poll_options || "[]"),
      votes: JSON.parse(row.poll_votes || "{}"),
    } : undefined,
    escalationLevel: row.escalation_level || 0,
    affectsGuest: !!row.affects_guest,
  };
}
function rowToStaff(row) {
  return { id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at, profileComplete: !!row.profile_complete, statusLine: row.status_line || undefined, phone: row.phone || undefined };
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

async function staffFromToken(env, request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE token = ?").bind(token).first();
  if (!session) return null;
  const staff = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(session.staff_id).first();
  return staff || null;
}

// Admins can VIEW another department's conversations ("Viewing as"), but nobody -
// admin included - may act or read AS a department they aren't signed in as unless
// this explicitly allows it. Never trust a "self"/"from" field on its own.
function canViewAsSelf(requester, self) {
  return self === requester.department_id || !!requester.is_admin;
}

async function ensureSeeded(env) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first();
  if (count && count.n > 0) return;
  const salt = randomSaltHex();
  // Never seed a hardcoded/guessable PIN - anyone who has read this source file would
  // know it. Generate a random one and log it so whoever triggered this bootstrap
  // (staff table was completely empty) can retrieve it from the Worker logs.
  const pinBytes = new Uint32Array(1);
  crypto.getRandomValues(pinBytes);
  const pin = String(100000 + (pinBytes[0] % 900000));
  const hash = await hashPin(pin, salt);
  await env.DB.prepare(
    `INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, created_at) VALUES (?, 'Dave', 'gm', ?, ?, 1, ?)`
  ).bind(crypto.randomUUID(), hash, salt, new Date().toISOString()).run();
  console.log("First-run admin account seeded: name 'Dave', PIN " + pin + " - sign in and change this PIN immediately.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return json({}, 204);

    try {
      // ---- Uploaded files (R2) ----
      if (method === "GET" && p.startsWith("/uploads/")) {
        const key = decodeURIComponent(p.slice("/uploads/".length));
        const obj = await env.UPLOADS.get(key);
        if (!obj) return json({ error: "Not found" }, 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(obj.body, { headers });
      }

      if (!p.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      await ensureSeeded(env);

      // ---- External integration (own API-key auth, not a staff session) ----
      if (method === "POST" && p === "/api/external/notify") {
        const apiKey = request.headers.get("x-api-key") || "";
        if (!env.EXTERNAL_API_KEY || apiKey !== env.EXTERNAL_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        const body = await readJsonBody(request);
        const idempotencyKey = String(body.idempotencyKey || "").trim();
        const departmentId = body.departmentId;
        const message = String(body.message || "").trim();
        if (!idempotencyKey) return json({ error: "idempotencyKey is required" }, 400);
        if (!DEPT_IDS.has(departmentId)) return json({ error: "Unknown department" }, 400);
        if (!message) return json({ error: "message is required" }, 400);

        const existing = await env.DB.prepare(
          "SELECT message_id FROM external_notifications WHERE idempotency_key = ?"
        ).bind(idempotencyKey).first();
        if (existing) {
          return json({ ok: true, duplicate: true, messageId: existing.message_id });
        }

        const row = await insertMessage(env, ctx, { from: "dashboard", to: departmentId, type: "text", body: message });
        await env.DB.prepare(
          "INSERT INTO external_notifications (idempotency_key, message_id, created_at) VALUES (?, ?, ?)"
        ).bind(idempotencyKey, row.id, new Date().toISOString()).run();

        return json({ ok: true, duplicate: false, messageId: row.id }, 201);
      }

      // ---- Guest concierge requests (public, no staff session, reached via a room QR code) ----
      if (method === "POST" && p === "/api/guest-requests") {
        const body = await readJsonBody(request);
        const roomNumber = String(body.roomNumber || "").trim();
        const text = String(body.text || "").trim();
        if (!roomNumber) return json({ error: "Room number is required" }, 400);
        if (roomNumber.length > 20) return json({ error: "Room number is too long" }, 400);
        if (!text) return json({ error: "Please describe what you need" }, 400);
        if (text.length > 500) return json({ error: "Message is too long" }, 400);

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO guest_requests (id, room_number, request_text, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)"
        ).bind(id, roomNumber, text, now, now).run();
        const row = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();

        const notifyPromise = notifyDepartment(env, "concierge", {
          title: "🛎️ Guest request, Room " + roomNumber,
          body: text,
          url: "/",
          tag: "hotel-ping-guest-request-" + id,
        }, null).catch(function(e){ console.error("notifyDepartment (guest request) error:", e && e.stack || e); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ request: rowToGuestRequest(row) }, 201);
      }

      if (method === "GET" && p.startsWith("/api/guest-requests/") && !p.endsWith("/status") && !p.endsWith("/pin")) {
        const id = decodeURIComponent(p.slice("/api/guest-requests/".length));
        const row = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        return json({ request: rowToGuestRequest(row) });
      }

      // ---- Auth gate ----
      if (p !== "/api/auth/login") {
        const authed = await staffFromToken(env, request);
        if (!authed) return json({ error: "Not signed in" }, 401);
        request._staff = authed;
      }

      if (method === "POST" && p === "/api/auth/login") {
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim();
        const pin = String(body.pin || "");
        if (!name || !pin) return json({ error: "Name and PIN are required" }, 400);

        const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;
        const attemptKey = name.toLowerCase();
        const attempt = await env.DB.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(attemptKey).first();
        const windowExpired = attempt && (Date.now() - Date.parse(attempt.first_at) >= LOCKOUT_WINDOW_MS);
        if (attempt && !windowExpired && attempt.count >= 5) {
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
        }

        const staff = await env.DB.prepare("SELECT * FROM staff WHERE LOWER(name) = LOWER(?)").bind(name).first();
        const ok = staff && (await hashPin(pin, staff.pin_salt)) === staff.pin_hash;
        if (!ok) {
          if (attempt && !windowExpired) {
            await env.DB.prepare("UPDATE login_attempts SET count = ? WHERE key = ?").bind(attempt.count + 1, attemptKey).run();
          } else {
            await env.DB.prepare("INSERT OR REPLACE INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)").bind(attemptKey, new Date().toISOString()).run();
          }
          return json({ error: "Incorrect name or PIN" }, 401);
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(attemptKey).run();

        const token = newToken();
        await env.DB.prepare("INSERT INTO sessions (token, staff_id, created_at) VALUES (?, ?, ?)").bind(token, staff.id, new Date().toISOString()).run();
        return json({ token, staff: rowToStaff(staff) });
      }

      if (method === "POST" && p === "/api/auth/logout") {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
        if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/auth/me") {
        return json({ staff: rowToStaff(request._staff) });
      }

      // ---- Push notifications ----
      if (method === "GET" && p === "/api/push/vapid-public-key") {
        return json({ key: env.VAPID_PUBLIC_KEY });
      }

      if (method === "POST" && p === "/api/push/subscribe") {
        const body = await readJsonBody(request);
        const sub = body.subscription;
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: "Invalid subscription" }, 400);
        }
        const existing = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).first();
        if (existing) {
          await env.DB.prepare("UPDATE push_subscriptions SET staff_id = ?, p256dh = ?, auth = ? WHERE id = ?")
            .bind(request._staff.id, sub.keys.p256dh, sub.keys.auth, existing.id).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO push_subscriptions (id, staff_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), request._staff.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()).run();
        }
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/push/unsubscribe") {
        const body = await readJsonBody(request);
        if (body.endpoint) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND staff_id = ?").bind(body.endpoint, request._staff.id).run();
        }
        return json({ ok: true });
      }

      // ---- Staff directory: any signed-in user can read names/departments ----
      if (method === "GET" && p === "/api/staff") {
        const rows = await env.DB.prepare("SELECT * FROM staff ORDER BY name").all();
        return json({ staff: rows.results.map(rowToStaff) });
      }

      // ---- Self-service profile setup: any signed-in user can edit their own name/PIN ----
      if (method === "PATCH" && p === "/api/profile") {
        const id = request._staff.id;
        const body = await readJsonBody(request);
        if (typeof body.name === "string" && body.name.trim()) {
          await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
        }
        if (typeof body.statusLine === "string") {
          const statusLine = body.statusLine.trim().slice(0, 60);
          await env.DB.prepare("UPDATE staff SET status_line = ? WHERE id = ?").bind(statusLine || null, id).run();
        }
        if (typeof body.phone === "string") {
          const phone = body.phone.trim().slice(0, 30);
          await env.DB.prepare("UPDATE staff SET phone = ? WHERE id = ?").bind(phone || null, id).run();
        }
        if (typeof body.pin === "string" && body.pin) {
          if (!PIN_RE.test(body.pin)) return json({ error: "PIN must be 4-6 digits" }, 400);
          const currentPin = typeof body.currentPin === "string" ? body.currentPin : "";
          const existing = await env.DB.prepare("SELECT pin_hash, pin_salt FROM staff WHERE id = ?").bind(id).first();
          if (!existing || (await hashPin(currentPin, existing.pin_salt)) !== existing.pin_hash) {
            return json({ error: "Current PIN is incorrect" }, 400);
          }
          const salt = randomSaltHex();
          await env.DB.prepare("UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?").bind(await hashPin(body.pin, salt), salt, id).run();
        }
        await env.DB.prepare("UPDATE staff SET profile_complete = 1 WHERE id = ?").bind(id).run();
        const row = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
        return json({ staff: rowToStaff(row) });
      }

      // ---- Staff management (admin only beyond this point) ----
      if (p === "/api/staff" || p.startsWith("/api/staff/")) {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);

        if (method === "POST" && p === "/api/staff") {
          const body = await readJsonBody(request);
          const name = String(body.name || "").trim();
          const pin = String(body.pin || "");
          const departmentId = body.departmentId;
          if (!name || !PIN_RE.test(pin)) return json({ error: "Name and a 4-6 digit PIN are required" }, 400);
          if (!DEPT_IDS.has(departmentId)) return json({ error: "Unknown department" }, 400);
          const salt = randomSaltHex();
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(id, name, departmentId, await hashPin(pin, salt), salt, body.isAdmin ? 1 : 0, new Date().toISOString()).run();
          const row = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
          return json({ staff: rowToStaff(row) }, 201);
        }

        if (method === "PATCH" && p.startsWith("/api/staff/")) {
          const id = decodeURIComponent(p.slice("/api/staff/".length));
          const existing = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
          if (!existing) return json({ error: "Staff not found" }, 404);
          const body = await readJsonBody(request);
          if (typeof body.name === "string" && body.name.trim()) {
            await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
          }
          if (body.departmentId) {
            if (!DEPT_IDS.has(body.departmentId)) return json({ error: "Unknown department" }, 400);
            await env.DB.prepare("UPDATE staff SET department_id = ? WHERE id = ?").bind(body.departmentId, id).run();
          }
          if (typeof body.isAdmin === "boolean") {
            await env.DB.prepare("UPDATE staff SET is_admin = ? WHERE id = ?").bind(body.isAdmin ? 1 : 0, id).run();
          }
          if (typeof body.pin === "string" && body.pin) {
            if (!PIN_RE.test(body.pin)) return json({ error: "PIN must be 4-6 digits" }, 400);
            const salt = randomSaltHex();
            await env.DB.prepare("UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?").bind(await hashPin(body.pin, salt), salt, id).run();
          }
          const row = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first();
          return json({ staff: rowToStaff(row) });
        }

        if (method === "DELETE" && p.startsWith("/api/staff/")) {
          const id = decodeURIComponent(p.slice("/api/staff/".length));
          if (id === requester.id) return json({ error: "You can't delete your own account" }, 400);
          await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM staff WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }
      }

      // ---- Departments ----
      if (method === "GET" && p === "/api/departments") {
        const rows = await env.DB.prepare("SELECT * FROM departments ORDER BY name").all();
        return json({ departments: rows.results.map(rowToDepartment) });
      }

      if (method === "PATCH" && p.startsWith("/api/departments/")) {
        const id = decodeURIComponent(p.slice("/api/departments/".length));
        if (!DEPT_IDS.has(id)) return json({ error: "Unknown department" }, 404);
        const body = await readJsonBody(request);
        if (typeof body.onDuty === "boolean") {
          if (request._staff.department_id !== id && !request._staff.is_admin) {
            return json({ error: "You can only change your own department's duty status" }, 403);
          }
          await env.DB.prepare("UPDATE departments SET on_duty = ? WHERE id = ?").bind(body.onDuty ? 1 : 0, id).run();
        }
        if (typeof body.contactName === "string") {
          if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
          await env.DB.prepare("UPDATE departments SET contact_name = ? WHERE id = ?").bind(body.contactName.trim() || null, id).run();
        }
        const row = await env.DB.prepare("SELECT * FROM departments WHERE id = ?").bind(id).first();
        return json({ department: rowToDepartment(row) });
      }

      if (method === "POST" && p.startsWith("/api/departments/") && p.endsWith("/photo")) {
        const id = decodeURIComponent(p.slice("/api/departments/".length, -"/photo".length));
        if (!DEPT_IDS.has(id)) return json({ error: "Unknown department" }, 404);
        const requester = request._staff;
        if (requester.department_id !== id && !requester.is_admin) return json({ error: "You can only change your own department's photo" }, 403);
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Photo is required" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (bytes.length > 8 * 1024 * 1024) return json({ error: "Photo is too large (8MB max)" }, 400);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = "dept-" + id + "-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        await env.DB.prepare("UPDATE departments SET photo_path = ? WHERE id = ?").bind(safeName, id).run();
        const row = await env.DB.prepare("SELECT * FROM departments WHERE id = ?").bind(id).first();
        return json({ department: rowToDepartment(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/departments/") && p.endsWith("/photo")) {
        const id = decodeURIComponent(p.slice("/api/departments/".length, -"/photo".length));
        if (!DEPT_IDS.has(id)) return json({ error: "Unknown department" }, 404);
        const requester = request._staff;
        if (requester.department_id !== id && !requester.is_admin) return json({ error: "You can only change your own department's photo" }, 403);
        await env.DB.prepare("UPDATE departments SET photo_path = NULL WHERE id = ?").bind(id).run();
        const row = await env.DB.prepare("SELECT * FROM departments WHERE id = ?").bind(id).first();
        return json({ department: rowToDepartment(row) });
      }

      // ---- Conversations ----
      if (method === "GET" && p === "/api/conversations") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const others = Array.from(DEPT_IDS).filter((id) => id !== self);
        const conversations = [];
        for (const other of others) {
          const last = await env.DB.prepare(
            `SELECT * FROM messages WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?) ORDER BY created_at DESC LIMIT 1`
          ).bind(self, other, other, self).first();
          const unread = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM messages WHERE to_dept = ? AND from_dept = ? AND status != 'read'`
          ).bind(self, other).first();
          const urgentUnread = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM messages WHERE to_dept = ? AND from_dept = ? AND status != 'read' AND urgent = 1`
          ).bind(self, other).first();
          conversations.push({
            departmentId: other,
            lastMessage: last ? rowToMessage(last, self, request._staff.is_admin) : null,
            unreadCount: unread.n,
            hasUrgentUnread: urgentUnread.n > 0,
          });
        }
        return json({ conversations });
      }

      // ---- Messages ----
      if (method === "GET" && p === "/api/messages") {
        const self = url.searchParams.get("self");
        const other = url.searchParams.get("with");
        if (!DEPT_IDS.has(self) || !DEPT_IDS.has(other)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const rows = await env.DB.prepare(
          `SELECT * FROM messages WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?) ORDER BY created_at ASC`
        ).bind(self, other, other, self).all();
        return json({ messages: rows.results.map((r) => rowToMessage(r, self, request._staff.is_admin)).filter(Boolean) });
      }

      // ---- Groups ----
      if (method === "GET" && p === "/api/groups") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const groupRows = await env.DB.prepare("SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY created_at DESC").all();
        const groups = [];
        for (const g of groupRows.results) {
          const memberRows = await env.DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(g.id).all();
          const members = memberRows.results.map((m) => m.department_id);
          const isMember = members.includes(self);
          if (g.archived_at && !request._staff.is_admin && !g.shared_at) continue;
          const last = await env.DB.prepare("SELECT * FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").bind(g.id).first();
          const readRow = await env.DB.prepare("SELECT last_read_at FROM group_reads WHERE group_id = ? AND department_id = ?").bind(g.id, self).first();
          const since = readRow ? readRow.last_read_at : "1970-01-01T00:00:00.000Z";
          const unread = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND from_dept != ? AND created_at > ? AND deleted_at IS NULL"
          ).bind(g.id, self, since).first();
          groups.push({
            id: g.id, name: g.name, createdBy: g.created_by, createdAt: g.created_at,
            archivedAt: g.archived_at || undefined, sharedAt: g.shared_at || undefined,
            description: g.description || undefined, eventDate: g.event_date || undefined,
            guestCount: g.guest_count === null || g.guest_count === undefined ? undefined : g.guest_count,
            location: g.location || undefined,
            members, isMember,
            lastMessage: last ? rowToMessage(last, self, request._staff.is_admin) : null,
            unreadCount: isMember ? unread.n : 0,
          });
        }
        return json({ groups });
      }

      if (method === "POST" && p === "/api/groups") {
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "Group name is required" }, 400);
        const memberIds = Array.isArray(body.memberDepartmentIds) ? body.memberDepartmentIds.filter((d) => DEPT_IDS.has(d)) : [];
        const allMembers = Array.from(new Set([self, ...memberIds]));
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, name, self, now).run();
        for (const deptId of allMembers) {
          await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)").bind(id, deptId, now).run();
        }
        const row = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        return json({ group: rowToGroup(row, allMembers) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/groups/") && p.split("/").length === 4) {
        const id = decodeURIComponent(p.slice("/api/groups/".length));
        const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (group.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can edit its details" }, 403);
        }
        const body = await readJsonBody(request);
        if (typeof body.description === "string") {
          await env.DB.prepare("UPDATE groups SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 400) || null, id).run();
        }
        if (typeof body.eventDate === "string" || body.eventDate === null) {
          await env.DB.prepare("UPDATE groups SET event_date = ? WHERE id = ?").bind(body.eventDate ? String(body.eventDate).trim().slice(0, 60) : null, id).run();
        }
        if (typeof body.guestCount === "number" || body.guestCount === null) {
          const gc = body.guestCount === null ? null : Math.max(0, Math.round(body.guestCount));
          await env.DB.prepare("UPDATE groups SET guest_count = ? WHERE id = ?").bind(gc, id).run();
        }
        if (typeof body.location === "string" || body.location === null) {
          await env.DB.prepare("UPDATE groups SET location = ? WHERE id = ?").bind(body.location ? String(body.location).trim().slice(0, 120) : null, id).run();
        }
        const memberRows = await env.DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(id).all();
        const row2 = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        return json({ group: rowToGroup(row2, memberRows.results.map((m) => m.department_id)) });
      }

      // ---- Event stations (drag-a-department-icon-in role assignments) ----
      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/stations")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/stations".length));
        const rows = await env.DB.prepare("SELECT * FROM event_stations WHERE group_id = ? ORDER BY position ASC, created_at ASC").bind(id).all();
        return json({ stations: rows.results.map(rowToStation) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/stations")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/stations".length));
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (group.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can add stations" }, 403);
        }
        const body = await readJsonBody(request);
        const title = String(body.title || "").trim();
        if (!title) return json({ error: "Station title is required" }, 400);
        if (title.length > 80) return json({ error: "Station title is too long" }, 400);
        const category = body.category ? String(body.category).trim().slice(0, 60) : null;
        const description = body.description ? String(body.description).trim().slice(0, 200) : null;
        const icon = body.icon ? String(body.icon).trim().slice(0, 30) : null;
        const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_stations WHERE group_id = ?").bind(id).first();
        const stationId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO event_stations (id, group_id, title, category, description, icon, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(stationId, id, title, category, description, icon, posRow.maxPos + 1, new Date().toISOString()).run();
        const row = await env.DB.prepare("SELECT * FROM event_stations WHERE id = ?").bind(stationId).first();
        return json({ station: rowToStation(row) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/stations/")) {
        const id = decodeURIComponent(p.slice("/api/stations/".length));
        const station = await env.DB.prepare("SELECT * FROM event_stations WHERE id = ?").bind(id).first();
        if (!station) return json({ error: "Station not found" }, 404);
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(station.group_id).first();
        const requester = request._staff;
        const canManage = group && (group.created_by === requester.department_id || requester.is_admin);
        const body = await readJsonBody(request);

        if (typeof body.assignedDeptId !== "undefined") {
          if (!canManage) return json({ error: "Only the department that created this event can assign stations" }, 403);
          if (body.assignedDeptId !== null && !DEPT_IDS.has(body.assignedDeptId)) return json({ error: "Unknown department" }, 400);
          await env.DB.prepare("UPDATE event_stations SET assigned_dept_id = ?, confirmed_at = NULL WHERE id = ?").bind(body.assignedDeptId || null, id).run();
        }
        if (body.confirm === true) {
          if (station.assigned_dept_id !== requester.department_id && !requester.is_admin) {
            return json({ error: "Only the assigned department can confirm this station" }, 403);
          }
          await env.DB.prepare("UPDATE event_stations SET confirmed_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        }
        if (typeof body.title === "string" || typeof body.category === "string" || typeof body.description === "string") {
          if (!canManage) return json({ error: "Only the department that created this event can edit stations" }, 403);
          if (typeof body.title === "string") {
            const title = body.title.trim();
            if (!title) return json({ error: "Station title is required" }, 400);
            await env.DB.prepare("UPDATE event_stations SET title = ? WHERE id = ?").bind(title.slice(0, 80), id).run();
          }
          if (typeof body.category === "string") {
            await env.DB.prepare("UPDATE event_stations SET category = ? WHERE id = ?").bind(body.category.trim().slice(0, 60) || null, id).run();
          }
          if (typeof body.description === "string") {
            await env.DB.prepare("UPDATE event_stations SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 200) || null, id).run();
          }
        }
        const row = await env.DB.prepare("SELECT * FROM event_stations WHERE id = ?").bind(id).first();
        return json({ station: rowToStation(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/stations/")) {
        const id = decodeURIComponent(p.slice("/api/stations/".length));
        const station = await env.DB.prepare("SELECT group_id FROM event_stations WHERE id = ?").bind(id).first();
        if (!station) return json({ error: "Station not found" }, 404);
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(station.group_id).first();
        const requester = request._staff;
        if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can remove stations" }, 403);
        }
        await env.DB.prepare("DELETE FROM event_stations WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---- Event run sheet ----
      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/runsheet")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/runsheet".length));
        const rows = await env.DB.prepare("SELECT * FROM event_runsheet_items WHERE group_id = ? ORDER BY position ASC, created_at ASC").bind(id).all();
        return json({ items: rows.results.map(rowToRunsheetItem) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/runsheet")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/runsheet".length));
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (group.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can edit the run sheet" }, 403);
        }
        const body = await readJsonBody(request);
        const timeLabel = String(body.timeLabel || "").trim();
        const title = String(body.title || "").trim();
        if (!timeLabel) return json({ error: "A time is required" }, 400);
        if (!title) return json({ error: "A title is required" }, 400);
        if (timeLabel.length > 20) return json({ error: "Time is too long" }, 400);
        if (title.length > 100) return json({ error: "Title is too long" }, 400);
        const description = body.description ? String(body.description).trim().slice(0, 300) : null;
        const teamLabel = body.teamLabel ? String(body.teamLabel).trim().slice(0, 60) : null;
        const posRow = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_runsheet_items WHERE group_id = ?").bind(id).first();
        const itemId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO event_runsheet_items (id, group_id, time_label, title, description, team_label, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(itemId, id, timeLabel, title, description, teamLabel, posRow.maxPos + 1, new Date().toISOString()).run();
        const row = await env.DB.prepare("SELECT * FROM event_runsheet_items WHERE id = ?").bind(itemId).first();
        return json({ item: rowToRunsheetItem(row) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/runsheet/")) {
        const id = decodeURIComponent(p.slice("/api/runsheet/".length));
        const item = await env.DB.prepare("SELECT * FROM event_runsheet_items WHERE id = ?").bind(id).first();
        if (!item) return json({ error: "Run sheet item not found" }, 404);
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(item.group_id).first();
        const requester = request._staff;
        if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can edit the run sheet" }, 403);
        }
        const body = await readJsonBody(request);
        if (typeof body.timeLabel === "string" && body.timeLabel.trim()) {
          await env.DB.prepare("UPDATE event_runsheet_items SET time_label = ? WHERE id = ?").bind(body.timeLabel.trim().slice(0, 20), id).run();
        }
        if (typeof body.title === "string" && body.title.trim()) {
          await env.DB.prepare("UPDATE event_runsheet_items SET title = ? WHERE id = ?").bind(body.title.trim().slice(0, 100), id).run();
        }
        if (typeof body.description === "string") {
          await env.DB.prepare("UPDATE event_runsheet_items SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 300) || null, id).run();
        }
        if (typeof body.teamLabel === "string") {
          await env.DB.prepare("UPDATE event_runsheet_items SET team_label = ? WHERE id = ?").bind(body.teamLabel.trim().slice(0, 60) || null, id).run();
        }
        const row = await env.DB.prepare("SELECT * FROM event_runsheet_items WHERE id = ?").bind(id).first();
        return json({ item: rowToRunsheetItem(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/runsheet/")) {
        const id = decodeURIComponent(p.slice("/api/runsheet/".length));
        const item = await env.DB.prepare("SELECT group_id FROM event_runsheet_items WHERE id = ?").bind(id).first();
        if (!item) return json({ error: "Run sheet item not found" }, 404);
        const group = await env.DB.prepare("SELECT created_by FROM groups WHERE id = ?").bind(item.group_id).first();
        const requester = request._staff;
        if (!group || (group.created_by !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can edit the run sheet" }, 403);
        }
        await env.DB.prepare("DELETE FROM event_runsheet_items WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/join")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/join".length));
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Group not found" }, 404);
        const existingMember = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, self).first();
        await env.DB.prepare("INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)").bind(id, self, new Date().toISOString()).run();
        if (!existingMember) {
          const requester = request._staff;
          const actorId = requester.department_id;
          const joinerName = DEPT_NAMES[self] || self;
          const actorName = DEPT_NAMES[actorId] || actorId;
          const noticeBody = actorId === self ? (joinerName + " joined the event") : (actorName + " added " + joinerName + " to the event");
          await insertMessage(env, ctx, { from: actorId, groupId: id, type: "text", body: noticeBody });
        }
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/leave")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/leave".length));
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        await env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, self).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/groups/")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length));
        const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (group.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can delete it" }, 403);
        }
        const msgCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?").bind(id).first();
        if (msgCount.n > 0) {
          return json({ error: "This event already has messages in it and can't be deleted. End it instead." }, 400);
        }
        await env.DB.prepare("UPDATE groups SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/archive")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/archive".length));
        const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        if (group.archived_at) return json({ error: "This event has already ended" }, 400);
        const requester = request._staff;
        if (group.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can end it" }, 403);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE groups SET archived_at = ? WHERE id = ?").bind(now, id).run();
        const actorName = DEPT_NAMES[requester.department_id] || requester.department_id;
        await insertMessage(env, ctx, {
          from: requester.department_id, groupId: id, type: "text",
          body: actorName + " ended this event. It's kept here for training.",
          silent: true,
        });
        const row = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        return json({ group: rowToGroup(row) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/share")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/share".length));
        const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        if (!group.archived_at) return json({ error: "End the event before sharing it" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE groups SET shared_at = ? WHERE id = ?").bind(now, id).run();
        const actorName = DEPT_NAMES[requester.department_id] || requester.department_id;
        await insertMessage(env, ctx, {
          from: requester.department_id, groupId: id, type: "text",
          silent: true,
          body: actorName + " shared this event with every department.",
        });
        const shareNotify = Promise.all(
          Array.from(DEPT_IDS).filter((d) => d !== requester.department_id).map((deptId) => notifyDepartment(env, deptId, {
            title: actorName,
            body: "Shared the event “" + group.name + "” for you to look back through",
            url: "/",
            tag: "hotel-ping-group-" + id,
          }, requester.department_id))
        ).catch((e) => console.error("notifyDepartment (share) top-level error:", e && e.stack || e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(shareNotify); else await shareNotify;
        const row2 = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        return json({ group: rowToGroup(row2) });
      }

      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/messages")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/messages".length));
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const group = await env.DB.prepare("SELECT archived_at, shared_at FROM groups WHERE id = ?").bind(id).first();
        if (!request._staff.is_admin) {
          if (group && group.archived_at) {
            if (!group.shared_at) return json({ error: "This event has ended and is only visible to the General Manager" }, 403);
          } else {
            const member = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, self).first();
            if (!member) return json({ error: "Not a member of this group" }, 403);
          }
        }
        const rows = await env.DB.prepare("SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC").bind(id).all();
        return json({ messages: rows.results.map((r) => rowToMessage(r, self, request._staff.is_admin)).filter(Boolean) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/read")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/read".length));
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO group_reads (group_id, department_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(group_id, department_id) DO UPDATE SET last_read_at = excluded.last_read_at"
        ).bind(id, self, now).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/feed") {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 200);
        const rows = await env.DB.prepare(
          `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`
        ).bind(limit).all();
        return json({ messages: rows.results.map((r) => rowToMessage(r, r.from_dept, true)).filter(Boolean) });
      }

      if (method === "POST" && p === "/api/messages/read") {
        const body = await readJsonBody(request);
        if (!DEPT_IDS.has(body.self) || !DEPT_IDS.has(body.with)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, body.self)) return json({ error: "You can only mark your own department's messages as read" }, 403);
        await env.DB.prepare(`UPDATE messages SET status = 'read', read_at = ? WHERE to_dept = ? AND from_dept = ? AND status != 'read'`).bind(new Date().toISOString(), body.self, body.with).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/response-times") {
        const requester = request._staff;
        const mine = url.searchParams.get("mine") === "1";
        if (!mine && !requester.is_admin) return json({ error: "Admin access required" }, 403);
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        let query = `SELECT to_dept, AVG((julianday(read_at) - julianday(created_at)) * 86400) AS avg_seconds, COUNT(*) AS n
           FROM messages
           WHERE urgent = 1 AND read_at IS NOT NULL AND deleted_at IS NULL AND created_at > ?`;
        const params = [cutoff];
        if (mine) { query += " AND to_dept = ?"; params.push(requester.department_id); }
        query += " GROUP BY to_dept";
        const rows = await env.DB.prepare(query).bind(...params).all();
        return json({ departments: rows.results.map((r) => ({ deptId: r.to_dept, avgSeconds: r.avg_seconds, count: r.n })) });
      }

      if (method === "GET" && p === "/api/missed") {
        const dept = request._staff.department_id;
        const items = [];

        const msgRows = await env.DB.prepare(
          "SELECT * FROM messages WHERE to_dept = ? AND status != 'read' AND deleted_at IS NULL AND (signoff_status IS NULL OR signoff_status != 'pending') ORDER BY created_at ASC"
        ).bind(dept).all();
        for (const m of msgRows.results) {
          items.push({ kind: "message", id: m.id, createdAt: m.created_at, message: rowToMessage(m, dept, false) });
        }

        // Pending sign-off requests stay in "needs a decision" regardless of read
        // status - opening the thread to look at one shouldn't make it disappear
        // from view before it's actually been approved or declined.
        const pendingSignoffRows = await env.DB.prepare(
          "SELECT * FROM messages WHERE to_dept = ? AND signoff_status = 'pending' AND deleted_at IS NULL ORDER BY created_at ASC"
        ).bind(dept).all();
        for (const m of pendingSignoffRows.results) {
          items.push({ kind: "approval", id: m.id, createdAt: m.created_at, message: rowToMessage(m, dept, false) });
        }

        if (dept === "maintenance") {
          const ticketRows = await env.DB.prepare(
            "SELECT * FROM maintenance_tickets WHERE status != 'fixed' ORDER BY created_at ASC"
          ).all();
          for (const t of ticketRows.results) {
            items.push({ kind: "ticket", id: t.id, createdAt: t.created_at, ticket: rowToTicket(t) });
          }
        }

        if (dept === "concierge") {
          const reqRows = await env.DB.prepare(
            "SELECT * FROM guest_requests WHERE status = 'new' ORDER BY created_at ASC"
          ).all();
          for (const r of reqRows.results) {
            items.push({ kind: "guestRequest", id: r.id, createdAt: r.created_at, request: rowToGuestRequest(r) });
          }
        }

        items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return json({ items });
      }

      // ---- Blockers (cross-department "waiting on") ----
      if (method === "GET" && p === "/api/blockers") {
        const rows = await env.DB.prepare(
          "SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC"
        ).all();
        return json({ blockers: rows.results.map(rowToBlocker) });
      }

      if (method === "POST" && p === "/api/blockers") {
        const body = await readJsonBody(request);
        const waitingOn = String(body.waitingOn || "").trim();
        if (!waitingOn) return json({ error: "Say what you're waiting on" }, 400);
        const reason = body.reason ? String(body.reason).trim().slice(0, 200) : null;
        const requester = request._staff;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO blockers (id, department_id, waiting_on, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, requester.department_id, waitingOn, reason, requester.department_id, now).run();
        const row = await env.DB.prepare("SELECT * FROM blockers WHERE id = ?").bind(id).first();
        return json({ blocker: rowToBlocker(row) });
      }

      if (method === "POST" && p.startsWith("/api/blockers/") && p.endsWith("/resolve")) {
        const id = decodeURIComponent(p.slice("/api/blockers/".length, -"/resolve".length));
        const existing = await env.DB.prepare("SELECT * FROM blockers WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Blocker not found" }, 404);
        const requester = request._staff;
        if (existing.department_id !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that reported this can clear it" }, 403);
        }
        await env.DB.prepare("UPDATE blockers SET resolved_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      // ---- Ops overview (admin): escalations, blocker chains, ownership, exceptions ----
      if (method === "GET" && p === "/api/ops-overview") {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);

        const escalatedMsgRows = await env.DB.prepare(
          "SELECT * FROM messages WHERE escalation_level > 0 AND status != 'read' AND deleted_at IS NULL ORDER BY escalation_level DESC, created_at ASC"
        ).all();
        const escalatedTicketRows = await env.DB.prepare(
          "SELECT * FROM maintenance_tickets WHERE escalation_level > 0 AND status = 'reported' ORDER BY escalation_level DESC, created_at ASC"
        ).all();

        const unownedTicketRows = await env.DB.prepare(
          "SELECT * FROM maintenance_tickets WHERE status != 'fixed' AND owner_staff_id IS NULL ORDER BY created_at ASC"
        ).all();

        const blockerRows = await env.DB.prepare(
          "SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC"
        ).all();
        const blockers = blockerRows.results.map(rowToBlocker);
        // Chain detection: follow department_id -> waitingOn links as far as they go.
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

        const openTicketCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM maintenance_tickets WHERE status != 'fixed'").first();
        const openGuestCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE status != 'completed'").first();

        return json({
          escalatedMessages: escalatedMsgRows.results.map((r) => rowToMessage(r, r.to_dept, true)),
          escalatedTickets: escalatedTicketRows.results.map(rowToTicket),
          unownedTickets: unownedTicketRows.results.map(rowToTicket),
          blockerChains: chains,
          allBlockers: blockers,
          exceptions: {
            openTickets: openTicketCount.n,
            openGuestRequests: openGuestCount.n,
          },
        });
      }

      if (method === "POST" && p === "/api/messages") {
        const body = await readJsonBody(request);
        const { from, to, groupId, type, text, urgent, affectsGuest, fileName, fileBase64, fileMime, duration, transcript, replyToId, roomNumber, taskStatus, mentions, signoff, poll } = body;
        if (!DEPT_IDS.has(from)) return json({ error: "Unknown department" }, 400);
        if (from !== request._staff.department_id) return json({ error: "You can only send messages as your own department" }, 403);
        let validMembers = null;
        if (groupId) {
          const group = await env.DB.prepare("SELECT archived_at FROM groups WHERE id = ?").bind(groupId).first();
          if (group && group.archived_at) return json({ error: "This event has ended and is now read only" }, 400);
          const memberRows = await env.DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(groupId).all();
          validMembers = new Set(memberRows.results.map((m) => m.department_id));
          if (!validMembers.has(from)) return json({ error: "Not a member of this group" }, 403);
        } else if (!DEPT_IDS.has(to)) {
          return json({ error: "Unknown department" }, 400);
        }
        if (!["text", "image", "file", "audio"].includes(type)) return json({ error: "Invalid message type" }, 400);
        if (type === "text" && !(text && text.trim()) && !poll) return json({ error: "Message text is required" }, 400);
        if (roomNumber && String(roomNumber).length > 20) return json({ error: "Room number is too long" }, 400);
        if (taskStatus && !TASK_STATUSES.includes(taskStatus)) return json({ error: "Invalid task status" }, 400);
        let signoffData = null;
        if (signoff) {
          if (groupId) return json({ error: "Sign-off requests can't be sent in event groups" }, 400);
          const title = String(signoff.title || "").trim();
          if (!title) return json({ error: "Sign-off title is required" }, 400);
          if (title.length > 120) return json({ error: "Sign-off title is too long" }, 400);
          let amount = null;
          if (signoff.amount !== undefined && signoff.amount !== null && signoff.amount !== "") {
            amount = Number(signoff.amount);
            if (!Number.isFinite(amount) || amount < 0) return json({ error: "Invalid sign-off amount" }, 400);
          }
          const target = signoff.target ? String(signoff.target).trim().slice(0, 120) : null;
          const category = signoff.category ? String(signoff.category).trim().slice(0, 60) : null;
          const guestInfo = signoff.guestInfo ? String(signoff.guestInfo).trim().slice(0, 120) : null;
          signoffData = { title, amount, target, category, guestInfo };
        }
        let pollData = null;
        if (poll) {
          const question = String(poll.question || "").trim();
          if (!question) return json({ error: "Poll question is required" }, 400);
          if (question.length > 140) return json({ error: "Poll question is too long" }, 400);
          const options = Array.isArray(poll.options)
            ? poll.options.map((o) => String(o || "").trim()).filter(Boolean)
            : [];
          if (options.length < 2 || options.length > 4) return json({ error: "A poll needs 2-4 options" }, 400);
          if (options.some((o) => o.length > 60)) return json({ error: "Poll option is too long" }, 400);
          pollData = { question, options };
        }
        const validMentions = Array.isArray(mentions) && validMembers
          ? mentions.filter((d) => validMembers.has(d) && d !== from)
          : [];

        let filePathOnDisk = null;
        let fileSize = null;
        if (fileBase64) {
          const binary = atob(fileBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          if (bytes.length > 25 * 1024 * 1024) return json({ error: "File is too large (25MB max)" }, 400);
          const ext = fileMime && fileMime.split("/")[1] ? "." + fileMime.split("/")[1].split(";")[0] : "";
          const safeName = crypto.randomUUID() + ext;
          await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: fileMime || "application/octet-stream" } });
          filePathOnDisk = safeName;
          fileSize = bytes.length;
        }

        const row = await insertMessage(env, ctx, {
          from, to: groupId ? null : to, groupId: groupId || null, type,
          body: text && text.trim() ? text.trim() : null,
          fileName: fileName || null, filePath: filePathOnDisk, fileSize,
          duration: duration || null, transcript: transcript && transcript.trim() ? transcript.trim() : null,
          urgent: !!urgent,
          affectsGuest: !!affectsGuest,
          replyToId: replyToId || null,
          roomNumber: roomNumber ? String(roomNumber).trim() : null,
          taskStatus: taskStatus || null,
          mentions: validMentions,
          signoff: signoffData,
          poll: pollData,
        });

        return json({ message: rowToMessage(row, from, false) }, 201);
      }

      if (method === "DELETE" && p.startsWith("/api/messages/")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        if (existing.from_dept !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only delete your own department's messages" }, 403);
        }
        await env.DB.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, existing.from_dept, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/edit")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/edit".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        if (existing.from_dept !== requester.department_id) return json({ error: "You can only edit your own messages" }, 403);
        if (existing.deleted_at) return json({ error: "Can't edit a deleted message" }, 400);
        if (existing.type !== "text") return json({ error: "Only text messages can be edited" }, 400);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "Message text is required" }, 400);
        await env.DB.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").bind(text, new Date().toISOString(), id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/pin")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/pin".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, requester.department_id).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextPinned = !existing.pinned_at;
        await env.DB.prepare("UPDATE messages SET pinned_at = ? WHERE id = ?").bind(nextPinned ? new Date().toISOString() : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/affects-guest")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/affects-guest".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, requester.department_id).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextValue = existing.affects_guest ? 0 : 1;
        await env.DB.prepare("UPDATE messages SET affects_guest = ? WHERE id = ?").bind(nextValue, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/complete")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/complete".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, requester.department_id).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextCompleted = !existing.completed_at;
        await env.DB.prepare("UPDATE messages SET completed_at = ?, completed_by = ? WHERE id = ?")
          .bind(nextCompleted ? new Date().toISOString() : null, nextCompleted ? requester.department_id : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/task-status")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/task-status".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        if (!existing.task_status) return json({ error: "This message isn't tagged as a task" }, 400);
        const requester = request._staff;
        if (existing.to_dept !== requester.department_id) return json({ error: "Only the department this task was sent to can update it" }, 403);
        const bodyIn = await readJsonBody(request);
        if (!TASK_STATUSES.includes(bodyIn.status)) return json({ error: "Invalid task status" }, 400);
        await env.DB.prepare("UPDATE messages SET task_status = ? WHERE id = ?").bind(bodyIn.status, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (bodyIn.status === "in_progress" || bodyIn.status === "completed") {
          const verb = bodyIn.status === "in_progress" ? "Accepted" : "Completed";
          const taskPreview = existing.body ? ': "' + existing.body + '"' : "";
          await insertMessage(env, ctx, {
            from: existing.to_dept, to: existing.from_dept, type: "text",
            body: verb + " task" + taskPreview,
          });
        }
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/signoff-decision")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/signoff-decision".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        if (!existing.signoff_status) return json({ error: "This message isn't a sign-off request" }, 400);
        const requester = request._staff;
        if (existing.to_dept !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department this was sent to can decide" }, 403);
        }
        if (existing.signoff_status !== "pending") return json({ error: "This request has already been decided" }, 400);
        const bodyIn = await readJsonBody(request);
        if (!["approved", "declined"].includes(bodyIn.decision)) return json({ error: "Invalid decision" }, 400);
        const now = new Date().toISOString();
        const decisionResult = await env.DB.prepare(
          "UPDATE messages SET signoff_status = ?, signoff_decided_by = ?, signoff_decided_at = ? WHERE id = ? AND signoff_status = 'pending'"
        ).bind(bodyIn.decision, requester.name, now, id).run();
        if (!decisionResult.meta || decisionResult.meta.changes === 0) {
          return json({ error: "This request has already been decided" }, 400);
        }
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        const verb = bodyIn.decision === "approved" ? "Approved" : "Declined";
        // The decision lives on the original request (signoff_status/decided_by/decided_at) -
        // one message is the whole record, so it stays intact as proof. Notify by push only,
        // not by sending a second chat message that would fragment the record in two.
        const notifyPromise = notifyDepartment(env, existing.from_dept, {
          title: verb + " sign-off",
          body: existing.signoff_title + (existing.signoff_amount != null ? " · £" + Number(existing.signoff_amount).toFixed(2) : ""),
          url: "/",
          tag: "hotel-ping-signoff-" + id,
        }, existing.to_dept).catch((e) => console.error("notifyDepartment (signoff) top-level error:", e && e.stack || e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/vote")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/vote".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        if (!existing.poll_question) return json({ error: "This message isn't a poll" }, 400);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, requester.department_id).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const bodyIn = await readJsonBody(request);
        const options = JSON.parse(existing.poll_options || "[]");
        const optionIndex = Number(bodyIn.optionIndex);
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
          return json({ error: "Invalid poll option" }, 400);
        }
        // Merge this one vote in with an atomic SQL json_set, rather than reading the whole
        // votes blob into JS and writing it back - two people voting at once would otherwise
        // race and one vote could silently overwrite the other.
        await env.DB.prepare(
          "UPDATE messages SET poll_votes = json_set(COALESCE(poll_votes, '{}'), '$.' || ?, ?) WHERE id = ?"
        ).bind(requester.department_id, optionIndex, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/forward")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/forward".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        if (existing.deleted_at) return json({ error: "Can't forward a deleted message" }, 400);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, requester.department_id).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const body = await readJsonBody(request);
        const to = body.to;
        if (!DEPT_IDS.has(to)) return json({ error: "Unknown department" }, 400);
        const row = await insertMessage(env, ctx, {
          from: requester.department_id, to, type: existing.type,
          body: existing.body, fileName: existing.file_name, filePath: existing.file_path, fileSize: existing.file_size,
          duration: existing.duration, transcript: existing.transcript, urgent: false,
        });
        return json({ message: rowToMessage(row, requester.department_id, false) }, 201);
      }

      if (method === "POST" && p === "/api/broadcast") {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "Message text is required" }, 400);
        const from = requester.department_id;
        const targets = Array.from(DEPT_IDS).filter((id) => id !== from);
        const broadcastId = crypto.randomUUID();
        const rows = [];
        for (const to of targets) {
          const row = await insertMessage(env, ctx, { from, to, type: "text", body: text, urgent: !!body.urgent, broadcastId });
          rows.push(row);
        }
        return json({ messages: rows.map((r) => rowToMessage(r, from, false)) }, 201);
      }

      if (method === "GET" && p.startsWith("/api/broadcast/") && p.endsWith("/status")) {
        const broadcastId = decodeURIComponent(p.slice("/api/broadcast/".length, -"/status".length));
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        const rows = await env.DB.prepare("SELECT to_dept, status FROM messages WHERE broadcast_id = ?").bind(broadcastId).all();
        const total = rows.results.length;
        const read = rows.results.filter((r) => r.status === "read").map((r) => r.to_dept);
        const unread = rows.results.filter((r) => r.status !== "read").map((r) => r.to_dept);
        return json({ total, readCount: read.length, read, unread });
      }

      if (method === "POST" && p === "/api/typing") {
        const body = await readJsonBody(request);
        const self = request._staff.department_id;
        if (!DEPT_IDS.has(body.to)) return json({ error: "Unknown department" }, 400);
        await env.DB.prepare(
          "INSERT INTO typing_status (from_dept, to_dept, updated_at) VALUES (?, ?, ?) ON CONFLICT(from_dept, to_dept) DO UPDATE SET updated_at = excluded.updated_at"
        ).bind(self, body.to, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/typing") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const cutoff = new Date(Date.now() - 6000).toISOString();
        const rows = await env.DB.prepare(
          "SELECT from_dept FROM typing_status WHERE to_dept = ? AND updated_at > ?"
        ).bind(self, cutoff).all();
        return json({ typing: rows.results.map((r) => r.from_dept) });
      }

      if (method === "GET" && p === "/api/muted") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's settings" }, 403);
        const rows = await env.DB.prepare("SELECT other_dept_id FROM muted_conversations WHERE department_id = ?").bind(self).all();
        return json({ muted: rows.results.map((r) => r.other_dept_id) });
      }

      if (method === "POST" && p === "/api/muted") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const other = body.with;
        if (!DEPT_IDS.has(other)) return json({ error: "Unknown department" }, 400);
        const self = requester.department_id;
        const existing = await env.DB.prepare(
          "SELECT 1 FROM muted_conversations WHERE department_id = ? AND other_dept_id = ?"
        ).bind(self, other).first();
        if (existing) {
          await env.DB.prepare("DELETE FROM muted_conversations WHERE department_id = ? AND other_dept_id = ?").bind(self, other).run();
          return json({ muted: false });
        }
        await env.DB.prepare(
          "INSERT INTO muted_conversations (department_id, other_dept_id, muted_at) VALUES (?, ?, ?)"
        ).bind(self, other, new Date().toISOString()).run();
        return json({ muted: true });
      }

      if (method === "GET" && p === "/api/quick-replies") {
        const dept = request._staff.department_id;
        let rows = await env.DB.prepare("SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC").bind(dept).all();
        if (rows.results.length === 0) {
          const now = new Date().toISOString();
          for (let i = 0; i < DEFAULT_QUICK_REPLIES.length; i++) {
            await env.DB.prepare(
              "INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(crypto.randomUUID(), dept, DEFAULT_QUICK_REPLIES[i], i, now).run();
          }
          rows = await env.DB.prepare("SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC").bind(dept).all();
        }
        return json({ replies: rows.results.map((r) => ({ id: r.id, text: r.text })) });
      }

      if (method === "POST" && p === "/api/quick-replies") {
        const dept = request._staff.department_id;
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim().slice(0, 24);
        if (!text) return json({ error: "Text is required" }, 400);
        const maxPos = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM quick_replies WHERE department_id = ?").bind(dept).first();
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, dept, text, maxPos.m + 1, new Date().toISOString()).run();
        return json({ reply: { id, text } }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/quick-replies/")) {
        const id = decodeURIComponent(p.slice("/api/quick-replies/".length));
        const dept = request._staff.department_id;
        const existing = await env.DB.prepare("SELECT 1 FROM quick_replies WHERE id = ? AND department_id = ?").bind(id, dept).first();
        if (!existing) return json({ error: "Not found" }, 404);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim().slice(0, 24);
        if (!text) return json({ error: "Text is required" }, 400);
        await env.DB.prepare("UPDATE quick_replies SET text = ? WHERE id = ?").bind(text, id).run();
        return json({ reply: { id, text } });
      }

      if (method === "DELETE" && p.startsWith("/api/quick-replies/")) {
        const id = decodeURIComponent(p.slice("/api/quick-replies/".length));
        const dept = request._staff.department_id;
        await env.DB.prepare("DELETE FROM quick_replies WHERE id = ? AND department_id = ?").bind(id, dept).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/stories") {
        const now = new Date().toISOString();
        await env.DB.prepare("DELETE FROM stories WHERE expires_at < ?").bind(now).run();
        const rows = await env.DB.prepare("SELECT * FROM stories WHERE expires_at >= ? ORDER BY created_at ASC").bind(now).all();
        const viewerDept = request._staff.department_id;
        const viewedRows = await env.DB.prepare("SELECT story_id FROM story_views WHERE department_id = ?").bind(viewerDept).all();
        const viewedIds = new Set(viewedRows.results.map((r) => r.story_id));
        return json({ stories: rows.results.map((r) => rowToStory(r, r.department_id === viewerDept || viewedIds.has(r.id))) });
      }

      if (method === "POST" && p === "/api/stories") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Photo is required" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (bytes.length > 10 * 1024 * 1024) return json({ error: "Photo is too large (10MB max)" }, 400);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = "story-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        const id = crypto.randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        const caption = body.caption ? String(body.caption).trim().slice(0, 200) : null;
        await env.DB.prepare(
          "INSERT INTO stories (id, department_id, staff_name, photo_path, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, requester.department_id, requester.name, safeName, caption, now.toISOString(), expiresAt).run();
        const row = await env.DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first();
        return json({ story: rowToStory(row, true) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/stories/") && p.endsWith("/view")) {
        const id = decodeURIComponent(p.slice("/api/stories/".length, -"/view".length));
        const story = await env.DB.prepare("SELECT 1 FROM stories WHERE id = ?").bind(id).first();
        if (!story) return json({ error: "Story not found" }, 404);
        const viewerDept = request._staff.department_id;
        await env.DB.prepare(
          "INSERT INTO story_views (story_id, department_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT(story_id, department_id) DO NOTHING"
        ).bind(id, viewerDept, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/stories/")) {
        const id = decodeURIComponent(p.slice("/api/stories/".length));
        const existing = await env.DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Story not found" }, 404);
        const requester = request._staff;
        if (existing.department_id !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only delete your own department's stories" }, 403);
        }
        await env.DB.prepare("DELETE FROM stories WHERE id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM story_views WHERE story_id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/handover") {
        const dept = url.searchParams.get("department");
        if (!DEPT_IDS.has(dept)) return json({ error: "Unknown department" }, 400);
        const requester = request._staff;
        if (dept !== requester.department_id && !requester.is_admin) {
          return json({ error: "Not part of this department" }, 403);
        }
        const rows = await env.DB.prepare(
          "SELECT * FROM handover_notes WHERE department_id = ? ORDER BY created_at DESC LIMIT 30"
        ).bind(dept).all();
        return json({ notes: rows.results.map(rowToHandoverNote) });
      }

      if (method === "POST" && p === "/api/handover") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const text = String(body.body || "").trim();
        if (!text) return json({ error: "Note text is required" }, 400);
        const dept = requester.department_id;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO handover_notes (id, department_id, staff_id, staff_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, dept, requester.id, requester.name, text, now).run();
        const row = await env.DB.prepare("SELECT * FROM handover_notes WHERE id = ?").bind(id).first();
        return json({ note: rowToHandoverNote(row) }, 201);
      }

      if (method === "DELETE" && p.startsWith("/api/handover/")) {
        const id = decodeURIComponent(p.slice("/api/handover/".length));
        const existing = await env.DB.prepare("SELECT * FROM handover_notes WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Note not found" }, 404);
        const requester = request._staff;
        if (existing.staff_id !== requester.id && !requester.is_admin) {
          return json({ error: "You can only remove your own notes" }, 403);
        }
        await env.DB.prepare("DELETE FROM handover_notes WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/maintenance") {
        const rows = await env.DB.prepare("SELECT * FROM maintenance_tickets ORDER BY created_at DESC").all();
        return json({ tickets: rows.results.map(rowToTicket) });
      }

      if (method === "POST" && p === "/api/maintenance") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const description = String(body.description || "").trim();
        if (!description) return json({ error: "A description is required" }, 400);
        const roomNumber = body.roomNumber ? String(body.roomNumber).trim() : null;
        if (roomNumber && roomNumber.length > 40) return json({ error: "Location is too long" }, 400);
        const priority = MAINT_PRIORITIES.includes(body.priority) ? body.priority : "problem";
        const guestPresent = !!body.guestPresent;
        let deadline = body.deadline ? String(body.deadline).trim() : null;
        if (deadline && !DEADLINE_RE.test(deadline)) deadline = null;

        if (roomNumber) {
          const dup = await env.DB.prepare(
            "SELECT * FROM maintenance_tickets WHERE status != 'fixed' AND LOWER(TRIM(room_number)) = LOWER(?) ORDER BY created_at DESC LIMIT 1"
          ).bind(roomNumber).first();
          if (dup) {
            const replyId = crypto.randomUUID();
            const now = new Date().toISOString();
            const noteText = "Also reported by " + (DEPT_NAMES[requester.department_id] || requester.department_id) + ": " + description;
            await env.DB.prepare(
              "INSERT INTO maintenance_replies (id, ticket_id, from_dept, body, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(replyId, dup.id, requester.department_id, noteText, now).run();

            const mergedPriority = MAINT_PRIORITY_RANK[priority] < MAINT_PRIORITY_RANK[dup.priority] ? priority : dup.priority;
            const mergedGuestPresent = guestPresent || !!dup.guest_present;
            const mergedDeadline = deadline && (!dup.deadline || deadline < dup.deadline) ? deadline : dup.deadline;
            if (mergedPriority !== dup.priority || mergedGuestPresent !== !!dup.guest_present || mergedDeadline !== dup.deadline) {
              await env.DB.prepare(
                "UPDATE maintenance_tickets SET priority = ?, guest_present = ?, deadline = ?, updated_at = ? WHERE id = ?"
              ).bind(mergedPriority, mergedGuestPresent ? 1 : 0, mergedDeadline, now, dup.id).run();
            }
            const mergedRow = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(dup.id).first();

            if (dup.created_by !== requester.department_id) {
              const notifyPromise = notifyDepartment(env, "maintenance", {
                title: "🔧 Same job reported again",
                body: noteText,
                url: "/",
                tag: "hotel-ping-maintenance-" + dup.id,
              }, requester.department_id).catch(function(e){ console.error("notifyDepartment (dup maintenance) error:", e && e.stack || e); });
              if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
            }
            return json({ ticket: rowToTicket(mergedRow), merged: true }, 200);
          }
        }

        let photoPath = null;
        if (body.photoBase64) {
          const binary = atob(body.photoBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          if (bytes.length > 60 * 1024 * 1024) return json({ error: "File is too large (60MB max)" }, 400);
          const ext = body.photoMime && body.photoMime.split("/")[1] ? "." + body.photoMime.split("/")[1].split(";")[0] : "";
          const safeName = crypto.randomUUID() + ext;
          await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.photoMime || "application/octet-stream" } });
          photoPath = safeName;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO maintenance_tickets (id, room_number, description, photo_path, status, priority, guest_present, deadline, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)"
        ).bind(id, roomNumber, description, photoPath, priority, guestPresent ? 1 : 0, deadline, requester.department_id, now, now).run();
        const row = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();

        let notifyBody = (roomNumber ? "Room " + roomNumber + ": " : "") + description;
        if (guestPresent) notifyBody += " · Guest in room";
        if (deadline) notifyBody += " · Needed by " + deadline;
        const notifyPromise = notifyDepartment(env, "maintenance", {
          title: priority === "safety" ? "🚨 Safety issue reported" : "🔧 New maintenance ticket",
          body: notifyBody,
          url: "/",
          tag: "hotel-ping-maintenance-" + id,
        }, requester.department_id).catch(function(e){ console.error("notifyDepartment (maintenance) error:", e && e.stack || e); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ ticket: rowToTicket(row) }, 201);
      }

      if (method === "GET" && p.startsWith("/api/maintenance/") && p.endsWith("/replies")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/replies".length));
        const rows = await env.DB.prepare("SELECT * FROM maintenance_replies WHERE ticket_id = ? ORDER BY created_at ASC").bind(id).all();
        return json({ replies: rows.results.map(rowToTicketReply) });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/replies")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/replies".length));
        const existing = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "Message is required" }, 400);
        const requester = request._staff;
        const replyId = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO maintenance_replies (id, ticket_id, from_dept, body, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(replyId, id, requester.department_id, text, now).run();
        const row = await env.DB.prepare("SELECT * FROM maintenance_replies WHERE id = ?").bind(replyId).first();

        const notifyTarget = requester.department_id === "maintenance" ? existing.created_by : "maintenance";
        if (notifyTarget !== requester.department_id) {
          const notifyPromise = notifyDepartment(env, notifyTarget, {
            title: (DEPT_NAMES[requester.department_id] || requester.department_id) + " · job reply",
            body: text,
            url: "/",
            tag: "hotel-ping-maint-reply-" + id,
          }, requester.department_id).catch(function(e){ console.error("notifyDepartment (maint reply) error:", e && e.stack || e); });
          if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
        }

        return json({ reply: rowToTicketReply(row) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/status")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/status".length));
        const body = await readJsonBody(request);
        const status = body.status;
        if (!MAINT_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        if (request._staff.department_id !== "maintenance" && !request._staff.is_admin) {
          return json({ error: "Only Maintenance can update a ticket's status" }, 403);
        }
        const now = new Date().toISOString();
        const newOwner = !existing.owner_staff_id && status !== "reported" ? request._staff.id : existing.owner_staff_id;
        await env.DB.prepare(
          "UPDATE maintenance_tickets SET status = ?, updated_at = ?, resolved_at = ?, owner_staff_id = ? WHERE id = ?"
        ).bind(status, now, status === "fixed" ? now : null, newOwner, id).run();
        const row = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();

        const statusNotice = { in_progress: "Started work on: ", fixed: "Fixed: " };
        if (statusNotice[status] && existing.created_by !== "maintenance") {
          await insertMessage(env, ctx, {
            from: "maintenance", to: existing.created_by, type: "text",
            body: statusNotice[status] + existing.description + (existing.room_number ? " (" + existing.room_number + ")" : ""),
          });
        }

        return json({ ticket: rowToTicket(row) });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/owner")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/owner".length));
        const existing = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        if (request._staff.department_id !== "maintenance" && !request._staff.is_admin) {
          return json({ error: "Only Maintenance can assign a ticket's owner" }, 403);
        }
        const body = await readJsonBody(request);
        const staffId = body.staffId || null;
        if (staffId) {
          const staffRow = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND department_id = 'maintenance'").bind(staffId).first();
          if (!staffRow) return json({ error: "Not a Maintenance staff member" }, 400);
        }
        await env.DB.prepare("UPDATE maintenance_tickets SET owner_staff_id = ? WHERE id = ?").bind(staffId, id).run();
        const row = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        return json({ ticket: rowToTicket(row) });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/pin")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/pin".length));
        const existing = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const nextPinned = !existing.pinned_at;
        await env.DB.prepare(
          "UPDATE maintenance_tickets SET pinned_at = ? WHERE id = ?"
        ).bind(nextPinned ? new Date().toISOString() : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        return json({ ticket: rowToTicket(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/maintenance/")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length));
        const existing = await env.DB.prepare("SELECT * FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const requester = request._staff;
        if (existing.created_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only remove your own department's tickets" }, 403);
        }
        if (existing.status !== "reported" && !requester.is_admin) {
          return json({ error: "This job has already been picked up and can't be deleted" }, 400);
        }
        await env.DB.prepare("DELETE FROM maintenance_tickets WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/guest-requests") {
        const requester = request._staff;
        if (requester.department_id !== "concierge") {
          return json({ error: "Concierge access required" }, 403);
        }
        const rows = await env.DB.prepare("SELECT * FROM guest_requests ORDER BY created_at DESC").all();
        return json({ requests: rows.results.map(rowToGuestRequest) });
      }

      if (method === "POST" && p.startsWith("/api/guest-requests/") && p.endsWith("/status")) {
        const requester = request._staff;
        if (requester.department_id !== "concierge") {
          return json({ error: "Concierge access required" }, 403);
        }
        const id = decodeURIComponent(p.slice("/api/guest-requests/".length, -"/status".length));
        const body = await readJsonBody(request);
        const status = body.status;
        if (!GUEST_REQUEST_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        const replyText = body.replyText !== undefined ? (String(body.replyText).trim() || null) : existing.reply_text;
        const now = new Date().toISOString();
        await env.DB.prepare(
          "UPDATE guest_requests SET status = ?, reply_text = ?, updated_at = ?, completed_at = ? WHERE id = ?"
        ).bind(status, replyText, now, status === "completed" ? now : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();
        return json({ request: rowToGuestRequest(row) });
      }

      if (method === "POST" && p.startsWith("/api/guest-requests/") && p.endsWith("/pin")) {
        const requester = request._staff;
        if (requester.department_id !== "concierge") {
          return json({ error: "Concierge access required" }, 403);
        }
        const id = decodeURIComponent(p.slice("/api/guest-requests/".length, -"/pin".length));
        const existing = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        const now = new Date().toISOString();
        const newPinned = existing.pinned_at ? null : now;
        await env.DB.prepare("UPDATE guest_requests SET pinned_at = ? WHERE id = ?").bind(newPinned, id).run();
        const row = await env.DB.prepare("SELECT * FROM guest_requests WHERE id = ?").bind(id).first();
        return json({ request: rowToGuestRequest(row) });
      }

      if (method === "GET" && p === "/api/assets") {
        const rows = await env.DB.prepare("SELECT * FROM asset_requests ORDER BY created_at DESC").all();
        return json({ requests: rows.results.map(rowToAssetRequest) });
      }

      if (method === "POST" && p === "/api/assets") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const itemName = String(body.itemName || "").trim();
        if (!itemName) return json({ error: "An item name is required" }, 400);
        if (itemName.length > 80) return json({ error: "Item name is too long" }, 400);
        const notes = body.notes ? String(body.notes).trim().slice(0, 200) : null;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          "INSERT INTO asset_requests (id, item_name, notes, status, requested_by, created_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)"
        ).bind(id, itemName, notes, requester.department_id, now, now).run();
        const row = await env.DB.prepare("SELECT * FROM asset_requests WHERE id = ?").bind(id).first();

        const notifyPromise = Promise.all([...DEPT_IDS].filter((d) => d !== requester.department_id).map((deptId) =>
          notifyDepartment(env, deptId, {
            title: "📦 Asset request",
            body: (DEPT_NAMES[requester.department_id] || requester.department_id) + " needs: " + itemName,
            url: "/",
            tag: "hotel-ping-asset-" + id,
          }, requester.department_id).catch(function(e){ console.error("notifyDepartment (asset) error:", e && e.stack || e); })
        ));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ request: rowToAssetRequest(row) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/assets/") && p.endsWith("/status")) {
        const id = decodeURIComponent(p.slice("/api/assets/".length, -"/status".length));
        const body = await readJsonBody(request);
        const status = body.status;
        if (!ASSET_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
        const existing = await env.DB.prepare("SELECT * FROM asset_requests WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        if (existing.requested_by !== request._staff.department_id && !request._staff.is_admin) {
          return json({ error: "You can only update your own department's requests" }, 403);
        }
        const now = new Date().toISOString();
        await env.DB.prepare(
          "UPDATE asset_requests SET status = ?, updated_at = ?, returned_at = ? WHERE id = ?"
        ).bind(status, now, status === "returned" ? now : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM asset_requests WHERE id = ?").bind(id).first();
        return json({ request: rowToAssetRequest(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/assets/")) {
        const id = decodeURIComponent(p.slice("/api/assets/".length));
        const existing = await env.DB.prepare("SELECT * FROM asset_requests WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        const requester = request._staff;
        if (existing.requested_by !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only remove your own department's requests" }, 403);
        }
        await env.DB.prepare("DELETE FROM asset_requests WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/escalations/check") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const count = await checkEscalations(env);
        return json({ escalated: count });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Server error", detail: String((err && err.message) || err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkEscalations(env));
  },
};
