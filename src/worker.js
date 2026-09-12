const DEPT_IDS = new Set(["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"]);
const DEPT_NAMES = {
  gm: "General Manager", foh: "Front of House", concierge: "Concierge", restaurant: "Restaurant",
  kitchen: "Kitchen", bar: "Bar", housekeeping: "Housekeeping", maintenance: "Maintenance",
};
const PIN_RE = /^\d{4,6}$/;

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

const ESCALATION_MINUTES = 10;

async function checkEscalations(env) {
  const cutoff = new Date(Date.now() - ESCALATION_MINUTES * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE urgent = 1 AND deleted_at IS NULL AND escalated_at IS NULL
       AND status != 'read' AND created_at < ?`
  ).bind(cutoff).all();
  for (const row of rows.results) {
    const preview = row.type === "text" ? row.body : (row.type === "image" ? "a photo" : row.type === "file" ? "a file" : "a voice message");
    await notifyAdmins(env, {
      title: "⚠️ Unread urgent message",
      body: (DEPT_NAMES[row.from_dept] || row.from_dept) + " → " + (DEPT_NAMES[row.to_dept] || row.to_dept) + ": " + preview,
      url: "/",
      tag: "hotel-ping-escalation-" + row.id,
    });
    await env.DB.prepare("UPDATE messages SET escalated_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  }
  return rows.results.length;
}

async function insertMessage(env, ctx, opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id, broadcast_id, room_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?)`
  ).bind(
    id, opts.from, opts.to, opts.type,
    opts.body || null, opts.fileName || null, opts.filePath || null, opts.fileSize || null,
    opts.duration || null, opts.transcript || null, opts.urgent ? 1 : 0, now, opts.replyToId || null, opts.broadcastId || null, opts.roomNumber || null
  ).run();

  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();

  const previewMap = { text: opts.body || "", image: "📷 Photo", file: "📎 " + (opts.fileName || "File"), audio: "🎤 Voice message" };
  const notifyBody = opts.urgent ? "🔴 Urgent: " + (previewMap[opts.type] || "New message") : (previewMap[opts.type] || "New message");
  const notifyPromise = notifyDepartment(env, opts.to, {
    title: DEPT_NAMES[opts.from] || opts.from,
    body: notifyBody,
    url: "/",
    tag: "hotel-ping-" + opts.to,
    icon: "/avatars/" + opts.from + ".png",
  }, opts.from).catch(function(e){ console.error("notifyDepartment top-level error:", e && e.stack || e); });
  if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

  return row;
}

function rowToHandoverNote(row) {
  return { id: row.id, departmentId: row.department_id, staffId: row.staff_id, staffName: row.staff_name, body: row.body, createdAt: row.created_at };
}
function rowToDepartment(row) {
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty };
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
  };
}
function rowToStaff(row) {
  return { id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at, profileComplete: !!row.profile_complete };
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

async function ensureSeeded(env) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first();
  if (count && count.n > 0) return;
  const salt = randomSaltHex();
  const hash = await hashPin("1234", salt);
  await env.DB.prepare(
    `INSERT INTO staff (id, name, department_id, pin_hash, pin_salt, is_admin, created_at) VALUES (?, 'Dave', 'gm', ?, ?, 1, ?)`
  ).bind(crypto.randomUUID(), hash, salt, new Date().toISOString()).run();
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

        const attemptKey = name.toLowerCase();
        const attempt = await env.DB.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(attemptKey).first();
        if (attempt && attempt.count >= 5 && Date.now() - Date.parse(attempt.first_at) < 5 * 60 * 1000) {
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
        }

        const staff = await env.DB.prepare("SELECT * FROM staff WHERE LOWER(name) = LOWER(?)").bind(name).first();
        const ok = staff && (await hashPin(pin, staff.pin_salt)) === staff.pin_hash;
        if (!ok) {
          if (attempt) {
            await env.DB.prepare("UPDATE login_attempts SET count = ? WHERE key = ?").bind(attempt.count + 1, attemptKey).run();
          } else {
            await env.DB.prepare("INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)").bind(attemptKey, new Date().toISOString()).run();
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
        if (typeof body.pin === "string" && body.pin) {
          if (!PIN_RE.test(body.pin)) return json({ error: "PIN must be 4-6 digits" }, 400);
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
          await env.DB.prepare("UPDATE departments SET on_duty = ? WHERE id = ?").bind(body.onDuty ? 1 : 0, id).run();
        }
        if (typeof body.contactName === "string") {
          if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
          await env.DB.prepare("UPDATE departments SET contact_name = ? WHERE id = ?").bind(body.contactName.trim() || null, id).run();
        }
        const row = await env.DB.prepare("SELECT * FROM departments WHERE id = ?").bind(id).first();
        return json({ department: rowToDepartment(row) });
      }

      // ---- Conversations ----
      if (method === "GET" && p === "/api/conversations") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
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
        const rows = await env.DB.prepare(
          `SELECT * FROM messages WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?) ORDER BY created_at ASC`
        ).bind(self, other, other, self).all();
        return json({ messages: rows.results.map((r) => rowToMessage(r, self, request._staff.is_admin)).filter(Boolean) });
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
        await env.DB.prepare(`UPDATE messages SET status = 'read' WHERE to_dept = ? AND from_dept = ? AND status != 'read'`).bind(body.self, body.with).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/messages") {
        const body = await readJsonBody(request);
        const { from, to, type, text, urgent, fileName, fileBase64, fileMime, duration, transcript, replyToId, roomNumber } = body;
        if (!DEPT_IDS.has(from) || !DEPT_IDS.has(to)) return json({ error: "Unknown department" }, 400);
        if (!["text", "image", "file", "audio"].includes(type)) return json({ error: "Invalid message type" }, 400);
        if (type === "text" && !(text && text.trim())) return json({ error: "Message text is required" }, 400);
        if (roomNumber && String(roomNumber).length > 20) return json({ error: "Room number is too long" }, 400);

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
          from, to, type,
          body: text && text.trim() ? text.trim() : null,
          fileName: fileName || null, filePath: filePathOnDisk, fileSize,
          duration: duration || null, transcript: transcript && transcript.trim() ? transcript.trim() : null,
          urgent: !!urgent,
          replyToId: replyToId || null,
          roomNumber: roomNumber ? String(roomNumber).trim() : null,
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

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/pin")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/pin".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id;
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextPinned = !existing.pinned_at;
        await env.DB.prepare("UPDATE messages SET pinned_at = ? WHERE id = ?").bind(nextPinned ? new Date().toISOString() : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/complete")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/complete".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id;
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextCompleted = !existing.completed_at;
        await env.DB.prepare("UPDATE messages SET completed_at = ?, completed_by = ? WHERE id = ?")
          .bind(nextCompleted ? new Date().toISOString() : null, nextCompleted ? requester.department_id : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/forward")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/forward".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        if (existing.deleted_at) return json({ error: "Can't forward a deleted message" }, 400);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id;
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
