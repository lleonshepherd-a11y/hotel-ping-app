const DEPT_IDS = new Set(["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"]);
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

function rowToDepartment(row) {
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty };
}
function rowToMessage(row) {
  return {
    id: row.id,
    from: row.from_dept,
    to: row.to_dept,
    type: row.type,
    body: row.body,
    fileName: row.file_name,
    fileUrl: row.file_path ? "/uploads/" + row.file_path : null,
    fileSize: row.file_size,
    duration: row.duration,
    transcript: row.transcript,
    urgent: !!row.urgent,
    status: row.status,
    createdAt: row.created_at,
  };
}
function rowToStaff(row) {
  return { id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at };
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
  async fetch(request, env) {
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

      // ---- Staff directory: any signed-in user can read names/departments ----
      if (method === "GET" && p === "/api/staff") {
        const rows = await env.DB.prepare("SELECT * FROM staff ORDER BY name").all();
        return json({ staff: rows.results.map(rowToStaff) });
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
            lastMessage: last ? rowToMessage(last) : null,
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
        return json({ messages: rows.results.map(rowToMessage) });
      }

      if (method === "POST" && p === "/api/messages/read") {
        const body = await readJsonBody(request);
        if (!DEPT_IDS.has(body.self) || !DEPT_IDS.has(body.with)) return json({ error: "Unknown department" }, 400);
        await env.DB.prepare(`UPDATE messages SET status = 'read' WHERE to_dept = ? AND from_dept = ? AND status != 'read'`).bind(body.self, body.with).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/messages") {
        const body = await readJsonBody(request);
        const { from, to, type, text, urgent, fileName, fileBase64, fileMime, duration, transcript } = body;
        if (!DEPT_IDS.has(from) || !DEPT_IDS.has(to)) return json({ error: "Unknown department" }, 400);
        if (!["text", "image", "file", "audio"].includes(type)) return json({ error: "Invalid message type" }, 400);
        if (type === "text" && !(text && text.trim())) return json({ error: "Message text is required" }, 400);

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

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?)`
        ).bind(
          id, from, to, type,
          text && text.trim() ? text.trim() : null,
          fileName || null, filePathOnDisk, fileSize, duration || null, transcript && transcript.trim() ? transcript.trim() : null,
          urgent ? 1 : 0, now
        ).run();

        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row) }, 201);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Server error", detail: String((err && err.message) || err) }, 500);
    }
  },
};
