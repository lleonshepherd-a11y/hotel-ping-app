// Auth now lives in the shared dashboard database (noir-house-db, binding
// NOIR_DB) rather than this Worker's own D1 - see the NOIR_DB migration.
// Every other table below still reads/writes the original DB binding until
// its own phase of the migration happens; only login/session/profile-PIN
// have moved so far.
const NOIR_HOTEL_ID = "5ca39253-5d0d-4526-a1e9-ed9a39e91707";
const NOIR_DEPT_ID_MAP = {
  gm: "53b8a53e-cc3e-4732-8e9a-417c91e1e9b8",
  foh: "04dccc8b-3da8-448f-9be1-8fa68935da92",
  concierge: "32cd4290-036e-4b11-8f8d-ab94dce3427e",
  restaurant: "5dd88a56-62af-4aec-9a9b-337ee7da4ffe",
  kitchen: "dde80a18-f50a-4d6e-9cfe-c122f429425e",
  bar: "28c6a2ea-1db8-4a37-b9cf-6a911dd30c91",
  housekeeping: "591efca2-1058-4f27-9602-03731bcd5811",
  maintenance: "de37b6a6-ad48-422d-9c5b-950411e40f07",
};
const NOIR_DEPT_ID_REVERSE = Object.fromEntries(Object.entries(NOIR_DEPT_ID_MAP).map(([k, v]) => [v, k]));
const NOIR_SESSION_MINUTES = 60 * 24 * 30;
// Pre-launch: nobody is paying to use this yet, so PIN checking is off and
// signing in only needs a real staff member's name - flip this back to
// true (and unhide the PIN field in index.html) before real staff/guests
// start using it.
const LOGIN_REQUIRE_PIN = false;

// Builds the shape the rest of this Worker expects a "staff" object to have,
// from a row out of the dashboard's own staff table. status_line/phone have
// no home in that table, so they're always absent here rather than silently
// pointed at the wrong record.
function toNoirDept(deptSlug) {
  return NOIR_DEPT_ID_MAP[deptSlug] || deptSlug;
}
function fromNoirDept(deptUuid) {
  return NOIR_DEPT_ID_REVERSE[deptUuid] || deptUuid;
}
// Shallow-clones a NOIR_DB row and swaps its department_id UUID back to
// Hotel Ping's own slug, for rows whose other columns are otherwise a
// direct match for the local row shape the existing rowTo* fns expect.
function noirDeptRow(r) {
  return Object.assign({}, r, { department_id: fromNoirDept(r.department_id) });
}

function noirIdentity(staffRow) {
  return {
    id: staffRow.id,
    name: staffRow.display_name,
    department_id: NOIR_DEPT_ID_REVERSE[staffRow.department_id] || staffRow.department_id,
    // Blanket cross-department visibility is reserved for the actual GM,
    // not for anyone the dashboard happens to also mark role "admin" - a
    // duty_manager or admin is a normal, membership-scoped participant
    // like everyone else, same as any staff department account.
    is_admin: staffRow.role === "general_manager" ? 1 : 0,
    created_at: new Date().toISOString(),
    profile_complete: 1,
    status_line: null,
    phone: null,
    role: staffRow.role || null,
  };
}

const DEPT_IDS = new Set(["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"]);
// Head-of-department contacts: one specific, named, photographed person per
// department (assigned in Hotel Setup - see department_heads), separate
// from the department's own shared line. GM has no paired head - it's
// already a single accountable person, not a shared queue.
const HEAD_DEPT_IDS = new Set(["head_foh", "head_concierge", "head_restaurant", "head_kitchen", "head_bar", "head_housekeeping", "head_maintenance"]);
const ALL_DEPT_IDS = new Set([...DEPT_IDS, ...HEAD_DEPT_IDS]);
const DEPT_NAMES = {
  gm: "General Manager", foh: "Reception", concierge: "Concierge", restaurant: "Restaurant",
  kitchen: "Kitchen", bar: "Bar", housekeeping: "Housekeeping", maintenance: "Maintenance",
  dashboard: "Head Office",
  head_foh: "Head Receptionist", head_concierge: "Head Concierge", head_restaurant: "Restaurant Manager",
  head_kitchen: "Head Chef", head_bar: "Bar Manager", head_housekeeping: "Head Housekeeper", head_maintenance: "Maintenance Manager",
};
const PIN_RE = /^\d{4,6}$/;
// Every department in this list gets alerted and can acknowledge a
// hold-for-help alert. Just GM for now, but kept as a list (not a single
// hardcoded id) since "all SOS responders" is meant to be more than one.
const HELP_ALERT_RESPONDER_DEPTS = ["gm"];
const HELP_ALERT_WINDOW_MINUTES = 30;
const TASK_STATUSES = ["not_started", "in_progress", "completed"];
const MAINT_STATUSES = ["reported", "in_progress", "fixed"];
const MAINT_PRIORITIES = ["safety", "guest", "problem", "routine"];
const MAINT_PRIORITY_RANK = { safety: 0, guest: 1, problem: 2, routine: 3 };
const DEADLINE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GUEST_REQUEST_STATUSES = ["new", "in_progress", "completed"];
const ASSET_STATUSES = ["requested", "borrowed", "returned"];
const DEFAULT_QUICK_REPLIES = ["On it", "Done", "5 mins", "On my way", "Noted", "Course away", "Hold 10 mins", "Ready for dessert"];

// Scoped to the app's own origin rather than "*" - nothing here needs to
// be readable by an arbitrary third-party website, and a wildcard origin
// is a needlessly wide-open default for an API that carries staff/guest
// data, even though every endpoint still requires its own valid session
// token regardless of where the request came from.
const ALLOWED_ORIGIN = "https://app.hotelping.co.uk";
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Vary": "Origin" }, headers || {}),
  });
}

// A base64 string decodes to roughly 3/4 of its own length - cheap to check
// up front, before ever calling atob() and looping byte-by-byte over the
// result. Skipping this let a big-enough payload burn through the Worker's
// CPU-time budget on the decode loop alone and get killed with a bare 503,
// instead of a clean "too large" error from the size check that came AFTER
// the (already too slow) decode.
function base64ExceedsBytes(b64, maxBytes) {
  return Math.floor((b64.length * 3) / 4) > maxBytes;
}
// Push-to-talk's on-device transcription (Web Speech API) doesn't exist on
// iOS Safari at all, so it never has anything to send there - this runs the
// same clip through Workers AI instead, whenever the client came up empty,
// so a ticket still gets real words no matter what phone reported it.
async function transcribeVoice(env, bytes) {
  if (!env.AI) return null;
  try {
    const res = await env.AI.run("@cf/openai/whisper", { audio: Array.from(bytes) });
    const text = res && res.text ? String(res.text).trim() : "";
    return text || null;
  } catch (e) {
    console.error("transcribeVoice error:", e && e.stack || e);
    return null;
  }
}
function extractRoomNumberFromText(text) {
  if (!text) return null;
  let m = /room\s*#?\s*(\d{1,4})/i.exec(text);
  if (m) return m[1];
  m = /\b(\d{3,4})\b/.exec(text);
  return m ? m[1] : null;
}
// Reporting a fault stays open to every department (that's the whole point
// of the button), but the board itself - seeing every ticket, how many are
// open, replying, changing status - is Maintenance's and the GM's job, not
// whoever happens to be signed in.
function canManageMaintenance(requester) {
  return requester.department_id === "maintenance" || requester.department_id === "gm" || !!requester.is_admin;
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
async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return bytesToHex(new Uint8Array(digest));
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
  const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE department_id = ?").bind(deptId).all();
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

async function notifyAdmins(env, payloadObj) {
  const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE is_admin = 1").all();
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

// The reverse of /api/external/notify: when a Hotel Ping department sends a
// message "to the dashboard", relay it there so it actually reaches whoever
// monitors the dashboard - Hotel Ping's own push/on-duty system has no
// concept of "dashboard" as a real staff department. Best-effort and a
// silent no-op until the dashboard side gives us its receiving endpoint and
// key (mirroring how they configured EXTERNAL_API_KEY for the notify-in
// direction), so sending "to Dashboard" always succeeds locally even before
// that's wired up on their end.
async function notifyDashboard(env, ctx, opts) {
  if (!env.DASHBOARD_NOTIFY_URL || !env.DASHBOARD_NOTIFY_KEY) return;
  const promise = fetch(env.DASHBOARD_NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.DASHBOARD_NOTIFY_KEY },
    body: JSON.stringify({
      idempotencyKey: opts.messageId,
      departmentId: opts.departmentId,
      staffName: opts.staffName,
      message: opts.message,
      urgency: opts.urgency || "normal",
      replyToConversationId: opts.replyToConversationId || undefined,
    }),
  }).catch((e) => console.error("notifyDashboard error:", e && e.stack || e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise); else await promise;
}

// ---- Location service ----
// This is the ONLY function the SOS flow calls for "where is this person".
// It knows nothing about any specific positioning technology, vendor, or
// hardware - it takes an optional device-reported position and returns a
// zone-level result (or says unavailable). It should never claim more
// precision than it actually has: no invented coordinates, no "3.2m from
// the bar" - zone/subzone names only, tagged with where that answer came
// from, or "not available" when nothing matches.
//
// Two sources, tried in order:
//  1. "device" - the browser's standard Geolocation API (navigator.
//     geolocation), which the client calls when a hold-for-help starts.
//     That's a W3C standard, not an Apple (or any vendor) API - but on an
//     iPhone, Apple's own location stack (Wi-Fi/GPS/cell fusion) is what
//     answers it, which is what makes it the most concrete real source to
//     start with: no beacon hardware to install, works today. Coordinates
//     are matched to the nearest zone that has a reference point set
//     (zones.lat/lng), and only trusted within MAX_DEVICE_MATCH_METERS -
//     past that, indoor GPS is too unreliable to name a zone from it.
//  2. "stub" - an admin-set "department -> current zone" mapping
//     (department_zone_stub), for testing/demo before real positioning
//     coverage exists everywhere.
// Swapping in a dedicated indoor-positioning backend (BLE beacons, WiFi
// RTT, UWB tags, Apple's own Indoor Maps program, whatever) later means
// adding a third source here, or replacing #1's matching logic - nothing
// that calls resolveLocation() should ever need to change.
const MAX_DEVICE_MATCH_METERS = 60;
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function resolveLocation(env, requester, deviceCoords) {
  try {
    if (deviceCoords && typeof deviceCoords.lat === "number" && typeof deviceCoords.lng === "number") {
      const rows = await env.DB.prepare(
        `SELECT z.id, z.name AS zone_name, z.parent_zone_id, z.lat, z.lng, f.name AS floor_name
         FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.lat IS NOT NULL AND z.lng IS NOT NULL`
      ).all();
      let best = null, bestDist = Infinity;
      for (const z of rows.results) {
        const dist = haversineMeters(deviceCoords.lat, deviceCoords.lng, z.lat, z.lng);
        if (dist < bestDist) { bestDist = dist; best = z; }
      }
      if (best && bestDist <= MAX_DEVICE_MATCH_METERS) {
        let zoneName = best.zone_name, subzoneName = null;
        if (best.parent_zone_id) {
          const parent = await env.DB.prepare("SELECT name FROM zones WHERE id = ?").bind(best.parent_zone_id).first();
          if (parent) { zoneName = parent.name; subzoneName = best.zone_name; }
        }
        return {
          available: true, source: "device", floorName: best.floor_name, zoneName, subzoneName,
          accuracyMeters: typeof deviceCoords.accuracy === "number" ? deviceCoords.accuracy : null,
        };
      }
      // Device position known but no zone close enough - don't fall back to
      // a stale test-data stub and pretend it's where they are; say so.
    }
    const row = await env.DB.prepare(
      `SELECT z.id AS zone_id, z.name AS zone_name, z.parent_zone_id, f.name AS floor_name
       FROM department_zone_stub dzs
       JOIN zones z ON z.id = dzs.zone_id
       JOIN floors f ON f.id = z.floor_id
       WHERE dzs.department_id = ?`
    ).bind(requester.department_id).first();
    if (!row) return { available: false };
    let zoneName = row.zone_name, subzoneName = null;
    if (row.parent_zone_id) {
      const parent = await env.DB.prepare("SELECT name FROM zones WHERE id = ?").bind(row.parent_zone_id).first();
      if (parent) { zoneName = parent.name; subzoneName = row.zone_name; }
    }
    return { available: true, source: "stub", floorName: row.floor_name, zoneName, subzoneName };
  } catch (e) {
    console.error("resolveLocation error:", e && e.stack || e);
    return { available: false };
  }
}
function formatLocationLabel(location) {
  if (!location || !location.available) return "location not available";
  const parts = [location.subzoneName, location.zoneName].filter(Boolean);
  const place = parts.join(", ") || location.floorName || "unknown zone";
  return location.floorName && location.zoneName ? location.floorName + " - " + place : place;
}

const URGENT_ESCALATION_MINUTES = 10;
const NORMAL_ESCALATION_MINUTES = 25;
const URGENT_ESCALATION_L2_MINUTES = 20;
const NORMAL_ESCALATION_L2_MINUTES = 50;
const TICKET_AT_RISK_MINUTES = 15;
const TICKET_BREACH_MINUTES = 35;

// Hotel Ping's 8 departments are hardcoded (DEPT_IDS/NOIR_DEPT_ID_MAP) rather
// than read live from the dashboard, since that roster is deeply baked into
// this Worker and the client (PIN logins, on-duty toggles, station
// assignment, etc.) - a live/dynamic department list would be a much larger
// change. This is the lighter-weight middle ground: every cron tick, check
// the dashboard's own department list against what's hardcoded here and log
// (not alert - Workers logs are visible via `wrangler tail` or the
// dashboard) if they've drifted apart, so a future department add/rename on
// their side doesn't silently go unnoticed here.
async function checkDashboardDepartmentDrift(env) {
  if (!env.DASHBOARD_DEPARTMENTS_URL || !env.DASHBOARD_DEPARTMENTS_KEY) return;
  try {
    const res = await fetch(env.DASHBOARD_DEPARTMENTS_URL, {
      headers: { "x-api-key": env.DASHBOARD_DEPARTMENTS_KEY },
    });
    if (!res.ok) {
      console.error("Dashboard department check: request failed with status " + res.status);
      return;
    }
    const data = await res.json();
    const remoteIds = new Set((data.departments || []).map((d) => d.departmentId));
    const missingLocally = [...remoteIds].filter((id) => !DEPT_IDS.has(id));
    const missingRemotely = [...DEPT_IDS].filter((id) => !remoteIds.has(id));
    if (missingLocally.length || missingRemotely.length) {
      console.error(
        "Dashboard department drift detected - dashboard has departments Hotel Ping doesn't know about: [" +
        missingLocally.join(", ") + "]; Hotel Ping has departments the dashboard doesn't list: [" +
        missingRemotely.join(", ") + "]"
      );
    }
  } catch (e) {
    console.error("Dashboard department check error:", e && e.stack || e);
  }
}

function dashboardApiOrigin(env) {
  if (!env.DASHBOARD_DEPARTMENTS_URL) return null;
  try { return new URL(env.DASHBOARD_DEPARTMENTS_URL).origin; } catch (e) { return null; }
}

// Maintenance tickets live in the dashboard's own NOIR_DB table, shared by
// both systems - so a ticket the dashboard creates directly is already
// visible in Hotel Ping's Repairs board without any bridging. What's
// missing is the *alert*: Hotel Ping only ever notifies staff (push +
// chat message) at the moment ITS OWN POST /api/maintenance handler
// creates a ticket, which a dashboard-side insert never goes through.
// This tick spots any ticket with no local meta row yet - the exact
// signal that it bypassed our creation flow - and sends the same
// notification + chat message our own flow would have sent.
async function checkUnnotifiedTickets(env, ctx) {
  const rows = await env.NOIR_DB.prepare(
    `SELECT mt.id, mt.room_number, mt.description, mt.priority, mt.guest_present, mt.deadline, mt.created_at, mt.photo_path, s.department_id AS creator_dept
     FROM maintenance_tickets mt LEFT JOIN staff s ON s.id = mt.created_by_staff_id
     WHERE mt.status != 'fixed' ORDER BY mt.created_at DESC LIMIT 50`
  ).all();
  if (!rows.results.length) return;
  const ids = rows.results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const metaRows = await env.DB.prepare(
    `SELECT ticket_id FROM maintenance_ticket_meta WHERE ticket_id IN (${placeholders})`
  ).bind(...ids).all();
  const known = new Set(metaRows.results.map((r) => r.ticket_id));
  for (const t of rows.results) {
    if (known.has(t.id)) continue;
    // Give our own creation flow a moment to write its meta row first,
    // so this never races a ticket Hotel Ping itself just created.
    if (Date.now() - new Date(t.created_at).getTime() < 30000) continue;
    const metaInsert = await env.DB.prepare("INSERT INTO maintenance_ticket_meta (ticket_id, escalation_level) VALUES (?, 0)").bind(t.id).run();
    const ticketNumber = metaInsert.meta.last_row_id;
    let body = "#" + ticketNumber + " " + (t.room_number ? "Room " + t.room_number + ": " : "") + t.description;
    if (t.guest_present) body += " · Guest in room";
    if (t.deadline) body += " · Needed by " + t.deadline;
    // Deliver as if the reporting department (restaurant, reception, kitchen,
    // ...) messaged maintenance directly - that's who actually reported it.
    // If it doesn't map to a real department (or is maintenance itself,
    // where self-messaging makes no sense), skip the chat message entirely
    // rather than inventing a sender - the push notification below still
    // gets sent either way, so the ticket doesn't go unnoticed.
    const originDept = t.creator_dept ? fromNoirDept(t.creator_dept) : null;
    const validOrigin = originDept && DEPT_IDS.has(originDept) && originDept !== "maintenance";
    if (validOrigin) {
      // roomNumber/taskStatus give this the same room chip + status pill
      // layout as any other tagged message, instead of a flat text bubble -
      // the room is already carried by roomNumber, so it's left out of the
      // body text here (unlike the push notification below, which has no
      // separate chip and needs it inline).
      let chatBody = t.description;
      if (t.guest_present) chatBody += " · Guest in room";
      if (t.deadline) chatBody += " · Needed by " + t.deadline;
      // Same "the actual photo rides along in the ping" rule as Hotel
      // Ping's own creation flow - a dashboard-side ticket's photo is just
      // as much part of the report as one created here.
      const isVideoFile = t.photo_path && /\.(mp4|webm|mov|m4v|3gp)$/i.test(t.photo_path);
      await insertMessage(env, ctx, {
        from: originDept, to: "maintenance", type: t.photo_path ? (isVideoFile ? "file" : "image") : "text",
        body: "🔧 New ticket #" + ticketNumber + ": " + chatBody,
        fileName: t.photo_path ? (isVideoFile ? "Issue video" : "Issue photo") : undefined,
        filePath: t.photo_path || undefined,
        roomNumber: t.room_number || null, taskStatus: "not_started",
      });
    } else {
      console.error("Unnotified ticket " + t.id + ": reporting department could not be resolved (creator_dept=" + t.creator_dept + "), no chat message sent");
    }
    const notifyPromise = notifyDepartment(env, "maintenance", {
      title: t.priority === "safety" ? "🚨 Safety issue reported" : "🔧 New maintenance ticket",
      body, url: "/", tag: "hotel-ping-maintenance-" + t.id,
    }, null).catch((e) => console.error("notifyDepartment (dashboard ticket) error:", e && e.stack || e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
  }
}

// Same idea for the dashboard's planner: no Hotel Ping screen shows it, so
// the only way a manager finds out about a diary entry is if it reaches
// them some other way. A planner entry isn't "from" any department though -
// it's the calendar, not a person - so this never creates a chat message or
// a fake "Head Office" sender. It's stored as its own notification, surfaced
// only in that department's Missed feed (no sender shown), plus a push.
// Best-effort and silent no-op until the dashboard side confirms this read
// endpoint/key - if it 401s or the shape is wrong this just logs and skips,
// it never breaks the cron tick.
async function checkPlannerAlerts(env, ctx) {
  const origin = dashboardApiOrigin(env);
  if (!origin || !env.DASHBOARD_DEPARTMENTS_KEY) return;
  try {
    const res = await fetch(origin + "/api/external/planner?hotelId=" + encodeURIComponent(NOIR_HOTEL_ID), {
      headers: { "x-api-key": env.DASHBOARD_DEPARTMENTS_KEY },
    });
    if (!res.ok) {
      console.error("Planner alert check: request failed with status " + res.status);
      return;
    }
    const data = await res.json();
    const entries = data.entries || data.plannerEntries || data.results || [];
    if (!entries.length) return;
    const ids = entries.map((e) => e.id).filter(Boolean);
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    const seenRows = await env.DB.prepare(
      `SELECT entry_id FROM planner_alerts_sent WHERE entry_id IN (${placeholders})`
    ).bind(...ids).all();
    const seen = new Set(seenRows.results.map((r) => r.entry_id));
    for (const entry of entries) {
      if (!entry.id || seen.has(entry.id)) continue;
      if (entry.status && entry.status !== "scheduled") continue;
      const dept = fromNoirDept(entry.departmentId || entry.department_id);
      if (!DEPT_IDS.has(dept)) {
        console.error("Planner alert: entry " + entry.id + " has no resolvable department, skipping");
        continue;
      }
      const when = entry.startsAt || entry.starts_at || "";
      const title = entry.title || "Planner entry";
      const details = entry.details || null;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO planner_alerts_sent (entry_id, sent_at, department_id, title, starts_at, details) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(entry.id, new Date().toISOString(), dept, title, when || null, details).run();
      const notifyPromise = notifyDepartment(env, dept, {
        title: "📅 Planner", body: title + (when ? " — " + when : ""), url: "/", tag: "hotel-ping-planner-" + entry.id,
      }, null).catch((e) => console.error("notifyDepartment (planner) error:", e && e.stack || e));
      if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
    }
  } catch (e) {
    console.error("Planner alert check error:", e && e.stack || e);
  }
}

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
  const ticketRows = await env.NOIR_DB.prepare(
    `SELECT id, description, created_at FROM maintenance_tickets WHERE status = 'reported' AND created_at < ?`
  ).bind(ticketAtRiskCutoff).all();
  if (ticketRows.results.length) {
    const metaByTicket = await ticketMetaMap(env, ticketRows.results.map((r) => r.id));
    for (const row of ticketRows.results) {
      const level = metaByTicket[row.id] ? metaByTicket[row.id].escalation_level : 0;
      if (level >= 2) continue;
      const nextLevel = level === 0 ? 1 : (row.created_at < ticketBreachCutoff ? 2 : level);
      if (nextLevel <= level) continue;
      await notifyAdmins(env, {
        title: nextLevel === 2 ? "🔴 Maintenance ticket still unclaimed" : "🟡 Maintenance ticket needs claiming",
        body: row.description,
        url: "/",
        tag: "hotel-ping-ticket-escalation-" + row.id + "-" + nextLevel,
      });
      await env.DB.prepare(
        `INSERT INTO maintenance_ticket_meta (ticket_id, escalation_level, escalated_at) VALUES (?, ?, ?)
         ON CONFLICT(ticket_id) DO UPDATE SET escalation_level = excluded.escalation_level, escalated_at = excluded.escalated_at`
      ).bind(row.id, nextLevel, new Date().toISOString()).run();
      escalatedCount++;
    }
  }

  return escalatedCount;
}

async function nextSignoffCode(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE signoff_title IS NOT NULL").first();
  return "RQ-" + String((row ? row.n : 0) + 1).padStart(4, "0");
}

async function insertMessage(env, ctx, opts) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = opts.mentions && opts.mentions.length ? JSON.stringify(opts.mentions) : null;
  const pollOptionsJson = opts.poll ? JSON.stringify(opts.poll.options) : null;
  const signoffCode = opts.signoff ? await nextSignoffCode(env) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO messages (id, from_dept, to_dept, type, body, file_name, file_path, file_size, duration, transcript, urgent, status, created_at, reply_to_id, broadcast_id, room_number, task_status, group_id, mentions, signoff_title, signoff_amount, signoff_target, signoff_category, signoff_guest_info, signoff_status, signoff_code, poll_question, poll_options, poll_votes, affects_guest, dashboard_conversation_id, room_clean, from_staff_name, client_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      signoffCode,
      opts.poll ? opts.poll.question : null,
      pollOptionsJson,
      opts.poll ? "{}" : null,
      opts.affectsGuest ? 1 : 0,
      opts.dashboardConversationId || null,
      opts.roomClean || null,
      opts.fromStaffName || null,
      opts.clientMessageId || null
    ).run();
  } catch (err) {
    // A retried send (e.g. the app resending after a dropped connection)
    // carries the same clientMessageId as the original - the unique index
    // on that column turns the second INSERT into this conflict instead of
    // a duplicate row. Hand back the message that already exists rather
    // than erroring, so the retry looks like a normal successful send.
    if (opts.clientMessageId && String(err && err.message).toLowerCase().includes("unique")) {
      const existing = await env.DB.prepare("SELECT * FROM messages WHERE client_message_id = ?").bind(opts.clientMessageId).first();
      if (existing) return existing;
    }
    throw err;
  }

  // Built straight from the values we just inserted rather than reading
  // the row back - under heavy concurrent write load a read-after-write
  // SELECT here occasionally throws even though the INSERT itself already
  // committed, which turned a successful send into a false failure for
  // the caller. Every field below matches an insert(ed) column 1:1.
  const row = {
    id, from_dept: opts.from, to_dept: opts.to || null, type: opts.type,
    body: opts.body || null, file_name: opts.fileName || null, file_path: opts.filePath || null, file_size: opts.fileSize || null,
    duration: opts.duration || null, transcript: opts.transcript || null, urgent: opts.urgent ? 1 : 0, status: "delivered", created_at: now,
    deleted_at: null, reply_to_id: opts.replyToId || null, pinned_at: null, completed_at: null, completed_by: null,
    broadcast_id: opts.broadcastId || null, room_number: opts.roomNumber || null, room_clean: opts.roomClean || null,
    task_status: opts.taskStatus || null, group_id: opts.groupId || null, edited_at: null, mentions: mentionsJson,
    signoff_title: opts.signoff ? opts.signoff.title : null,
    signoff_amount: opts.signoff && opts.signoff.amount != null ? opts.signoff.amount : null,
    signoff_target: opts.signoff && opts.signoff.target ? opts.signoff.target : null,
    signoff_category: opts.signoff && opts.signoff.category ? opts.signoff.category : null,
    signoff_guest_info: opts.signoff && opts.signoff.guestInfo ? opts.signoff.guestInfo : null,
    signoff_status: opts.signoff ? "pending" : null,
    signoff_decided_by: null, signoff_decided_at: null, signoff_code: signoffCode,
    poll_question: opts.poll ? opts.poll.question : null, poll_options: pollOptionsJson, poll_votes: opts.poll ? "{}" : null,
    escalation_level: 0, affects_guest: opts.affectsGuest ? 1 : 0,
    dashboard_conversation_id: opts.dashboardConversationId || null, from_staff_name: opts.fromStaffName || null,
    client_message_id: opts.clientMessageId || null,
  };
  if (opts.silent) return row;

  const previewMap = { text: opts.body || "", image: "📷 Photo", file: "📎 " + (opts.fileName || "File"), audio: "🎤 Voice message" };
  const notifyBody = opts.urgent ? "🔴 Urgent: " + (previewMap[opts.type] || "New message") : (previewMap[opts.type] || "New message");
  let notifyPromise;
  if (opts.groupId) {
    const members = await env.NOIR_DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(opts.groupId).all();
    const others = members.results.map((m) => fromNoirDept(m.department_id)).filter((d) => d !== opts.from);
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
  // Departments are icon-only by design - no photoUrl here even if the
  // (now write-disabled) photo_path column still has a stale value.
  return { id: row.id, name: row.name, contactName: row.contact_name, onDuty: !!row.on_duty };
}
// Maintenance tickets live in the dashboard's noir-house-db, but pinning and
// escalation tracking have no columns there (Hotel Ping grew those features
// after that table was created), so they stay in a small local companion
// table keyed by the ticket's (dashboard) id.
async function ticketMetaMap(env, ticketIds) {
  const ids = [...new Set(ticketIds)];
  if (!ids.length) return {};
  const rows = await env.DB.prepare(
    `SELECT rowid, * FROM maintenance_ticket_meta WHERE ticket_id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all();
  const byTicket = {};
  rows.results.forEach((m) => { byTicket[m.ticket_id] = m; });
  return byTicket;
}
function mergeTicketRow(core, meta) {
  return {
    id: core.id,
    room_number: core.room_number,
    description: core.description,
    photo_path: core.photo_path,
    voice_path: core.voice_path,
    voice_duration: core.voice_duration,
    status: core.status,
    priority: core.priority,
    guest_present: core.guest_present,
    deadline: core.deadline,
    created_by: fromNoirDept(core.creator_dept),
    created_at: core.created_at,
    updated_at: core.updated_at,
    resolved_at: core.resolved_at,
    pinned_at: meta ? meta.pinned_at : null,
    escalation_level: meta ? meta.escalation_level : 0,
    escalated_at: meta ? meta.escalated_at : null,
    owner_staff_id: core.owner_staff_id,
    sort_order: meta ? meta.sort_order : null,
    ticket_number: meta ? meta.rowid : null,
  };
}
function rowToTicket(row) {
  return {
    id: row.id,
    ticketNumber: row.ticket_number || undefined,
    roomNumber: row.room_number || undefined,
    description: row.description,
    photoUrl: row.photo_path ? "/uploads/" + row.photo_path : undefined,
    voiceUrl: row.voice_path ? "/uploads/" + row.voice_path : undefined,
    voiceDuration: row.voice_duration || undefined,
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
function noirBlockerRow(r) {
  return {
    id: r.id,
    department_id: fromNoirDept(r.department_id),
    waiting_on: fromNoirDept(r.waiting_on),
    reason: r.reason,
    created_by: r.created_by_staff_id,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  };
}
function rowToTicketReply(row) {
  return { id: row.id, ticketId: row.ticket_id, from: row.from_dept, text: row.body, createdAt: row.created_at };
}
function noirReplyRow(r) {
  return { id: r.id, ticket_id: r.ticket_id, from_dept: fromNoirDept(r.from_department_id), body: r.body, created_at: r.created_at };
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
// asset_requests has no department column on the dashboard side, only a
// staff FK - department-level ownership is resolved via a join (see the
// /api/assets handlers), and this maps that joined row back to the local
// shape rowToAssetRequest expects.
function noirAssetRow(r) {
  return {
    id: r.id,
    item_name: r.item_name,
    notes: r.notes,
    status: r.status,
    requested_by: fromNoirDept(r.requester_dept),
    created_at: r.created_at,
    updated_at: r.updated_at,
    returned_at: r.returned_at,
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
// Groups live in the dashboard's noir-house-db now. Its groups table has no
// shared_at column (a feature Hotel Ping added later), so that stays in a
// small local companion table keyed by the group's (dashboard) id; created_by
// is a staff FK there rather than a department, so the creating department
// is resolved via a join to staff, same pattern as maintenance tickets.
// Returns the department slug that created a group, or null if the group
// doesn't exist - used by the many "only the creating department can..."
// checks on stations/runsheet/archive/delete without repeating the join.
async function groupCreatorDept(env, groupId) {
  const row = await env.NOIR_DB.prepare(
    `SELECT s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
  ).bind(groupId).first();
  return row ? fromNoirDept(row.creator_dept) : null;
}
async function groupMetaMap(env, groupIds) {
  const ids = [...new Set(groupIds)];
  if (!ids.length) return {};
  const rows = await env.DB.prepare(
    `SELECT * FROM group_meta WHERE group_id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all();
  const byGroup = {};
  rows.results.forEach((m) => { byGroup[m.group_id] = m; });
  return byGroup;
}
function mergeGroupRow(core, meta) {
  return {
    id: core.id,
    name: core.name,
    created_by: fromNoirDept(core.creator_dept),
    created_at: core.created_at,
    archived_at: core.archived_at,
    shared_at: meta ? meta.shared_at : null,
    description: core.description,
    event_date: core.event_date,
    guest_count: core.guest_count,
    location: core.location,
  };
}
function rowToStation(row) {
  return {
    id: row.id, groupId: row.group_id, title: row.title, category: row.category || undefined,
    description: row.description || undefined, icon: row.icon || undefined,
    assignedDeptId: row.assigned_dept_id || undefined, confirmedAt: row.confirmed_at || undefined,
    confirmedByName: row.confirmed_by_name || undefined, createdByName: row.created_by_name || undefined,
    position: row.position,
  };
}
function noirStationRow(r) {
  return {
    id: r.id, group_id: r.group_id, title: r.title, category: r.category, description: r.description, icon: r.icon,
    assigned_dept_id: r.assigned_department_id ? fromNoirDept(r.assigned_department_id) : null,
    confirmed_at: r.confirmed_at, confirmed_by_name: r.confirmed_by_name, created_by_name: r.created_by_name,
    position: r.position,
  };
}
function rowToRunsheetItem(row) {
  return {
    id: row.id, groupId: row.group_id, timeLabel: row.time_label, title: row.title,
    description: row.description || undefined, teamLabel: row.team_label || undefined, position: row.position,
    createdByName: row.created_by_name || undefined,
  };
}
async function reactionsMap(env, messageIds) {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return {};
  const rows = await env.DB.prepare(
    `SELECT message_id, department_id, emoji FROM message_reactions WHERE message_id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all();
  const byMessage = {};
  rows.results.forEach((r) => {
    byMessage[r.message_id] = byMessage[r.message_id] || [];
    byMessage[r.message_id].push({ emoji: r.emoji, from: r.department_id });
  });
  return byMessage;
}
function attachReactions(messages, map) {
  messages.forEach((m) => { m.reactions = map[m.id] || []; });
  return messages;
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
      options: JSON.parse(row.poll_options || "[]"),
      votes: JSON.parse(row.poll_votes || "{}"),
    } : undefined,
    escalationLevel: row.escalation_level || 0,
    affectsGuest: !!row.affects_guest,
    staffName: hide ? null : (row.from_staff_name || undefined),
  };
}
function rowToStaff(row) {
  return {
    id: row.id, name: row.name, departmentId: row.department_id, isAdmin: !!row.is_admin, createdAt: row.created_at,
    profileComplete: !!row.profile_complete, statusLine: row.status_line || undefined, phone: row.phone || undefined,
    role: row.role || undefined, photoUrl: row.photo_url || undefined, headDepts: row.head_depts || undefined,
  };
}

function rowToNote(row) {
  return {
    id: row.id, title: row.title || undefined, body: row.body || undefined,
    fileUrl: row.file_path ? "/uploads/" + row.file_path : undefined,
    fileSize: row.file_size || undefined, duration: row.duration || undefined,
    transcript: row.transcript || undefined, createdAt: row.created_at,
  };
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

// /uploads/:key (see below) is fetched by plain <img>/<video>/<audio> tags,
// which can't carry an Authorization header - so file access there is
// proven with the session token instead, either the HttpOnly login cookie
// (desktop/normal browsing) or a ?t= query param carrying the same token
// (iOS, where a home-screen PWA's native media element doesn't reliably
// send the cookie on its own request - the query param is what actually
// reaches the server in that case). Checked against the FILE'S OWN hotel
// (from its key prefix), not the caller's current hotel context, so a
// session only ever unlocks files belonging to that same hotel.
function parseCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
async function hasValidSessionCookie(noirDb, request, url) {
  const token = parseCookie(request, "hp_session") || (url && url.searchParams.get("t"));
  if (!token) return false;
  const tokenHash = await sha256Hex(token);
  const row = await noirDb.prepare(
    `SELECT ss.id FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
     WHERE ss.token_hash = ? AND ss.ended_at IS NULL AND ss.expires_at > ? AND s.active = 1`
  ).bind(tokenHash, new Date().toISOString()).first();
  return !!row;
}
function sessionCookieHeader(token) {
  return "hp_session=" + token + "; Path=/; Max-Age=" + (NOIR_SESSION_MINUTES * 60) + "; HttpOnly; Secure; SameSite=Lax";
}
const CLEAR_SESSION_COOKIE = "hp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

async function staffFromToken(env, request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.NOIR_DB.prepare(
    `SELECT ss.id AS session_id, s.id AS staff_id, s.display_name, s.role, s.department_id, s.active
     FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
     WHERE ss.token_hash = ? AND ss.ended_at IS NULL AND ss.expires_at > ? AND s.active = 1`
  ).bind(tokenHash, new Date().toISOString()).first();
  if (!row) return null;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NOIR_SESSION_MINUTES * 60000).toISOString();
  await env.NOIR_DB.prepare("UPDATE staff_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
    .bind(now.toISOString(), expiresAt, row.session_id).run();
  return noirIdentity({ id: row.staff_id, display_name: row.display_name, role: row.role, department_id: row.department_id });
}

// Admins can VIEW another department's conversations ("Viewing as"), but nobody -
// admin included - may act or read AS a department they aren't signed in as unless
// this explicitly allows it. Never trust a "self"/"from" field on its own.
function canViewAsSelf(requester, self) {
  if (self === requester.department_id || requester.is_admin) return true;
  return !!(requester.head_depts && requester.head_depts.includes(self));
}

// ---- Hotel isolation ----
// Every hotel gets its own physically separate D1 database (and its own
// R2 bucket for attachments/voice notes) - not a hotel_id column shared
// inside one database. A missing WHERE clause in any of the ~300 queries
// below literally cannot leak another hotel's row, because that row does
// not exist in the connection this request resolves to. The production
// hotel (no X-Hotel-Slug header, or "main") is bound to exactly the same
// env.DB / env.NOIR_DB / env.UPLOADS / NOIR_HOTEL_ID as before this change
// - zero behavior change for the live hotel. A new hotel is added here by
// provisioning its own D1 database + R2 bucket and adding one line.
// Single source of truth for which hotels exist, used both per-request
// (resolveHotel, below) and by the cron job (scheduled(), at the bottom of
// this file) so a newly provisioned hotel's overdue messages/tickets get
// escalated too, not just the main hotel's.
function hotelRegistry(env) {
  // Object.create(null) rather than {} - the slug comes straight off an
  // inbound header, and a plain object literal would resolve a slug like
  // "__proto__" or "constructor" to a real (inherited) property instead of
  // undefined, so a malformed lookup crashes the request instead of
  // cleanly falling through to resolveHotel()'s "Unknown hotel" response.
  const registry = Object.create(null);
  registry.main = { slug: "main", db: env.DB, noirDb: env.NOIR_DB, uploads: env.UPLOADS, hotelId: NOIR_HOTEL_ID, hasDashboardBridge: true };
  // Synthetic test tenants (b-f) used for multi-hotel stress testing -
  // each its own DB + bucket, listed here so both resolveHotel() and the
  // cron job automatically pick up every one that's provisioned.
  ["b", "c", "d", "e", "f", "g", "h", "i", "j"].forEach((letter) => {
    const dbBinding = env["DB_HOTEL" + letter.toUpperCase()];
    if (!dbBinding) return;
    const slug = "hotel" + letter;
    registry[slug] = {
      slug, db: dbBinding, noirDb: dbBinding,
      uploads: env["UPLOADS_HOTEL" + letter.toUpperCase()] || env.UPLOADS,
      hotelId: slug + "-test-tenant", hasDashboardBridge: false,
    };
  });
  return registry;
}
function resolveHotel(request, env, url) {
  const slug = (request.headers.get("x-hotel-slug") || url.searchParams.get("hotel") || "main").trim().toLowerCase();
  const hotel = hotelRegistry(env)[slug];
  if (!hotel) return null;
  return {
    slug,
    hotelId: hotel.hotelId,
    hasDashboardBridge: hotel.hasDashboardBridge,
    env: Object.assign({}, env, { DB: hotel.db, NOIR_DB: hotel.noirDb, UPLOADS: hotel.uploads }),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return json({}, 204);

    const resolvedHotel = resolveHotel(request, env, url);
    if (!resolvedHotel) return json({ error: "Unknown hotel" }, 400);
    const rawEnv = env;
    env = resolvedHotel.env;
    const resolvedNoirHotelId = resolvedHotel.hotelId;
    // R2 keys for a non-main hotel are prefixed so a plain <img>/<audio> src
    // (which can't carry the X-Hotel-Slug header) still resolves to the
    // right bucket via the /uploads/:key GET handler below.
    const hotelKeyPrefix = resolvedHotel.slug === "main" ? "" : resolvedHotel.slug + "/";

    try {
      // ---- Uploaded files (R2) ----
      if (method === "GET" && p.startsWith("/uploads/")) {
        const key = decodeURIComponent(p.slice("/uploads/".length));
        // Keyed by the hotel prefix baked into the R2 key itself (see
        // hotelKeyPrefix above), not by X-Hotel-Slug - a plain <img>/<audio>
        // src can't carry a custom header, so the key has to be self-describing.
        // Resolved against the full hotel registry (not a single hardcoded
        // prefix) so every synthetic/real hotel's bucket routes correctly.
        const slashIdx = key.indexOf("/");
        const keyPrefixSlug = slashIdx === -1 ? "" : key.slice(0, slashIdx);
        const uploadsRegistry = hotelRegistry(rawEnv);
        const owningHotel = (keyPrefixSlug && uploadsRegistry[keyPrefixSlug]) ? uploadsRegistry[keyPrefixSlug] : uploadsRegistry.main;
        const bucket = owningHotel.uploads;
        if (!bucket) return json({ error: "Not found" }, 404);
        // The cookie alone isn't enough here - see hasValidSessionCookie's
        // own note on why a ?t= fallback exists (iOS home-screen PWAs don't
        // reliably send it on the media element's own request) - but a
        // valid session, one way or the other, is still required.
        if (!(await hasValidSessionCookie(owningHotel.noirDb, request, url))) {
          return json({ error: "Not signed in" }, 401);
        }
        // Safari's <audio>/<video> won't play an MP4 at all unless the
        // server honours byte-range requests - it probes with a Range
        // header before it'll commit to playing, and a plain 200 with the
        // whole body (fine for Chrome) makes it silently refuse to decode.
        // R2 will parse the browser's own Range header directly, but it
        // always reports back an obj.range (covering the whole object when
        // no Range header was sent) - so whether to answer 206 is decided
        // by whether the request actually asked for one, not by obj.range.
        const hasRangeRequest = request.headers.has("Range");
        const obj = await bucket.get(key, hasRangeRequest ? { range: request.headers } : undefined);
        if (!obj) return json({ error: "Not found" }, 404);
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("Accept-Ranges", "bytes");
        if (hasRangeRequest && obj.range) {
          const start = obj.range.offset || 0;
          const len = obj.range.length != null ? obj.range.length : obj.size - start;
          const end = start + len - 1;
          headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
          headers.set("Content-Length", String(len));
          return new Response(obj.body, { status: 206, headers });
        }
        headers.set("Content-Length", String(obj.size));
        return new Response(obj.body, { headers });
      }

      if (!p.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      // ---- External integration (own API-key auth, not a staff session) ----
      if (method === "POST" && p === "/api/external/notify") {
        const apiKey = request.headers.get("x-api-key") || "";
        if (!env.EXTERNAL_API_KEY || apiKey !== env.EXTERNAL_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        // EXTERNAL_API_KEY is one secret for the whole Worker, not one per
        // hotel - without this, holding that single key would let a caller
        // write into ANY hotel just by changing X-Hotel-Slug. Only a hotel
        // actually wired to the dashboard bridge may accept these calls at
        // all, so a synthetic test tenant (or any future hotel that never
        // got its own integration) can't be reached this way regardless of
        // whether the key is valid.
        if (!resolvedHotel.hasDashboardBridge) {
          return json({ error: "This hotel has no dashboard integration" }, 403);
        }
        const body = await readJsonBody(request);
        const idempotencyKey = String(body.idempotencyKey || "").trim();
        const departmentId = body.departmentId;
        const message = String(body.message || "").trim();
        // Optional: present only for a direct (person-to-department) message on
        // the dashboard's side, not an ordinary department-wide one. Stored so
        // a reply from Hotel Ping can be threaded back to the same person via
        // replyToConversationId, instead of landing in the department's
        // general inbox.
        const conversationId = body.conversationId ? String(body.conversationId).trim() : null;
        // Required: the real one of our 8 departments this message is
        // actually from (a ticket, a report from a real team) - it's
        // delivered as if that department messaged directly. There's no
        // "unattributed" fallback anymore - every message needs a real
        // sender, so a caller that can't supply one gets an error instead
        // of a fake "Head Office" contact standing in for it.
        const fromDepartmentId = body.fromDepartmentId ? String(body.fromDepartmentId).trim() : null;
        if (!idempotencyKey) return json({ error: "idempotencyKey is required" }, 400);
        if (!DEPT_IDS.has(departmentId)) return json({ error: "Unknown department" }, 400);
        if (!message) return json({ error: "message is required" }, 400);
        if (!fromDepartmentId || !DEPT_IDS.has(fromDepartmentId)) {
          return json({ error: "fromDepartmentId is required and must be a real department" }, 400);
        }
        if (fromDepartmentId === departmentId) {
          return json({ error: "fromDepartmentId can't be the same as the target department" }, 400);
        }

        const existing = await env.DB.prepare(
          "SELECT message_id FROM external_notifications WHERE idempotency_key = ?"
        ).bind(idempotencyKey).first();
        if (existing) {
          return json({ ok: true, duplicate: true, messageId: existing.message_id });
        }

        const row = await insertMessage(env, ctx, {
          from: fromDepartmentId, to: departmentId, type: "text",
          body: message,
          dashboardConversationId: conversationId,
        });
        await env.DB.prepare(
          "INSERT INTO external_notifications (idempotency_key, message_id, created_at) VALUES (?, ?, ?)"
        ).bind(idempotencyKey, row.id, new Date().toISOString()).run();

        return json({ ok: true, duplicate: false, messageId: row.id }, 201);
      }

      // Same auth/idempotency pattern as /api/external/notify, for a guest
      // request created on the dashboard's side to land in our own
      // guest_requests table, always routed to reception (foh) - never
      // broadcast to a department head.
      if (method === "POST" && p === "/api/external/guest-requests") {
        const apiKey = request.headers.get("x-api-key") || "";
        if (!env.EXTERNAL_API_KEY || apiKey !== env.EXTERNAL_API_KEY) {
          return json({ error: "Unauthorized" }, 401);
        }
        // Same reasoning as /api/external/notify above: EXTERNAL_API_KEY is
        // one shared secret, not per-hotel, so this must independently
        // refuse any hotel that isn't actually wired to the dashboard.
        if (!resolvedHotel.hasDashboardBridge) {
          return json({ error: "This hotel has no dashboard integration" }, 403);
        }
        const body = await readJsonBody(request);
        const idempotencyKey = String(body.idempotencyKey || "").trim();
        const roomNumber = String(body.roomNumber || "").trim();
        const requestText = String(body.requestText || "").trim();
        const guestReference = body.guestReference ? String(body.guestReference).trim().slice(0, 80) : null;
        if (!idempotencyKey) return json({ error: "idempotencyKey is required" }, 400);
        if (!roomNumber) return json({ error: "roomNumber is required" }, 400);
        if (!requestText) return json({ error: "requestText is required" }, 400);

        const existing = await env.DB.prepare(
          "SELECT request_id FROM external_guest_request_keys WHERE idempotency_key = ?"
        ).bind(idempotencyKey).first();
        if (existing) {
          return json({ ok: true, duplicate: true, id: existing.request_id });
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const text = guestReference ? requestText + " (" + guestReference + ")" : requestText;
        await env.DB.prepare(
          "INSERT INTO guest_requests (id, room_number, request_text, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)"
        ).bind(id, roomNumber, text, now, now).run();
        await env.DB.prepare(
          "INSERT INTO external_guest_request_keys (idempotency_key, request_id, created_at) VALUES (?, ?, ?)"
        ).bind(idempotencyKey, id, now).run();

        const notifyPromise = notifyDepartment(env, "foh", {
          title: "🛎️ Guest request, Room " + roomNumber,
          body: text,
          url: "/",
          tag: "hotel-ping-guest-request-" + id,
        }, null).catch((e) => console.error("notifyDepartment (external guest request) error:", e && e.stack || e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ ok: true, duplicate: false, id }, 201);
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

        const notifyPromise = notifyDepartment(env, "foh", {
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
      if (p !== "/api/auth/login" && p !== "/api/signup") {
        const authed = await staffFromToken(env, request);
        if (!authed) return json({ error: "Not signed in" }, 401);
        // Head-of-department contacts (see department_heads below) are a
        // personal identity, not tied to whichever department someone is
        // logged into - a staff member can act as "head_kitchen" only if
        // they're specifically assigned there, which this looks up once
        // per request so every permission check below can treat it as a
        // plain extra department on their account.
        const headRows = await env.DB.prepare("SELECT department_id FROM department_heads WHERE staff_id = ?").bind(authed.id).all();
        authed.head_depts = headRows.results.map((r) => "head_" + r.department_id);
        const photoRow = await env.DB.prepare("SELECT photo_path FROM staff_photos WHERE staff_id = ?").bind(authed.id).first();
        if (photoRow) authed.photo_url = "/uploads/" + photoRow.photo_path;
        request._staff = authed;
      }

      if (method === "POST" && p === "/api/auth/login") {
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim();
        const pin = String(body.pin || "");
        if (!name || (LOGIN_REQUIRE_PIN && !pin)) return json({ error: "Name and PIN are required" }, 400);

        const identifier = "hotelping:" + name.toLowerCase();
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await env.NOIR_DB.prepare("DELETE FROM login_failures WHERE created_at <= ?").bind(since).run();
        const failCount = await env.NOIR_DB.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE identifier = ? AND created_at > ?").bind(identifier, since).first();
        if (failCount && failCount.n >= 8) {
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
        }

        const candidates = await env.NOIR_DB.prepare(
          "SELECT id, display_name, role, department_id, pin_hash, pin_salt FROM staff WHERE hotel_id = ? AND active = 1"
        ).bind(resolvedNoirHotelId).all();

        let matched = null;
        if (LOGIN_REQUIRE_PIN) {
          for (const candidate of candidates.results) {
            if ((await hashPin(pin, candidate.pin_salt)) === candidate.pin_hash) { matched = candidate; break; }
          }
        } else {
          matched = candidates.results.find((c) => c.display_name.toLowerCase() === name.toLowerCase()) || null;
        }
        if (!matched) {
          await env.NOIR_DB.prepare("INSERT INTO login_failures (id, identifier, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), identifier, new Date().toISOString()).run();
          return json({ error: "Incorrect name or PIN" }, 401);
        }

        const token = newToken();
        const tokenHash = await sha256Hex(token);
        const sessionId = crypto.randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + NOIR_SESSION_MINUTES * 60000).toISOString();
        await env.NOIR_DB.prepare(
          `INSERT INTO staff_sessions (id, staff_id, department_id, token_hash, expires_at, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(sessionId, matched.id, matched.department_id, tokenHash, expiresAt, now.toISOString(), now.toISOString()).run();

        const identity = noirIdentity(matched);
        const photoRow = await env.DB.prepare("SELECT photo_path FROM staff_photos WHERE staff_id = ?").bind(matched.id).first();
        if (photoRow) identity.photo_url = "/uploads/" + photoRow.photo_path;
        return json({ token, staff: rowToStaff(identity) }, 200, { "Set-Cookie": sessionCookieHeader(token) });
      }

      // ---- Self-service signup: the GM tells someone directly to sign up,
      // so a name + department is all that's needed here - the GM already
      // knows who to expect, and just has to accept or deny it. Nothing is
      // usable until then: this only queues a request, it never creates a
      // real staff account by itself. ----
      if (method === "POST" && p === "/api/signup") {
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim();
        const departmentId = body.departmentId;
        if (!name) return json({ error: "Name is required" }, 400);
        if (!DEPT_IDS.has(departmentId)) return json({ error: "Unknown department" }, 400);
        const existing = await env.DB.prepare(
          "SELECT id FROM signup_requests WHERE LOWER(name) = LOWER(?) AND status = 'pending'"
        ).bind(name).first();
        if (existing) return json({ error: "A request for that name is already waiting on approval" }, 409);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO signup_requests (id, name, department_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
        ).bind(id, name, departmentId, new Date().toISOString()).run();
        return json({ ok: true }, 201);
      }

      if (method === "GET" && p === "/api/signup-requests") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const rows = await env.DB.prepare(
          "SELECT id, name, department_id, created_at FROM signup_requests WHERE status = 'pending' ORDER BY created_at ASC"
        ).all();
        return json({ requests: rows.results.map((r) => ({ id: r.id, name: r.name, departmentId: r.department_id, createdAt: r.created_at })) });
      }

      if (method === "POST" && p.startsWith("/api/signup-requests/") && p.endsWith("/approve")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/signup-requests/".length, -"/approve".length));
        const reqRow = await env.DB.prepare("SELECT * FROM signup_requests WHERE id = ? AND status = 'pending'").bind(id).first();
        if (!reqRow) return json({ error: "Not found" }, 404);
        const staffId = crypto.randomUUID();
        const salt = randomSaltHex();
        // PIN checking is off pre-launch (see LOGIN_REQUIRE_PIN), so this
        // password is never actually used to sign in - it only exists to
        // satisfy NOIR_DB's own not-null column until a real PIN is set.
        const throwawayPin = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          `INSERT INTO staff (id, hotel_id, department_id, display_name, role, pin_hash, pin_salt, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'staff', ?, ?, 1, ?, ?)`
        ).bind(staffId, resolvedNoirHotelId, toNoirDept(reqRow.department_id), reqRow.name, await hashPin(throwawayPin, salt), salt, now, now).run();
        await env.DB.prepare("UPDATE signup_requests SET status = 'approved', decided_at = ? WHERE id = ?").bind(now, id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/signup-requests/") && p.endsWith("/deny")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/signup-requests/".length, -"/deny".length));
        await env.DB.prepare(
          "UPDATE signup_requests SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'"
        ).bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/auth/logout") {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
        if (token) {
          const tokenHash = await sha256Hex(token);
          await env.NOIR_DB.prepare("UPDATE staff_sessions SET ended_at = ? WHERE token_hash = ? AND ended_at IS NULL").bind(new Date().toISOString(), tokenHash).run();
        }
        return json({ ok: true }, 200, { "Set-Cookie": CLEAR_SESSION_COOKIE });
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
          await env.DB.prepare("UPDATE push_subscriptions SET staff_id = ?, p256dh = ?, auth = ?, department_id = ?, is_admin = ? WHERE id = ?")
            .bind(request._staff.id, sub.keys.p256dh, sub.keys.auth, request._staff.department_id, request._staff.is_admin ? 1 : 0, existing.id).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO push_subscriptions (id, staff_id, endpoint, p256dh, auth, created_at, department_id, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), request._staff.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString(), request._staff.department_id, request._staff.is_admin ? 1 : 0).run();
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

      // ---- Self-service profile setup: any signed-in user can edit their own name/PIN ----
      // Staff records now live in the dashboard's database. status_line/phone
      // have no column there, so those two fields are accepted (to avoid
      // breaking older clients that still send them) but not persisted.
      if (method === "PATCH" && p === "/api/profile") {
        const id = request._staff.id;
        const body = await readJsonBody(request);
        if (typeof body.name === "string" && body.name.trim()) {
          await env.NOIR_DB.prepare("UPDATE staff SET display_name = ? WHERE id = ?").bind(body.name.trim(), id).run();
        }
        if (typeof body.pin === "string" && body.pin) {
          if (!PIN_RE.test(body.pin)) return json({ error: "PIN must be 4-6 digits" }, 400);
          const currentPin = typeof body.currentPin === "string" ? body.currentPin : "";
          const existing = await env.NOIR_DB.prepare("SELECT pin_hash, pin_salt FROM staff WHERE id = ?").bind(id).first();
          if (!existing || (await hashPin(currentPin, existing.pin_salt)) !== existing.pin_hash) {
            return json({ error: "Current PIN is incorrect" }, 400);
          }
          const salt = randomSaltHex();
          await env.NOIR_DB.prepare("UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ?").bind(await hashPin(body.pin, salt), salt, id).run();
        }
        const row = await env.NOIR_DB.prepare("SELECT id, display_name, role, department_id FROM staff WHERE id = ?").bind(id).first();
        return json({ staff: rowToStaff(noirIdentity(row)) });
      }

      // ---- Staff directory: any signed-in user can read names/departments ----
      if (method === "GET" && p === "/api/staff") {
        const rows = await env.NOIR_DB.prepare(
          "SELECT id, display_name, role, department_id FROM staff WHERE hotel_id = ? AND active = 1 ORDER BY display_name"
        ).bind(resolvedNoirHotelId).all();
        const photoRows = await env.DB.prepare("SELECT staff_id, photo_path FROM staff_photos").all();
        const photoByStaffId = Object.fromEntries(photoRows.results.map((r) => [r.staff_id, "/uploads/" + r.photo_path]));
        return json({ staff: rows.results.map((r) => rowToStaff({ ...noirIdentity(r), photo_url: photoByStaffId[r.id] })) });
      }

      // ---- Staff management now happens on the dashboard side (owner-provisioned) ----
      // Creating, removing and PIN resets stay dashboard-owned (that's where
      // logins and the role string that grants admin access actually live).
      // Name and department reassignment are safe, low-risk fields this
      // worker already writes into NOIR_DB elsewhere (see /api/profile), so
      // the Hotel Setup > Team panel is allowed to edit those two directly.
      if (method === "PATCH" && p.startsWith("/api/staff/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/staff/".length));
        const body = await readJsonBody(request);
        if (typeof body.name === "string" && body.name.trim()) {
          await env.NOIR_DB.prepare("UPDATE staff SET display_name = ? WHERE id = ?").bind(body.name.trim(), id).run();
        }
        if (typeof body.departmentId === "string") {
          if (!DEPT_IDS.has(body.departmentId)) return json({ error: "Unknown department" }, 400);
          await env.NOIR_DB.prepare("UPDATE staff SET department_id = ? WHERE id = ?").bind(toNoirDept(body.departmentId), id).run();
        }
        if (typeof body.pin === "string") {
          return json({ error: "PIN resets are managed from the dashboard, not from Hotel Ping" }, 410);
        }
        const row = await env.NOIR_DB.prepare("SELECT id, display_name, role, department_id FROM staff WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found" }, 404);
        return json({ staff: rowToStaff(noirIdentity(row)) });
      }
      // /api/staff/:id/photo (below) is a personal-photo upload, not
      // account creation/deletion - it must stay excluded from this block,
      // or every photo upload gets wrongly rejected as an account change.
      if ((p === "/api/staff" || p.startsWith("/api/staff/")) && !p.endsWith("/photo")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        if (method === "POST" || method === "DELETE") {
          return json({ error: "Staff accounts are now managed from the dashboard, not from Hotel Ping" }, 410);
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

      // A department is an icon, never a photo - individual people (staff,
      // and especially department heads) are the only ones who get a photo.
      // This used to be a self-service "department photo" endpoint here;
      // removed so there's no code path left that can put a photo on a
      // department. See /api/staff/:id/photo below for the real, personal
      // photo every staff member (not just heads) can set on themselves.

      // ---- Staff photos (personal, not the department's shared photo) ----
      // Used for head-of-department contacts, where the point is a real,
      // recognizable, named person - not the generic department icon.
      if (method === "POST" && p.startsWith("/api/staff/") && p.endsWith("/photo")) {
        const id = decodeURIComponent(p.slice("/api/staff/".length, -"/photo".length));
        const requester = request._staff;
        if (requester.id !== id && !requester.is_admin) return json({ error: "You can only change your own photo" }, 403);
        // An admin acting on someone else's behalf must be pointed at a real,
        // active staff member of THIS hotel - otherwise this would happily
        // create an orphaned photo row keyed to any id string the caller
        // supplies, including one borrowed from a different hotel.
        if (requester.id !== id) {
          const targetStaff = await env.NOIR_DB.prepare("SELECT id FROM staff WHERE id = ? AND hotel_id = ? AND active = 1").bind(id, resolvedNoirHotelId).first();
          if (!targetStaff) return json({ error: "Staff member not found" }, 404);
        }
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Photo is required" }, 400);
        if (base64ExceedsBytes(body.fileBase64, 8 * 1024 * 1024)) return json({ error: "Photo is too large (8MB max)" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = hotelKeyPrefix + "staff-" + id + "-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        await env.DB.prepare(
          "INSERT INTO staff_photos (staff_id, photo_path, updated_at) VALUES (?, ?, ?) ON CONFLICT(staff_id) DO UPDATE SET photo_path = excluded.photo_path, updated_at = excluded.updated_at"
        ).bind(id, safeName, new Date().toISOString()).run();
        return json({ photoUrl: "/uploads/" + safeName });
      }

      if (method === "DELETE" && p.startsWith("/api/staff/") && p.endsWith("/photo")) {
        const id = decodeURIComponent(p.slice("/api/staff/".length, -"/photo".length));
        const requester = request._staff;
        if (requester.id !== id && !requester.is_admin) return json({ error: "You can only change your own photo" }, 403);
        if (requester.id !== id) {
          const targetStaff = await env.NOIR_DB.prepare("SELECT id FROM staff WHERE id = ? AND hotel_id = ? AND active = 1").bind(id, resolvedNoirHotelId).first();
          if (!targetStaff) return json({ error: "Staff member not found" }, 404);
        }
        await env.DB.prepare("DELETE FROM staff_photos WHERE staff_id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---- Hotel profile: this hotel's own name + logo, shown on the
      // Profile page header. Separate from the Hotel Ping product brand,
      // which only appears in the "Powered by" footer. ----
      if (method === "GET" && p === "/api/hotel-profile") {
        const row = await env.DB.prepare("SELECT * FROM hotel_profile WHERE id = 'default'").first();
        return json({ name: row ? row.name : null, logoUrl: row && row.logo_path ? "/uploads/" + row.logo_path : null });
      }

      if (method === "PUT" && p === "/api/hotel-profile") {
        if (!request._staff.is_admin) return json({ error: "Admin only" }, 403);
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim();
        await env.DB.prepare(
          "INSERT INTO hotel_profile (id, name, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at"
        ).bind(name || null, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/hotel-profile/logo") {
        if (!request._staff.is_admin) return json({ error: "Admin only" }, 403);
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Logo is required" }, 400);
        if (base64ExceedsBytes(body.fileBase64, 8 * 1024 * 1024)) return json({ error: "Logo is too large (8MB max)" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = hotelKeyPrefix + "hotel-logo-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        await env.DB.prepare(
          "INSERT INTO hotel_profile (id, logo_path, updated_at) VALUES ('default', ?, ?) ON CONFLICT(id) DO UPDATE SET logo_path = excluded.logo_path, updated_at = excluded.updated_at"
        ).bind(safeName, new Date().toISOString()).run();
        return json({ logoUrl: "/uploads/" + safeName });
      }

      if (method === "DELETE" && p === "/api/hotel-profile/logo") {
        if (!request._staff.is_admin) return json({ error: "Admin only" }, 403);
        await env.DB.prepare("UPDATE hotel_profile SET logo_path = NULL WHERE id = 'default'").run();
        return json({ ok: true });
      }

      // ---- Department heads: which specific staff member is the named,
      // directly-reachable contact for each department (see HEAD_DEPT_IDS
      // above and canViewAsSelf/request._staff.head_depts for how this
      // turns into an extra, personal conversation on their account). ----
      if (method === "GET" && p === "/api/department-heads") {
        // Readable by anyone signed in (not just admin) - every department's
        // chat list needs this to know which head contacts to show, and
        // who a head is is meant to be visible, not privileged information.
        const rows = await env.DB.prepare(
          `SELECT dh.department_id, dh.staff_id, sp.photo_path FROM department_heads dh
           LEFT JOIN staff_photos sp ON sp.staff_id = dh.staff_id`
        ).all();
        const staffIds = rows.results.map((r) => r.staff_id);
        let namesById = {};
        if (staffIds.length) {
          const placeholders = staffIds.map(() => "?").join(",");
          const staffRows = await env.NOIR_DB.prepare(`SELECT id, display_name FROM staff WHERE id IN (${placeholders})`).bind(...staffIds).all();
          namesById = Object.fromEntries(staffRows.results.map((s) => [s.id, s.display_name]));
        }
        const heads = {};
        for (const r of rows.results) {
          heads[r.department_id] = {
            staffId: r.staff_id, staffName: namesById[r.staff_id] || "Unknown",
            photoUrl: r.photo_path ? "/uploads/" + r.photo_path : null,
          };
        }
        return json({ heads });
      }

      if (method === "PUT" && p.startsWith("/api/department-heads/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const deptId = decodeURIComponent(p.slice("/api/department-heads/".length));
        if (!DEPT_IDS.has(deptId) || deptId === "gm") return json({ error: "Unknown department" }, 400);
        const body = await readJsonBody(request);
        if (!body.staffId) return json({ error: "staffId is required" }, 400);
        const staffRow = await env.NOIR_DB.prepare("SELECT id, department_id FROM staff WHERE id = ?").bind(body.staffId).first();
        if (!staffRow) return json({ error: "Unknown staff member" }, 404);
        if (fromNoirDept(staffRow.department_id) !== deptId) {
          return json({ error: "That person isn't in this department" }, 400);
        }
        await env.DB.prepare(
          "INSERT INTO department_heads (department_id, staff_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(department_id) DO UPDATE SET staff_id = excluded.staff_id, updated_at = excluded.updated_at"
        ).bind(deptId, body.staffId, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/department-heads/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const deptId = decodeURIComponent(p.slice("/api/department-heads/".length));
        await env.DB.prepare("DELETE FROM department_heads WHERE department_id = ?").bind(deptId).run();
        return json({ ok: true });
      }

      // ---- Floor plans & zone mapper ----
      // Admin-only setup for the location service's "stub" source (and the
      // reference points the "device" source matches against). See
      // resolveLocation() near the top of this file for how these tables
      // get used - this block is just CRUD for the data.
      if (method === "GET" && p === "/api/floors") {
        const floorRows = await env.DB.prepare("SELECT * FROM floors ORDER BY position, created_at").all();
        const zoneRows = await env.DB.prepare("SELECT * FROM zones ORDER BY position, created_at").all();
        const zonesByFloor = {};
        for (const z of zoneRows.results) {
          (zonesByFloor[z.floor_id] = zonesByFloor[z.floor_id] || []).push(z);
        }
        const floors = floorRows.results.map((f) => {
          const zones = zonesByFloor[f.id] || [];
          const top = zones.filter((z) => !z.parent_zone_id);
          const bySubzone = {};
          for (const z of zones) {
            if (z.parent_zone_id) (bySubzone[z.parent_zone_id] = bySubzone[z.parent_zone_id] || []).push(z);
          }
          return {
            id: f.id, name: f.name, position: f.position,
            planImageUrl: f.plan_image_path ? "/uploads/" + f.plan_image_path : null,
            zones: top.map((z) => ({
              id: z.id, name: z.name, lat: z.lat, lng: z.lng,
              subzones: (bySubzone[z.id] || []).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })),
            })),
          };
        });
        return json({ floors });
      }

      if (method === "POST" && p === "/api/floors") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const body = await readJsonBody(request);
        if (!body.name || !body.name.trim()) return json({ error: "Floor name is required" }, 400);
        const id = crypto.randomUUID();
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM floors").first();
        await env.DB.prepare("INSERT INTO floors (id, name, position, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, body.name.trim(), countRow.n, new Date().toISOString()).run();
        return json({ floor: { id, name: body.name.trim(), position: countRow.n, planImageUrl: null, zones: [] } }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/floors/") && !p.includes("/plan")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/floors/".length));
        const body = await readJsonBody(request);
        const existing = await env.DB.prepare("SELECT id FROM floors WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        if (typeof body.name === "string" && body.name.trim()) {
          await env.DB.prepare("UPDATE floors SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
        }
        if (typeof body.position === "number") {
          await env.DB.prepare("UPDATE floors SET position = ? WHERE id = ?").bind(body.position, id).run();
        }
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/floors/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/floors/".length));
        const zoneIds = (await env.DB.prepare("SELECT id FROM zones WHERE floor_id = ?").bind(id).all()).results.map((z) => z.id);
        for (const zid of zoneIds) {
          await env.DB.prepare("DELETE FROM department_zone_stub WHERE zone_id = ?").bind(zid).run();
        }
        await env.DB.prepare("DELETE FROM zones WHERE floor_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM floors WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/floors/") && p.endsWith("/plan")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/floors/".length, -"/plan".length));
        const existing = await env.DB.prepare("SELECT id FROM floors WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Plan image is required" }, 400);
        if (base64ExceedsBytes(body.fileBase64, 8 * 1024 * 1024)) return json({ error: "Plan image is too large (8MB max)" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = hotelKeyPrefix + "floor-" + id + "-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        await env.DB.prepare("UPDATE floors SET plan_image_path = ? WHERE id = ?").bind(safeName, id).run();
        return json({ planImageUrl: "/uploads/" + safeName });
      }

      if (method === "POST" && p === "/api/zones") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const body = await readJsonBody(request);
        if (!body.floorId || !body.name || !body.name.trim()) return json({ error: "floorId and name are required" }, 400);
        const floor = await env.DB.prepare("SELECT id FROM floors WHERE id = ?").bind(body.floorId).first();
        if (!floor) return json({ error: "Unknown floor" }, 404);
        if (body.parentZoneId) {
          const parent = await env.DB.prepare("SELECT id FROM zones WHERE id = ? AND floor_id = ?").bind(body.parentZoneId, body.floorId).first();
          if (!parent) return json({ error: "Unknown parent zone" }, 404);
        }
        const id = crypto.randomUUID();
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM zones WHERE floor_id = ?").bind(body.floorId).first();
        const lat = typeof body.lat === "number" ? body.lat : null;
        const lng = typeof body.lng === "number" ? body.lng : null;
        await env.DB.prepare(
          "INSERT INTO zones (id, floor_id, parent_zone_id, name, position, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, body.floorId, body.parentZoneId || null, body.name.trim(), countRow.n, lat, lng, new Date().toISOString()).run();
        return json({ zone: { id, name: body.name.trim(), lat, lng, subzones: [] } }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/zones/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/zones/".length));
        const existing = await env.DB.prepare("SELECT id FROM zones WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        const body = await readJsonBody(request);
        if (typeof body.name === "string" && body.name.trim()) {
          await env.DB.prepare("UPDATE zones SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
        }
        if (typeof body.lat === "number" && typeof body.lng === "number") {
          await env.DB.prepare("UPDATE zones SET lat = ?, lng = ? WHERE id = ?").bind(body.lat, body.lng, id).run();
        } else if (body.lat === null && body.lng === null) {
          await env.DB.prepare("UPDATE zones SET lat = NULL, lng = NULL WHERE id = ?").bind(id).run();
        }
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/zones/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const id = decodeURIComponent(p.slice("/api/zones/".length));
        const childIds = (await env.DB.prepare("SELECT id FROM zones WHERE parent_zone_id = ?").bind(id).all()).results.map((z) => z.id);
        for (const cid of childIds) {
          await env.DB.prepare("DELETE FROM department_zone_stub WHERE zone_id = ?").bind(cid).run();
        }
        await env.DB.prepare("DELETE FROM zones WHERE parent_zone_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM department_zone_stub WHERE zone_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM zones WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---- Location service test stub: admin sets each department's "current zone" ----
      if (method === "GET" && p === "/api/department-zone-stub") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const rows = await env.DB.prepare(
          `SELECT dzs.department_id, dzs.zone_id, dzs.updated_at, z.name AS zone_name, z.parent_zone_id, f.name AS floor_name
           FROM department_zone_stub dzs JOIN zones z ON z.id = dzs.zone_id JOIN floors f ON f.id = z.floor_id`
        ).all();
        const stubs = {};
        for (const r of rows.results) {
          stubs[r.department_id] = { zoneId: r.zone_id, floorName: r.floor_name, zoneName: r.zone_name, updatedAt: r.updated_at };
        }
        return json({ stubs });
      }

      if (method === "PUT" && p.startsWith("/api/department-zone-stub/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const deptId = decodeURIComponent(p.slice("/api/department-zone-stub/".length));
        if (!DEPT_IDS.has(deptId)) return json({ error: "Unknown department" }, 404);
        const body = await readJsonBody(request);
        if (!body.zoneId) return json({ error: "zoneId is required" }, 400);
        const zone = await env.DB.prepare("SELECT id FROM zones WHERE id = ?").bind(body.zoneId).first();
        if (!zone) return json({ error: "Unknown zone" }, 404);
        await env.DB.prepare(
          "INSERT INTO department_zone_stub (department_id, zone_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(department_id) DO UPDATE SET zone_id = excluded.zone_id, updated_at = excluded.updated_at"
        ).bind(deptId, body.zoneId, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/department-zone-stub/")) {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const deptId = decodeURIComponent(p.slice("/api/department-zone-stub/".length));
        await env.DB.prepare("DELETE FROM department_zone_stub WHERE department_id = ?").bind(deptId).run();
        return json({ ok: true });
      }

      // ---- Housekeeping room status board ----
      // A standalone list of room labels, independent of the SOS zone
      // mapper's rooms. Any signed-in staff can see it (reception often
      // wants a glance); only housekeeping and admins can change it.
      function rowToRoom(row) {
        return {
          id: row.id, label: row.label, status: row.status,
          cleanedAt: row.cleaned_at || null, cleanedByName: row.cleaned_by_name || null,
        };
      }
      const canManageRooms = (staff) => staff.department_id === "housekeeping" || staff.is_admin;

      if (method === "GET" && p === "/api/rooms") {
        const rows = await env.DB.prepare("SELECT * FROM rooms ORDER BY position, created_at").all();
        return json({ rooms: rows.results.map(rowToRoom) });
      }

      if (method === "POST" && p === "/api/rooms") {
        if (!canManageRooms(request._staff)) return json({ error: "Only housekeeping can do that" }, 403);
        const body = await readJsonBody(request);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms").first();
        let pos = countRow.n;
        const now = new Date().toISOString();
        let labels = [];
        if (typeof body.start === "number" && typeof body.end === "number") {
          if (body.end < body.start || body.end - body.start > 300) {
            return json({ error: "Check that range" }, 400);
          }
          const prefix = typeof body.prefix === "string" ? body.prefix : "";
          for (let n = body.start; n <= body.end; n++) labels.push(prefix + n);
        } else if (typeof body.label === "string" && body.label.trim()) {
          labels = [body.label.trim()];
        } else {
          return json({ error: "label, or start/end, is required" }, 400);
        }
        const created = [];
        for (const label of labels) {
          const id = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO rooms (id, label, position, status, created_at) VALUES (?, ?, ?, 'dirty', ?)"
          ).bind(id, label, pos, now).run();
          created.push({ id, label, status: "dirty", cleanedAt: null, cleanedByName: null });
          pos++;
        }
        return json({ rooms: created }, 201);
      }

      if (method === "DELETE" && p.startsWith("/api/rooms/")) {
        if (!canManageRooms(request._staff)) return json({ error: "Only housekeeping can do that" }, 403);
        const id = decodeURIComponent(p.slice("/api/rooms/".length));
        await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/rooms/reset-all") {
        const requester = request._staff;
        if (!canManageRooms(requester)) return json({ error: "Only housekeeping can do that" }, 403);
        await env.DB.prepare("UPDATE rooms SET status = 'dirty', cleaned_at = NULL, cleaned_by_name = NULL").run();
        const rows = await env.DB.prepare("SELECT * FROM rooms ORDER BY position, created_at").all();
        return json({ rooms: rows.results.map(rowToRoom) });
      }

      if (method === "POST" && p.startsWith("/api/rooms/") && (p.endsWith("/clean") || p.endsWith("/dirty"))) {
        const requester = request._staff;
        if (!canManageRooms(requester)) return json({ error: "Only housekeeping can do that" }, 403);
        const clean = p.endsWith("/clean");
        const suffix = clean ? "/clean" : "/dirty";
        const id = decodeURIComponent(p.slice("/api/rooms/".length, -suffix.length));
        const room = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(id).first();
        if (!room) return json({ error: "Not found" }, 404);
        const now = new Date().toISOString();
        if (clean) {
          const wasDirty = room.status !== "clean";
          await env.DB.prepare("UPDATE rooms SET status = 'clean', cleaned_at = ?, cleaned_by_name = ? WHERE id = ?")
            .bind(now, requester.name || null, id).run();
          // One tap - a real message to reception, not just a push ping, so
          // it shows up in the housekeeping/reception thread like any other
          // department update. Only on the dirty->clean transition, so a
          // repeat tap (or a race between two taps) never double-sends it.
          if (wasDirty && requester.department_id !== "foh") {
            await insertMessage(env, ctx, {
              from: requester.department_id, to: "foh", type: "text",
              body: "Room " + room.label + " is clean and ready.",
              roomClean: room.label,
            });
          }
        } else {
          await env.DB.prepare("UPDATE rooms SET status = 'dirty', cleaned_at = NULL, cleaned_by_name = NULL WHERE id = ?").bind(id).run();
        }
        const row = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?").bind(id).first();
        return json({ room: rowToRoom(row) });
      }

      // ---- Conversations ----
      if (method === "GET" && p === "/api/conversations") {
        const self = url.searchParams.get("self");
        if (!ALL_DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const others = Array.from(ALL_DEPT_IDS).filter((id) => id !== self);
        // Was 3 queries x 14 other departments = 42 round-trips per call
        // (p95 ~8s under load even parallelized, since D1 itself was the
        // bottleneck, not request scheduling). Batched into 2 queries total:
        // one window-function query gets every partner's single most-recent
        // message in one pass, one grouped COUNT gets every partner's
        // unread + urgent-unread counts in one pass.
        const [lastRows, unreadRows] = await Promise.all([
          env.DB.prepare(
            `SELECT * FROM (
               SELECT *,
                 CASE WHEN from_dept = ?1 THEN to_dept ELSE from_dept END AS partner,
                 ROW_NUMBER() OVER (
                   PARTITION BY (CASE WHEN from_dept = ?1 THEN to_dept ELSE from_dept END)
                   ORDER BY created_at DESC
                 ) AS rn
               FROM messages
               WHERE from_dept = ?1 OR to_dept = ?1
             ) WHERE rn = 1`
          ).bind(self).all(),
          env.DB.prepare(
            `SELECT from_dept AS partner, COUNT(*) AS n, SUM(CASE WHEN urgent = 1 THEN 1 ELSE 0 END) AS urgent_n
             FROM messages WHERE to_dept = ?1 AND status != 'read' GROUP BY from_dept`
          ).bind(self).all(),
        ]);
        const lastByPartner = {};
        for (const row of lastRows.results) lastByPartner[row.partner] = row;
        const unreadByPartner = {};
        for (const row of unreadRows.results) unreadByPartner[row.partner] = row;
        const conversations = others.map((other) => {
          const last = lastByPartner[other];
          const unread = unreadByPartner[other];
          return {
            departmentId: other,
            lastMessage: last ? rowToMessage(last, self, request._staff.is_admin) : null,
            unreadCount: unread ? unread.n : 0,
            hasUrgentUnread: !!(unread && unread.urgent_n > 0),
          };
        });
        return json({ conversations });
      }

      // ---- Messages ----
      if (method === "GET" && p === "/api/messages") {
        const self = url.searchParams.get("self");
        const other = url.searchParams.get("with");
        if (!ALL_DEPT_IDS.has(self) || !(ALL_DEPT_IDS.has(other) || (other === "dashboard" && self === "gm"))) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const rows = await env.DB.prepare(
          `SELECT * FROM messages WHERE (from_dept = ? AND to_dept = ?) OR (from_dept = ? AND to_dept = ?) ORDER BY created_at ASC`
        ).bind(self, other, other, self).all();
        const messages = rows.results.map((r) => rowToMessage(r, self, request._staff.is_admin)).filter(Boolean);
        const rMap = await reactionsMap(env, messages.map((m) => m.id));
        return json({ messages: attachReactions(messages, rMap) });
      }

      // ---- Groups ----
      if (method === "GET" && p === "/api/groups") {
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const groupRows = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g
           LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC`
        ).all();
        const groupMeta = await groupMetaMap(env, groupRows.results.map((g) => g.id));
        const groups = [];
        for (const g of groupRows.results) {
          const merged = mergeGroupRow(g, groupMeta[g.id]);
          const memberRows = await env.NOIR_DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(g.id).all();
          const members = memberRows.results.map((m) => fromNoirDept(m.department_id));
          const isMember = members.includes(self);
          if (merged.archived_at && !request._staff.is_admin && !merged.shared_at) continue;
          const last = await env.DB.prepare("SELECT * FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").bind(g.id).first();
          const readRow = await env.NOIR_DB.prepare("SELECT last_read_at FROM group_reads WHERE group_id = ? AND department_id = ?").bind(g.id, toNoirDept(self)).first();
          const since = readRow ? readRow.last_read_at : "1970-01-01T00:00:00.000Z";
          const unread = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND from_dept != ? AND created_at > ? AND deleted_at IS NULL"
          ).bind(g.id, self, since).first();
          groups.push({
            id: merged.id, name: merged.name, createdBy: merged.created_by, createdAt: merged.created_at,
            archivedAt: merged.archived_at || undefined, sharedAt: merged.shared_at || undefined,
            description: merged.description || undefined, eventDate: merged.event_date || undefined,
            guestCount: merged.guest_count === null || merged.guest_count === undefined ? undefined : merged.guest_count,
            location: merged.location || undefined,
            members, isMember,
            // A department that isn't a member of this group gets the group's
            // existence and roster (so it can see what it's not part of) but
            // never the content of its messages - only a member, or the GM,
            // may read what was actually said.
            lastMessage: last && (isMember || request._staff.is_admin) ? rowToMessage(last, self, request._staff.is_admin) : null,
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
        await env.NOIR_DB.prepare("INSERT INTO groups (id, hotel_id, name, created_by_staff_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(id, resolvedNoirHotelId, name, request._staff.id, now).run();
        for (const deptId of allMembers) {
          await env.NOIR_DB.prepare("INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)").bind(id, toNoirDept(deptId), now).run();
        }
        const row = { id, name, creator_dept: toNoirDept(self), created_at: now, archived_at: null, description: null, event_date: null, guest_count: null, location: null };
        return json({ group: rowToGroup(mergeGroupRow(row, null), allMembers) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/groups/") && p.split("/").length === 4) {
        const id = decodeURIComponent(p.slice("/api/groups/".length));
        const group = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
        ).bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (fromNoirDept(group.creator_dept) !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can edit its details" }, 403);
        }
        const body = await readJsonBody(request);
        if (typeof body.description === "string") {
          await env.NOIR_DB.prepare("UPDATE groups SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 400) || null, id).run();
        }
        if (typeof body.eventDate === "string" || body.eventDate === null) {
          await env.NOIR_DB.prepare("UPDATE groups SET event_date = ? WHERE id = ?").bind(body.eventDate ? String(body.eventDate).trim().slice(0, 60) : null, id).run();
        }
        if (typeof body.guestCount === "number" || body.guestCount === null) {
          const gc = body.guestCount === null ? null : Math.max(0, Math.round(body.guestCount));
          await env.NOIR_DB.prepare("UPDATE groups SET guest_count = ? WHERE id = ?").bind(gc, id).run();
        }
        if (typeof body.location === "string" || body.location === null) {
          await env.NOIR_DB.prepare("UPDATE groups SET location = ? WHERE id = ?").bind(body.location ? String(body.location).trim().slice(0, 120) : null, id).run();
        }
        const memberRows = await env.NOIR_DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(id).all();
        const row2 = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
        ).bind(id).first();
        const meta2 = (await groupMetaMap(env, [id]))[id];
        return json({ group: rowToGroup(mergeGroupRow(row2, meta2), memberRows.results.map((m) => fromNoirDept(m.department_id))) });
      }

      // ---- Event stations (drag-a-department-icon-in role assignments) ----
      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/stations")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/stations".length));
        const rows = await env.NOIR_DB.prepare(
          `SELECT es.*, cs.display_name AS created_by_name, fs.display_name AS confirmed_by_name FROM event_stations es
           LEFT JOIN staff cs ON cs.id = es.created_by_staff_id LEFT JOIN staff fs ON fs.id = es.confirmed_by_staff_id
           WHERE es.group_id = ? ORDER BY es.position ASC, es.created_at ASC`
        ).bind(id).all();
        return json({ stations: rows.results.map((r) => rowToStation(noirStationRow(r))) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/stations")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/stations".length));
        const creatorDept = await groupCreatorDept(env, id);
        if (creatorDept === null) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (creatorDept !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can add stations" }, 403);
        }
        const body = await readJsonBody(request);
        const title = String(body.title || "").trim();
        if (!title) return json({ error: "Station title is required" }, 400);
        if (title.length > 80) return json({ error: "Station title is too long" }, 400);
        const category = body.category ? String(body.category).trim().slice(0, 60) : null;
        const description = body.description ? String(body.description).trim().slice(0, 200) : null;
        const icon = body.icon ? String(body.icon).trim().slice(0, 30) : null;
        const posRow = await env.NOIR_DB.prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_stations WHERE group_id = ?").bind(id).first();
        const stationId = crypto.randomUUID();
        await env.NOIR_DB.prepare(
          "INSERT INTO event_stations (id, group_id, title, category, description, icon, position, created_at, created_by_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(stationId, id, title, category, description, icon, posRow.maxPos + 1, new Date().toISOString(), requester.id).run();
        const row = await env.NOIR_DB.prepare(
          `SELECT es.*, cs.display_name AS created_by_name, fs.display_name AS confirmed_by_name FROM event_stations es
           LEFT JOIN staff cs ON cs.id = es.created_by_staff_id LEFT JOIN staff fs ON fs.id = es.confirmed_by_staff_id
           WHERE es.id = ?`
        ).bind(stationId).first();
        return json({ station: rowToStation(noirStationRow(row)) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/stations/")) {
        const id = decodeURIComponent(p.slice("/api/stations/".length));
        const station = await env.NOIR_DB.prepare("SELECT * FROM event_stations WHERE id = ?").bind(id).first();
        if (!station) return json({ error: "Station not found" }, 404);
        const creatorDept = await groupCreatorDept(env, station.group_id);
        const requester = request._staff;
        const canManage = creatorDept !== null && (creatorDept === requester.department_id || requester.is_admin);
        const body = await readJsonBody(request);

        if (typeof body.assignedDeptId !== "undefined") {
          if (!canManage) return json({ error: "Only the department that created this event can assign stations" }, 403);
          if (body.assignedDeptId !== null && !DEPT_IDS.has(body.assignedDeptId)) return json({ error: "Unknown department" }, 400);
          await env.NOIR_DB.prepare("UPDATE event_stations SET assigned_department_id = ?, confirmed_at = NULL WHERE id = ?")
            .bind(body.assignedDeptId ? toNoirDept(body.assignedDeptId) : null, id).run();
        }
        if (body.confirm === true) {
          if (fromNoirDept(station.assigned_department_id) !== requester.department_id && !requester.is_admin) {
            return json({ error: "Only the assigned department can confirm this station" }, 403);
          }
          await env.NOIR_DB.prepare("UPDATE event_stations SET confirmed_at = ?, confirmed_by_staff_id = ? WHERE id = ?")
            .bind(new Date().toISOString(), requester.id, id).run();
        }
        if (typeof body.title === "string" || typeof body.category === "string" || typeof body.description === "string") {
          if (!canManage) return json({ error: "Only the department that created this event can edit stations" }, 403);
          if (typeof body.title === "string") {
            const title = body.title.trim();
            if (!title) return json({ error: "Station title is required" }, 400);
            await env.NOIR_DB.prepare("UPDATE event_stations SET title = ? WHERE id = ?").bind(title.slice(0, 80), id).run();
          }
          if (typeof body.category === "string") {
            await env.NOIR_DB.prepare("UPDATE event_stations SET category = ? WHERE id = ?").bind(body.category.trim().slice(0, 60) || null, id).run();
          }
          if (typeof body.description === "string") {
            await env.NOIR_DB.prepare("UPDATE event_stations SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 200) || null, id).run();
          }
        }
        const row = await env.NOIR_DB.prepare(
          `SELECT es.*, cs.display_name AS created_by_name, fs.display_name AS confirmed_by_name FROM event_stations es
           LEFT JOIN staff cs ON cs.id = es.created_by_staff_id LEFT JOIN staff fs ON fs.id = es.confirmed_by_staff_id
           WHERE es.id = ?`
        ).bind(id).first();
        return json({ station: rowToStation(noirStationRow(row)) });
      }

      if (method === "DELETE" && p.startsWith("/api/stations/")) {
        const id = decodeURIComponent(p.slice("/api/stations/".length));
        const station = await env.NOIR_DB.prepare("SELECT group_id FROM event_stations WHERE id = ?").bind(id).first();
        if (!station) return json({ error: "Station not found" }, 404);
        const creatorDept = await groupCreatorDept(env, station.group_id);
        const requester = request._staff;
        if (creatorDept === null || (creatorDept !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can remove stations" }, 403);
        }
        await env.NOIR_DB.prepare("DELETE FROM event_stations WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---- Event run sheet ----
      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/runsheet")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/runsheet".length));
        const rows = await env.NOIR_DB.prepare(
          `SELECT eri.*, s.display_name AS created_by_name FROM event_runsheet_items eri
           LEFT JOIN staff s ON s.id = eri.created_by_staff_id
           WHERE eri.group_id = ? ORDER BY eri.position ASC, eri.created_at ASC`
        ).bind(id).all();
        return json({ items: rows.results.map(rowToRunsheetItem) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/runsheet")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/runsheet".length));
        const creatorDept = await groupCreatorDept(env, id);
        if (creatorDept === null) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (creatorDept !== requester.department_id && !requester.is_admin) {
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
        const posRow = await env.NOIR_DB.prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM event_runsheet_items WHERE group_id = ?").bind(id).first();
        const itemId = crypto.randomUUID();
        await env.NOIR_DB.prepare(
          "INSERT INTO event_runsheet_items (id, group_id, time_label, title, description, team_label, position, created_at, created_by_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(itemId, id, timeLabel, title, description, teamLabel, posRow.maxPos + 1, new Date().toISOString(), requester.id).run();
        const row = await env.NOIR_DB.prepare(
          `SELECT eri.*, s.display_name AS created_by_name FROM event_runsheet_items eri
           LEFT JOIN staff s ON s.id = eri.created_by_staff_id WHERE eri.id = ?`
        ).bind(itemId).first();
        return json({ item: rowToRunsheetItem(row) }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/runsheet/")) {
        const id = decodeURIComponent(p.slice("/api/runsheet/".length));
        const item = await env.NOIR_DB.prepare("SELECT * FROM event_runsheet_items WHERE id = ?").bind(id).first();
        if (!item) return json({ error: "Run sheet item not found" }, 404);
        const creatorDept = await groupCreatorDept(env, item.group_id);
        const requester = request._staff;
        if (creatorDept === null || (creatorDept !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can edit the run sheet" }, 403);
        }
        const body = await readJsonBody(request);
        if (typeof body.timeLabel === "string" && body.timeLabel.trim()) {
          await env.NOIR_DB.prepare("UPDATE event_runsheet_items SET time_label = ? WHERE id = ?").bind(body.timeLabel.trim().slice(0, 20), id).run();
        }
        if (typeof body.title === "string" && body.title.trim()) {
          await env.NOIR_DB.prepare("UPDATE event_runsheet_items SET title = ? WHERE id = ?").bind(body.title.trim().slice(0, 100), id).run();
        }
        if (typeof body.description === "string") {
          await env.NOIR_DB.prepare("UPDATE event_runsheet_items SET description = ? WHERE id = ?").bind(body.description.trim().slice(0, 300) || null, id).run();
        }
        if (typeof body.teamLabel === "string") {
          await env.NOIR_DB.prepare("UPDATE event_runsheet_items SET team_label = ? WHERE id = ?").bind(body.teamLabel.trim().slice(0, 60) || null, id).run();
        }
        const row = await env.NOIR_DB.prepare(
          `SELECT eri.*, s.display_name AS created_by_name FROM event_runsheet_items eri
           LEFT JOIN staff s ON s.id = eri.created_by_staff_id WHERE eri.id = ?`
        ).bind(id).first();
        return json({ item: rowToRunsheetItem(row) });
      }

      if (method === "DELETE" && p.startsWith("/api/runsheet/")) {
        const id = decodeURIComponent(p.slice("/api/runsheet/".length));
        const item = await env.NOIR_DB.prepare("SELECT group_id FROM event_runsheet_items WHERE id = ?").bind(id).first();
        if (!item) return json({ error: "Run sheet item not found" }, 404);
        const creatorDept = await groupCreatorDept(env, item.group_id);
        const requester = request._staff;
        if (creatorDept === null || (creatorDept !== requester.department_id && !requester.is_admin)) {
          return json({ error: "Only the department that created this event can edit the run sheet" }, 403);
        }
        await env.NOIR_DB.prepare("DELETE FROM event_runsheet_items WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/join")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/join".length));
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const group = await env.NOIR_DB.prepare("SELECT id FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Group not found" }, 404);
        const existingMember = await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, toNoirDept(self)).first();
        await env.NOIR_DB.prepare("INSERT OR IGNORE INTO group_members (group_id, department_id, joined_at) VALUES (?, ?, ?)").bind(id, toNoirDept(self), new Date().toISOString()).run();
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
        await env.NOIR_DB.prepare("DELETE FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, toNoirDept(self)).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/groups/")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length));
        const creatorDept = await groupCreatorDept(env, id);
        if (creatorDept === null) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (creatorDept !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can delete it" }, 403);
        }
        const msgCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?").bind(id).first();
        if (msgCount.n > 0) {
          return json({ error: "This event already has messages in it and can't be deleted. End it instead." }, 400);
        }
        await env.NOIR_DB.prepare("UPDATE groups SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/archive")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/archive".length));
        const group = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
        ).bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        if (group.archived_at) return json({ error: "This event has already ended" }, 400);
        const requester = request._staff;
        if (fromNoirDept(group.creator_dept) !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that created this event can end it" }, 403);
        }
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare("UPDATE groups SET archived_at = ? WHERE id = ?").bind(now, id).run();
        const actorName = DEPT_NAMES[requester.department_id] || requester.department_id;
        await insertMessage(env, ctx, {
          from: requester.department_id, groupId: id, type: "text",
          body: actorName + " ended this event. It's kept here for training.",
          silent: true,
        });
        const row = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
        ).bind(id).first();
        const meta = (await groupMetaMap(env, [id]))[id];
        return json({ group: rowToGroup(mergeGroupRow(row, meta)) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/share")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/share".length));
        const group = await env.NOIR_DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first();
        if (!group) return json({ error: "Event not found" }, 404);
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        if (!group.archived_at) return json({ error: "End the event before sharing it" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO group_meta (group_id, shared_at) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET shared_at = excluded.shared_at`
        ).bind(id, now).run();
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
        const row2 = await env.NOIR_DB.prepare(
          `SELECT g.*, s.department_id AS creator_dept FROM groups g LEFT JOIN staff s ON s.id = g.created_by_staff_id WHERE g.id = ?`
        ).bind(id).first();
        const meta2 = (await groupMetaMap(env, [id]))[id];
        return json({ group: rowToGroup(mergeGroupRow(row2, meta2)) });
      }

      if (method === "GET" && p.startsWith("/api/groups/") && p.endsWith("/messages")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/messages".length));
        const self = url.searchParams.get("self");
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        if (!canViewAsSelf(request._staff, self)) return json({ error: "You can only view your own department's conversations" }, 403);
        const group = await env.NOIR_DB.prepare("SELECT archived_at FROM groups WHERE id = ?").bind(id).first();
        const meta = (await groupMetaMap(env, [id]))[id];
        if (!request._staff.is_admin) {
          if (group && group.archived_at) {
            if (!(meta && meta.shared_at)) return json({ error: "This event has ended and is only visible to the General Manager" }, 403);
          } else {
            const member = await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(id, toNoirDept(self)).first();
            if (!member) return json({ error: "Not a member of this group" }, 403);
          }
        }
        const rows = await env.DB.prepare("SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC").bind(id).all();
        const messages = rows.results.map((r) => rowToMessage(r, self, request._staff.is_admin)).filter(Boolean);
        const rMap = await reactionsMap(env, messages.map((m) => m.id));
        return json({ messages: attachReactions(messages, rMap) });
      }

      if (method === "POST" && p.startsWith("/api/groups/") && p.endsWith("/read")) {
        const id = decodeURIComponent(p.slice("/api/groups/".length, -"/read".length));
        const body = await readJsonBody(request);
        const self = body.self;
        if (!DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          "INSERT INTO group_reads (group_id, department_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(group_id, department_id) DO UPDATE SET last_read_at = excluded.last_read_at"
        ).bind(id, toNoirDept(self), now).run();
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
        if (!ALL_DEPT_IDS.has(body.self) || !ALL_DEPT_IDS.has(body.with)) return json({ error: "Unknown department" }, 400);
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

      if (method === "GET" && p === "/api/signoffs") {
        const dept = request._staff.department_id;
        const rows = await env.DB.prepare(
          "SELECT * FROM messages WHERE signoff_status IS NOT NULL AND (from_dept = ? OR to_dept = ?) AND deleted_at IS NULL ORDER BY created_at DESC"
        ).bind(dept, dept).all();
        const items = rows.results.map((m) => rowToMessage(m, dept, request._staff.is_admin)).filter(Boolean);
        return json({ items });
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
          const ticketRows = await env.NOIR_DB.prepare(
            `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
             LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.status != 'fixed' ORDER BY mt.created_at ASC`
          ).all();
          const ticketMeta = await ticketMetaMap(env, ticketRows.results.map((t) => t.id));
          for (const t of ticketRows.results) {
            items.push({ kind: "ticket", id: t.id, createdAt: t.created_at, ticket: rowToTicket(mergeTicketRow(t, ticketMeta[t.id])) });
          }
        }

        if (dept === "foh") {
          const reqRows = await env.DB.prepare(
            "SELECT * FROM guest_requests WHERE status = 'new' ORDER BY created_at ASC"
          ).all();
          for (const r of reqRows.results) {
            items.push({ kind: "guestRequest", id: r.id, createdAt: r.created_at, request: rowToGuestRequest(r) });
          }
        }

        const plannerRows = await env.DB.prepare(
          "SELECT * FROM planner_alerts_sent WHERE department_id = ? AND read_at IS NULL ORDER BY sent_at ASC"
        ).bind(dept).all();
        for (const p of plannerRows.results) {
          items.push({
            kind: "planner", id: p.entry_id, createdAt: p.sent_at,
            planner: { id: p.entry_id, title: p.title, startsAt: p.starts_at || undefined, details: p.details || undefined },
          });
        }

        items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return json({ items });
      }

      if (method === "POST" && p.startsWith("/api/planner-notifications/") && p.endsWith("/read")) {
        const id = decodeURIComponent(p.slice("/api/planner-notifications/".length, -"/read".length));
        const requester = request._staff;
        const existing = await env.DB.prepare("SELECT department_id FROM planner_alerts_sent WHERE entry_id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        if (existing.department_id !== requester.department_id && !requester.is_admin) {
          return json({ error: "Not part of this department" }, 403);
        }
        await env.DB.prepare("UPDATE planner_alerts_sent SET read_at = ? WHERE entry_id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      // ---- Hold-for-help safety alerts ----
      // Deliberately its own thing, not a message: no typing, no department
      // picker, always goes straight to the predefined responder (GM).
      if (method === "POST" && p === "/api/help-alerts") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const deviceCoords = (typeof body.lat === "number" && typeof body.lng === "number")
          ? { lat: body.lat, lng: body.lng, accuracy: typeof body.accuracy === "number" ? body.accuracy : null }
          : null;
        const location = await resolveLocation(env, requester, deviceCoords);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO help_alerts (id, department_id, raised_by_name, raised_by_staff_id, created_at,
             location_available, location_source, floor_name, zone_name, subzone_name, location_accuracy_m)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, requester.department_id, requester.name || null, requester.id, now,
          location.available ? 1 : 0, location.source || null, location.floorName || null,
          location.zoneName || null, location.subzoneName || null,
          location.accuracyMeters != null ? location.accuracyMeters : null
        ).run();
        const locationLabel = formatLocationLabel(location);
        const responderDepts = HELP_ALERT_RESPONDER_DEPTS.filter((d) => d !== requester.department_id);
        for (const deptId of responderDepts) {
          const notifyPromise = notifyDepartment(env, deptId, {
            title: "🆘 Help needed",
            body: (DEPT_NAMES[requester.department_id] || requester.department_id) + " needs help now - " + locationLabel,
            url: "/", tag: "hotel-ping-help-" + id,
          }, null).catch((e) => console.error("notifyDepartment (help alert) error:", e && e.stack || e));
          if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
        }
        const timeLabel = new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        const dashboardPromise = notifyDashboard(env, ctx, {
          messageId: "help-alert-" + id,
          departmentId: requester.department_id,
          staffName: requester.name,
          message: "🆘 Hold-for-help alert raised by " + (DEPT_NAMES[requester.department_id] || requester.department_id) + " at " + timeLabel + " - " + locationLabel,
          urgency: "emergency",
        }).catch((e) => console.error("notifyDashboard (help alert) error:", e && e.stack || e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(dashboardPromise); else await dashboardPromise;
        return json({ alert: {
          id, departmentId: requester.department_id, raisedByName: requester.name || null, createdAt: now,
          respondedByName: null, respondedAt: null, location,
        } }, 201);
      }

      if (method === "GET" && p === "/api/help-alerts") {
        const requester = request._staff;
        const cutoff = new Date(Date.now() - HELP_ALERT_WINDOW_MINUTES * 60000).toISOString();
        const rows = await env.DB.prepare(
          "SELECT * FROM help_alerts WHERE created_at > ? ORDER BY created_at DESC"
        ).bind(cutoff).all();
        const isResponder = HELP_ALERT_RESPONDER_DEPTS.includes(requester.department_id) || requester.is_admin;
        const alerts = rows.results
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
        return json({ alerts });
      }

      if (method === "POST" && p.startsWith("/api/help-alerts/") && p.endsWith("/respond")) {
        const id = decodeURIComponent(p.slice("/api/help-alerts/".length, -"/respond".length));
        const requester = request._staff;
        if (!HELP_ALERT_RESPONDER_DEPTS.includes(requester.department_id) && !requester.is_admin) {
          return json({ error: "Only a designated responder can respond to this" }, 403);
        }
        const existing = await env.DB.prepare("SELECT * FROM help_alerts WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        if (!existing.responded_at) {
          await env.DB.prepare("UPDATE help_alerts SET responded_by_name = ?, responded_at = ? WHERE id = ?")
            .bind(requester.name || "GM", new Date().toISOString(), id).run();
        }
        const row = await env.DB.prepare("SELECT * FROM help_alerts WHERE id = ?").bind(id).first();
        return json({ alert: {
          id: row.id, departmentId: row.department_id, createdAt: row.created_at,
          respondedByName: row.responded_by_name || null, respondedAt: row.responded_at || null,
        } });
      }

      // Sender taps their real location from the predefined zone list once
      // the alert's already out - a device fix can be missing or wrong
      // indoors, so a direct human tap is treated as the most trustworthy
      // source there is (tagged "manual", never blended with a guess).
      if (method === "PATCH" && p.startsWith("/api/help-alerts/") && p.endsWith("/location")) {
        const id = decodeURIComponent(p.slice("/api/help-alerts/".length, -"/location".length));
        const requester = request._staff;
        const existing = await env.DB.prepare("SELECT * FROM help_alerts WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Not found" }, 404);
        if (existing.raised_by_staff_id !== requester.id && !requester.is_admin) {
          return json({ error: "Only the person who raised this alert can update its location" }, 403);
        }
        const body = await readJsonBody(request);
        if (!body.zoneId) return json({ error: "zoneId is required" }, 400);
        const zone = await env.DB.prepare("SELECT * FROM zones WHERE id = ?").bind(body.zoneId).first();
        if (!zone) return json({ error: "Unknown zone" }, 404);
        const floor = await env.DB.prepare("SELECT name FROM floors WHERE id = ?").bind(zone.floor_id).first();
        let zoneName = zone.name, subzoneName = null;
        if (zone.parent_zone_id) {
          const parent = await env.DB.prepare("SELECT name FROM zones WHERE id = ?").bind(zone.parent_zone_id).first();
          if (parent) { zoneName = parent.name; subzoneName = zone.name; }
        }
        await env.DB.prepare(
          `UPDATE help_alerts SET location_available = 1, location_source = 'manual',
             floor_name = ?, zone_name = ?, subzone_name = ?, location_accuracy_m = NULL WHERE id = ?`
        ).bind(floor ? floor.name : null, zoneName, subzoneName, id).run();
        return json({ location: { available: true, source: "manual", floorName: floor ? floor.name : null, zoneName, subzoneName } });
      }

      // ---- Blockers (cross-department "waiting on") ----
      // Lives in the dashboard's blockers table now. department_id/waiting_on
      // are UUIDs there, so translate at the boundary; created_by_staff_id is
      // a real staff FK (the old local table stored a department id in that
      // column instead, but nothing on the client reads it back).
      if (method === "GET" && p === "/api/blockers") {
        const rows = await env.NOIR_DB.prepare(
          "SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC"
        ).all();
        return json({ blockers: rows.results.map((r) => rowToBlocker(noirBlockerRow(r))) });
      }

      if (method === "POST" && p === "/api/blockers") {
        const body = await readJsonBody(request);
        const waitingOn = String(body.waitingOn || "").trim();
        if (!waitingOn) return json({ error: "Say what you're waiting on" }, 400);
        const reason = body.reason ? String(body.reason).trim().slice(0, 200) : null;
        const requester = request._staff;
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          "INSERT INTO blockers (id, department_id, waiting_on, reason, created_by_staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, toNoirDept(requester.department_id), toNoirDept(waitingOn), reason, requester.id, now).run();
        const row = await env.NOIR_DB.prepare("SELECT * FROM blockers WHERE id = ?").bind(id).first();
        return json({ blocker: rowToBlocker(noirBlockerRow(row)) });
      }

      if (method === "POST" && p.startsWith("/api/blockers/") && p.endsWith("/resolve")) {
        const id = decodeURIComponent(p.slice("/api/blockers/".length, -"/resolve".length));
        const existing = await env.NOIR_DB.prepare("SELECT * FROM blockers WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Blocker not found" }, 404);
        const requester = request._staff;
        if (fromNoirDept(existing.department_id) !== requester.department_id && !requester.is_admin) {
          return json({ error: "Only the department that reported this can clear it" }, 403);
        }
        await env.NOIR_DB.prepare("UPDATE blockers SET resolved_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      // ---- Ops overview (admin): escalations, blocker chains, ownership, exceptions ----
      if (method === "GET" && p === "/api/ops-overview") {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);

        const escalatedMsgRows = await env.DB.prepare(
          "SELECT * FROM messages WHERE escalation_level > 0 AND status != 'read' AND deleted_at IS NULL ORDER BY escalation_level DESC, created_at ASC"
        ).all();

        const reportedTicketRows = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.status = 'reported' ORDER BY mt.created_at ASC`
        ).all();
        const reportedTicketMeta = await ticketMetaMap(env, reportedTicketRows.results.map((t) => t.id));
        const reportedTickets = reportedTicketRows.results.map((t) => mergeTicketRow(t, reportedTicketMeta[t.id]));
        const escalatedTickets = reportedTickets
          .filter((t) => t.escalation_level > 0)
          .sort((a, b) => b.escalation_level - a.escalation_level || (a.created_at < b.created_at ? -1 : 1));

        const unownedTicketRows = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.status != 'fixed' AND mt.owner_staff_id IS NULL ORDER BY mt.created_at ASC`
        ).all();
        const unownedTicketMeta = await ticketMetaMap(env, unownedTicketRows.results.map((t) => t.id));

        const blockerRows = await env.NOIR_DB.prepare(
          "SELECT * FROM blockers WHERE resolved_at IS NULL ORDER BY created_at ASC"
        ).all();
        const blockers = blockerRows.results.map((r) => rowToBlocker(noirBlockerRow(r)));
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

        const openTicketCount = await env.NOIR_DB.prepare("SELECT COUNT(*) AS n FROM maintenance_tickets WHERE status != 'fixed'").first();
        const openGuestCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE status != 'completed'").first();
        const roomTotalCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms").first();
        const roomCleanCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE status = 'clean'").first();

        return json({
          escalatedMessages: escalatedMsgRows.results.map((r) => rowToMessage(r, r.to_dept, true)),
          escalatedTickets: escalatedTickets.map(rowToTicket),
          unownedTickets: unownedTicketRows.results.map((t) => rowToTicket(mergeTicketRow(t, unownedTicketMeta[t.id]))),
          blockerChains: chains,
          allBlockers: blockers,
          exceptions: {
            openTickets: openTicketCount.n,
            openGuestRequests: openGuestCount.n,
          },
          rooms: { clean: roomCleanCount.n, total: roomTotalCount.n },
        });
      }

      if (method === "POST" && p === "/api/messages") {
        const body = await readJsonBody(request);
        const { from, to, groupId, type, text, urgent, affectsGuest, fileName, fileBase64, fileMime, duration, transcript, replyToId, roomNumber, taskStatus, mentions, signoff, poll, clientMessageId } = body;
        if (!ALL_DEPT_IDS.has(from)) return json({ error: "Unknown department" }, 400);
        const sendingAsOwnHead = HEAD_DEPT_IDS.has(from) && request._staff.head_depts && request._staff.head_depts.includes(from);
        if (from !== request._staff.department_id && !sendingAsOwnHead) {
          return json({ error: "You can only send messages as your own department" }, 403);
        }
        let validMembers = null;
        if (groupId) {
          const group = await env.NOIR_DB.prepare("SELECT archived_at FROM groups WHERE id = ?").bind(groupId).first();
          if (group && group.archived_at) return json({ error: "This event has ended and is now read only" }, 400);
          const memberRows = await env.NOIR_DB.prepare("SELECT department_id FROM group_members WHERE group_id = ?").bind(groupId).all();
          validMembers = new Set(memberRows.results.map((m) => fromNoirDept(m.department_id)));
          if (!validMembers.has(from)) return json({ error: "Not a member of this group" }, 403);
        } else if (!ALL_DEPT_IDS.has(to) && to !== "dashboard") {
          return json({ error: "Unknown department" }, 400);
        } else if (to === "dashboard" && from !== "gm") {
          return json({ error: "Only the GM can message Head Office directly" }, 403);
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
          if (base64ExceedsBytes(fileBase64, 25 * 1024 * 1024)) return json({ error: "File is too large (25MB max)" }, 400);
          const binary = atob(fileBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const ext = fileMime && fileMime.split("/")[1] ? "." + fileMime.split("/")[1].split(";")[0] : "";
          const safeName = hotelKeyPrefix + crypto.randomUUID() + ext;
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
          fromStaffName: request._staff.name || null,
          clientMessageId: clientMessageId && String(clientMessageId).trim() ? String(clientMessageId).trim().slice(0, 100) : null,
        });

        if (to === "dashboard" && row.body) {
          // If this is a reply (swiped-to-reply) to a message that itself
          // came from a dashboard direct conversation, thread it back to
          // that same conversation rather than the department's general
          // inbox - see dashboard_conversation_id on /api/external/notify.
          let replyToConversationId = null;
          if (replyToId) {
            const repliedTo = await env.DB.prepare("SELECT dashboard_conversation_id FROM messages WHERE id = ?").bind(replyToId).first();
            replyToConversationId = repliedTo ? repliedTo.dashboard_conversation_id : null;
          }
          // No staffName here - the dashboard should only ever see the
          // department (GM), never the individual person behind it.
          await notifyDashboard(env, ctx, {
            messageId: row.id, departmentId: from, message: row.body,
            urgency: urgent ? "urgent" : "normal", replyToConversationId,
          });
        }

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
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextPinned = !existing.pinned_at;
        await env.DB.prepare("UPDATE messages SET pinned_at = ? WHERE id = ?").bind(nextPinned ? new Date().toISOString() : null, id).run();
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        return json({ message: rowToMessage(row, requester.department_id, requester.is_admin) });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/reactions")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/reactions".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const body = await readJsonBody(request);
        const emoji = String(body.emoji || "").trim().slice(0, 8);
        if (!emoji) return json({ error: "An emoji is required" }, 400);
        const current = await env.DB.prepare(
          "SELECT emoji FROM message_reactions WHERE message_id = ? AND department_id = ?"
        ).bind(id, requester.department_id).first();
        // Tapping the same reaction again removes it - a real toggle, not a
        // one-way stamp, same as tapping a like a second time anywhere else.
        if (current && current.emoji === emoji) {
          await env.DB.prepare("DELETE FROM message_reactions WHERE message_id = ? AND department_id = ?").bind(id, requester.department_id).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO message_reactions (id, message_id, department_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(message_id, department_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`
          ).bind(crypto.randomUUID(), id, requester.department_id, emoji, new Date().toISOString()).run();
        }
        const rMap = await reactionsMap(env, [id]);
        return json({ reactions: rMap[id] || [] });
      }

      if (method === "POST" && p.startsWith("/api/messages/") && p.endsWith("/affects-guest")) {
        const id = decodeURIComponent(p.slice("/api/messages/".length, -"/affects-guest".length));
        const existing = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Message not found" }, 404);
        const requester = request._staff;
        const inConversation = existing.from_dept === requester.department_id || existing.to_dept === requester.department_id
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
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
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const nextCompleted = !existing.completed_at;
        await env.DB.prepare("UPDATE messages SET completed_at = ?, completed_by = ? WHERE id = ?")
          .bind(nextCompleted ? new Date().toISOString() : null, nextCompleted ? requester.department_id : null, id).run();
        // A "room clean" card accepted by its recipient (Reception) is worth a
        // reply so housekeeping has confirmation, not just a silent status flip.
        if (nextCompleted && existing.room_clean && requester.department_id === existing.to_dept) {
          await insertMessage(env, ctx, {
            from: requester.department_id, to: existing.from_dept, type: "text",
            body: "✅ Room " + existing.room_clean + " confirmed received.",
          });
        }
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
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
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
          || (existing.group_id && await env.NOIR_DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND department_id = ?").bind(existing.group_id, toNoirDept(requester.department_id)).first());
        if (!inConversation && !requester.is_admin) return json({ error: "Not part of this conversation" }, 403);
        const body = await readJsonBody(request);
        const to = body.to;
        if (!ALL_DEPT_IDS.has(to)) return json({ error: "Unknown department" }, 400);
        const row = await insertMessage(env, ctx, {
          from: requester.department_id, to, type: existing.type,
          body: existing.body, fileName: existing.file_name, filePath: existing.file_path, fileSize: existing.file_size,
          duration: existing.duration, transcript: existing.transcript, urgent: false,
          fromStaffName: requester.name || null,
        });
        return json({ message: rowToMessage(row, requester.department_id, false) }, 201);
      }

      // ---- Personal notes: private per-staff voice/text notes, never
      // shared with anyone else - e.g. recording through a meeting so
      // nothing gets forgotten by the time it ends. Scoped by staff_id
      // from the session, same as every other requester-scoped endpoint.
      if (method === "GET" && p === "/api/notes") {
        const requester = request._staff;
        const rows = await env.DB.prepare(
          "SELECT * FROM personal_notes WHERE staff_id = ? AND deleted_at IS NULL ORDER BY created_at DESC"
        ).bind(requester.id).all();
        return json({ notes: rows.results.map(rowToNote) });
      }

      if (method === "POST" && p === "/api/notes") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        const title = body.title ? String(body.title).trim().slice(0, 120) : null;
        const text = body.body ? String(body.body).trim() : null;
        const duration = body.duration || null;
        const transcript = body.transcript ? String(body.transcript).trim() : null;
        let filePathOnDisk = null;
        let fileSize = null;
        if (body.fileBase64) {
          if (base64ExceedsBytes(body.fileBase64, 25 * 1024 * 1024)) return json({ error: "File is too large (25MB max)" }, 400);
          const binary = atob(body.fileBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
          const safeName = hotelKeyPrefix + "note-" + crypto.randomUUID() + ext;
          await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
          filePathOnDisk = safeName;
          fileSize = bytes.length;
        }
        if (!text && !filePathOnDisk) return json({ error: "A note needs either text or a recording" }, 400);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO personal_notes (id, staff_id, staff_name, title, body, file_path, file_size, duration, transcript, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, requester.id, requester.name || null, title, text, filePathOnDisk, fileSize, duration, transcript, now).run();
        const row = await env.DB.prepare("SELECT * FROM personal_notes WHERE id = ?").bind(id).first();
        return json({ note: rowToNote(row) }, 201);
      }

      if (method === "DELETE" && p.startsWith("/api/notes/")) {
        const requester = request._staff;
        const id = decodeURIComponent(p.slice("/api/notes/".length));
        const existing = await env.DB.prepare("SELECT * FROM personal_notes WHERE id = ?").bind(id).first();
        if (!existing || existing.deleted_at) return json({ error: "Note not found" }, 404);
        if (existing.staff_id !== requester.id) return json({ error: "Not your note" }, 403);
        await env.DB.prepare("UPDATE personal_notes SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
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
          const row = await insertMessage(env, ctx, { from, to, type: "text", body: text, urgent: !!body.urgent, broadcastId, fromStaffName: requester.name || null });
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

      if (method === "POST" && p === "/api/priority-broadcast") {
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "Alert text is required" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE priority_broadcasts SET cleared_at = ? WHERE cleared_at IS NULL").bind(now).run();
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO priority_broadcasts (id, text, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, text, requester.id, now).run();
        return json({ broadcast: { id, text, createdAt: now } }, 201);
      }

      if (method === "GET" && p === "/api/priority-broadcast/active") {
        const row = await env.DB.prepare("SELECT * FROM priority_broadcasts WHERE cleared_at IS NULL ORDER BY created_at DESC LIMIT 1").first();
        if (!row) return json({ broadcast: null, acceptedDepts: [] });
        const acks = await env.DB.prepare("SELECT department_id FROM priority_broadcast_acks WHERE broadcast_id = ?").bind(row.id).all();
        return json({
          broadcast: { id: row.id, text: row.text, createdAt: row.created_at },
          acceptedDepts: acks.results.map((a) => a.department_id),
        });
      }

      if (method === "POST" && p.startsWith("/api/priority-broadcast/") && p.endsWith("/accept")) {
        const id = decodeURIComponent(p.slice("/api/priority-broadcast/".length, -"/accept".length));
        const requester = request._staff;
        const broadcast = await env.DB.prepare("SELECT * FROM priority_broadcasts WHERE id = ? AND cleared_at IS NULL").bind(id).first();
        if (!broadcast) return json({ error: "That alert is no longer active" }, 404);
        const dept = requester.department_id;
        const already = await env.DB.prepare("SELECT 1 FROM priority_broadcast_acks WHERE broadcast_id = ? AND department_id = ?").bind(id, dept).first();
        if (!already) {
          await env.DB.prepare("INSERT INTO priority_broadcast_acks (broadcast_id, department_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?)")
            .bind(id, dept, requester.id, new Date().toISOString()).run();
          if (dept !== "gm") {
            await insertMessage(env, ctx, { from: dept, to: "gm", type: "text", body: "✅ " + (DEPT_NAMES[dept] || dept) + " accepted: " + broadcast.text });
          }
        }
        return json({ ok: true });
      }

      if (method === "POST" && p.startsWith("/api/priority-broadcast/") && p.endsWith("/clear")) {
        const id = decodeURIComponent(p.slice("/api/priority-broadcast/".length, -"/clear".length));
        const requester = request._staff;
        if (!requester.is_admin) return json({ error: "Admin access required" }, 403);
        await env.DB.prepare("UPDATE priority_broadcasts SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL").bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/typing") {
        const body = await readJsonBody(request);
        const self = request._staff.department_id;
        if (!ALL_DEPT_IDS.has(body.to)) return json({ error: "Unknown department" }, 400);
        await env.DB.prepare(
          "INSERT INTO typing_status (from_dept, to_dept, updated_at) VALUES (?, ?, ?) ON CONFLICT(from_dept, to_dept) DO UPDATE SET updated_at = excluded.updated_at"
        ).bind(self, body.to, new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/typing") {
        const self = url.searchParams.get("self");
        if (!ALL_DEPT_IDS.has(self)) return json({ error: "Unknown department" }, 400);
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

      // ---- GM's own "don't notify me for plain departments" switch ----
      // A personal GM setting, not a department one - only the GM (is_admin,
      // which is GM-only now) can read or flip it. Built on the same
      // muted_conversations table /api/muted already uses, just applied to
      // every plain department (foh, kitchen, housekeeping, ...) at once.
      // Head-of-department contacts (head_kitchen etc.) are never in
      // DEPT_IDS, so they're never touched by this - a head's message to
      // the GM still notifies exactly as normal, on or off. This never
      // blocks the message itself, only the push notification - it still
      // lands in the GM's normal inbox for that department, same as any
      // other conversation, so he can always open it and reply directly.
      const GM_MUTABLE_DEPTS = Array.from(DEPT_IDS).filter((d) => d !== "gm");
      if (method === "GET" && p === "/api/gm/mute-departments") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const rows = await env.DB.prepare("SELECT other_dept_id FROM muted_conversations WHERE department_id = 'gm'").all();
        const mutedSet = new Set(rows.results.map((r) => r.other_dept_id));
        const on = GM_MUTABLE_DEPTS.every((d) => mutedSet.has(d));
        return json({ muteDepartments: on });
      }
      if (method === "POST" && p === "/api/gm/mute-departments") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const body = await readJsonBody(request);
        const on = !!body.on;
        if (on) {
          const now = new Date().toISOString();
          await env.DB.batch(GM_MUTABLE_DEPTS.map((d) =>
            env.DB.prepare("INSERT OR IGNORE INTO muted_conversations (department_id, other_dept_id, muted_at) VALUES ('gm', ?, ?)").bind(d, now)
          ));
        } else {
          await env.DB.batch(GM_MUTABLE_DEPTS.map((d) =>
            env.DB.prepare("DELETE FROM muted_conversations WHERE department_id = 'gm' AND other_dept_id = ?").bind(d)
          ));
        }
        return json({ muteDepartments: on });
      }

      if (method === "GET" && p === "/api/quick-replies") {
        const dept = toNoirDept(request._staff.department_id);
        let rows = await env.NOIR_DB.prepare("SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC").bind(dept).all();
        if (rows.results.length === 0) {
          const now = new Date().toISOString();
          for (let i = 0; i < DEFAULT_QUICK_REPLIES.length; i++) {
            await env.NOIR_DB.prepare(
              "INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(crypto.randomUUID(), dept, DEFAULT_QUICK_REPLIES[i], i, now).run();
          }
          rows = await env.NOIR_DB.prepare("SELECT * FROM quick_replies WHERE department_id = ? ORDER BY position ASC").bind(dept).all();
        }
        return json({ replies: rows.results.map((r) => ({ id: r.id, text: r.text })) });
      }

      if (method === "POST" && p === "/api/quick-replies") {
        const dept = toNoirDept(request._staff.department_id);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim().slice(0, 24);
        if (!text) return json({ error: "Text is required" }, 400);
        const maxPos = await env.NOIR_DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM quick_replies WHERE department_id = ?").bind(dept).first();
        const id = crypto.randomUUID();
        await env.NOIR_DB.prepare(
          "INSERT INTO quick_replies (id, department_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, dept, text, maxPos.m + 1, new Date().toISOString()).run();
        return json({ reply: { id, text } }, 201);
      }

      if (method === "PATCH" && p.startsWith("/api/quick-replies/")) {
        const id = decodeURIComponent(p.slice("/api/quick-replies/".length));
        const dept = toNoirDept(request._staff.department_id);
        const existing = await env.NOIR_DB.prepare("SELECT 1 FROM quick_replies WHERE id = ? AND department_id = ?").bind(id, dept).first();
        if (!existing) return json({ error: "Not found" }, 404);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim().slice(0, 24);
        if (!text) return json({ error: "Text is required" }, 400);
        await env.NOIR_DB.prepare("UPDATE quick_replies SET text = ? WHERE id = ?").bind(text, id).run();
        return json({ reply: { id, text } });
      }

      if (method === "DELETE" && p.startsWith("/api/quick-replies/")) {
        const id = decodeURIComponent(p.slice("/api/quick-replies/".length));
        const dept = toNoirDept(request._staff.department_id);
        await env.NOIR_DB.prepare("DELETE FROM quick_replies WHERE id = ? AND department_id = ?").bind(id, dept).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/stories") {
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare("DELETE FROM stories WHERE expires_at < ?").bind(now).run();
        const rows = await env.NOIR_DB.prepare("SELECT * FROM stories WHERE expires_at >= ? ORDER BY created_at ASC").bind(now).all();
        const viewerDept = request._staff.department_id;
        const viewedRows = await env.NOIR_DB.prepare("SELECT story_id FROM story_views WHERE department_id = ?").bind(toNoirDept(viewerDept)).all();
        const viewedIds = new Set(viewedRows.results.map((r) => r.story_id));
        return json({ stories: rows.results.map((r) => rowToStory(noirDeptRow(r), fromNoirDept(r.department_id) === viewerDept || viewedIds.has(r.id))) });
      }

      if (method === "POST" && p === "/api/stories") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        if (!body.fileBase64) return json({ error: "Photo is required" }, 400);
        if (base64ExceedsBytes(body.fileBase64, 10 * 1024 * 1024)) return json({ error: "Photo is too large (10MB max)" }, 400);
        const binary = atob(body.fileBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = body.fileMime && body.fileMime.split("/")[1] ? "." + body.fileMime.split("/")[1].split(";")[0] : "";
        const safeName = hotelKeyPrefix + "story-" + crypto.randomUUID() + ext;
        await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.fileMime || "application/octet-stream" } });
        const id = crypto.randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        const caption = body.caption ? String(body.caption).trim().slice(0, 200) : null;
        await env.NOIR_DB.prepare(
          "INSERT INTO stories (id, hotel_id, department_id, staff_name, photo_path, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, resolvedNoirHotelId, toNoirDept(requester.department_id), requester.name, safeName, caption, now.toISOString(), expiresAt).run();
        const row = await env.NOIR_DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first();
        return json({ story: rowToStory(noirDeptRow(row), true) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/stories/") && p.endsWith("/view")) {
        const id = decodeURIComponent(p.slice("/api/stories/".length, -"/view".length));
        const story = await env.NOIR_DB.prepare("SELECT 1 FROM stories WHERE id = ?").bind(id).first();
        if (!story) return json({ error: "Story not found" }, 404);
        const viewerDept = request._staff.department_id;
        await env.NOIR_DB.prepare(
          "INSERT INTO story_views (story_id, department_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT(story_id, department_id) DO NOTHING"
        ).bind(id, toNoirDept(viewerDept), new Date().toISOString()).run();
        return json({ ok: true });
      }

      if (method === "DELETE" && p.startsWith("/api/stories/")) {
        const id = decodeURIComponent(p.slice("/api/stories/".length));
        const existing = await env.NOIR_DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Story not found" }, 404);
        const requester = request._staff;
        if (fromNoirDept(existing.department_id) !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only delete your own department's stories" }, 403);
        }
        await env.NOIR_DB.prepare("DELETE FROM stories WHERE id = ?").bind(id).run();
        await env.NOIR_DB.prepare("DELETE FROM story_views WHERE story_id = ?").bind(id).run();
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
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const rows = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id ORDER BY mt.created_at DESC`
        ).all();
        const meta = await ticketMetaMap(env, rows.results.map((r) => r.id));
        return json({ tickets: rows.results.map((r) => rowToTicket(mergeTicketRow(r, meta[r.id]))) });
      }

      if (method === "POST" && p === "/api/maintenance") {
        const requester = request._staff;
        const body = await readJsonBody(request);
        let description = String(body.description || "").trim();
        let roomNumber = body.roomNumber ? String(body.roomNumber).trim() : null;
        if (roomNumber && roomNumber.length > 40) return json({ error: "Location is too long" }, 400);

        let voiceBytes = null;
        if (body.voiceBase64) {
          if (base64ExceedsBytes(body.voiceBase64, 25 * 1024 * 1024)) return json({ error: "Voice note is too large (25MB max)" }, 400);
          const binary = atob(body.voiceBase64);
          voiceBytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) voiceBytes[i] = binary.charCodeAt(i);
        }
        if (!description && voiceBytes) {
          const transcript = await transcribeVoice(env, voiceBytes);
          if (transcript) {
            description = transcript;
            if (!roomNumber) roomNumber = extractRoomNumberFromText(transcript);
          }
        }
        if (!description) description = voiceBytes ? "Reported via push-to-talk" : "";
        if (!description) return json({ error: "A description is required" }, 400);
        const priority = MAINT_PRIORITIES.includes(body.priority) ? body.priority : "problem";
        const guestPresent = !!body.guestPresent;
        let deadline = body.deadline ? String(body.deadline).trim() : null;
        if (deadline && !DEADLINE_RE.test(deadline)) deadline = null;

        if (roomNumber) {
          const dup = await env.NOIR_DB.prepare(
            `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
             LEFT JOIN staff s ON s.id = mt.created_by_staff_id
             WHERE mt.status != 'fixed' AND LOWER(TRIM(mt.room_number)) = LOWER(?) ORDER BY mt.created_at DESC LIMIT 1`
          ).bind(roomNumber).first();
          if (dup) {
            const replyId = crypto.randomUUID();
            const now = new Date().toISOString();
            const noteText = "Also reported by " + (DEPT_NAMES[requester.department_id] || requester.department_id) + ": " + description;
            await env.NOIR_DB.prepare(
              "INSERT INTO maintenance_replies (id, ticket_id, from_department_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(replyId, dup.id, toNoirDept(requester.department_id), noteText, now).run();

            const mergedPriority = MAINT_PRIORITY_RANK[priority] < MAINT_PRIORITY_RANK[dup.priority] ? priority : dup.priority;
            const mergedGuestPresent = guestPresent || !!dup.guest_present;
            const mergedDeadline = deadline && (!dup.deadline || deadline < dup.deadline) ? deadline : dup.deadline;
            if (mergedPriority !== dup.priority || mergedGuestPresent !== !!dup.guest_present || mergedDeadline !== dup.deadline) {
              await env.NOIR_DB.prepare(
                "UPDATE maintenance_tickets SET priority = ?, guest_present = ?, deadline = ?, updated_at = ? WHERE id = ?"
              ).bind(mergedPriority, mergedGuestPresent ? 1 : 0, mergedDeadline, now, dup.id).run();
            }
            const mergedRow = await env.NOIR_DB.prepare(
              `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
               LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
            ).bind(dup.id).first();
            const mergedMeta = (await ticketMetaMap(env, [dup.id]))[dup.id];

            const dupCreatorDept = fromNoirDept(dup.creator_dept);
            if (dupCreatorDept !== requester.department_id) {
              const notifyPromise = notifyDepartment(env, "maintenance", {
                title: "🔧 Same job reported again",
                body: noteText,
                url: "/",
                tag: "hotel-ping-maintenance-" + dup.id,
              }, requester.department_id).catch(function(e){ console.error("notifyDepartment (dup maintenance) error:", e && e.stack || e); });
              if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
            }
            return json({ ticket: rowToTicket(mergeTicketRow(mergedRow, mergedMeta)), merged: true }, 200);
          }
        }

        let photoPath = null;
        let photoSize = null;
        const isVideoAttachment = !!(body.photoMime && body.photoMime.indexOf("video/") === 0);
        if (body.photoBase64) {
          if (base64ExceedsBytes(body.photoBase64, 60 * 1024 * 1024)) return json({ error: "File is too large (60MB max)" }, 400);
          const binary = atob(body.photoBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const ext = body.photoMime && body.photoMime.split("/")[1] ? "." + body.photoMime.split("/")[1].split(";")[0] : "";
          const safeName = hotelKeyPrefix + crypto.randomUUID() + ext;
          await env.UPLOADS.put(safeName, bytes, { httpMetadata: { contentType: body.photoMime || "application/octet-stream" } });
          photoPath = safeName;
          photoSize = bytes.length;
        }

        let voicePath = null;
        let voiceDuration = null;
        if (voiceBytes) {
          const ext = body.voiceMime && body.voiceMime.split("/")[1] ? "." + body.voiceMime.split("/")[1].split(";")[0].split(";")[0] : ".webm";
          const safeName = hotelKeyPrefix + crypto.randomUUID() + ext;
          await env.UPLOADS.put(safeName, voiceBytes, { httpMetadata: { contentType: body.voiceMime || "audio/webm" } });
          voicePath = safeName;
          voiceDuration = Number.isFinite(Number(body.voiceDuration)) ? Math.round(Number(body.voiceDuration)) : null;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          "INSERT INTO maintenance_tickets (id, hotel_id, room_number, description, photo_path, voice_path, voice_duration, status, priority, guest_present, deadline, created_by_staff_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)"
        ).bind(id, resolvedNoirHotelId, roomNumber, description, photoPath, voicePath, voiceDuration, priority, guestPresent ? 1 : 0, deadline, requester.id, now, now).run();
        // The meta row's own rowid is a free, guaranteed-unique, always-
        // incrementing integer - reused as the ticket's human-facing
        // number (#N) rather than adding a separate counter to track.
        const metaInsert = await env.DB.prepare("INSERT INTO maintenance_ticket_meta (ticket_id, escalation_level) VALUES (?, 0)").bind(id).run();
        const ticketNumber = metaInsert.meta.last_row_id;
        await env.DB.prepare(
          "INSERT INTO maintenance_ticket_status_log (id, ticket_id, from_status, to_status, changed_by_staff_id, changed_by_name, changed_by_department_id, created_at) VALUES (?, ?, NULL, 'reported', ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, requester.id, requester.name || null, requester.department_id, now).run();
        const coreRow = {
          id, room_number: roomNumber, description, photo_path: photoPath, voice_path: voicePath, voice_duration: voiceDuration,
          status: "reported", priority,
          guest_present: guestPresent ? 1 : 0, deadline, creator_dept: toNoirDept(requester.department_id),
          created_at: now, updated_at: now, resolved_at: null, owner_staff_id: null,
        };

        let notifyBody = "#" + ticketNumber + " " + (roomNumber ? "Room " + roomNumber + ": " : "") + description;
        if (guestPresent) notifyBody += " · Guest in room";
        if (deadline) notifyBody += " · Needed by " + deadline;
        // Deliver into maintenance's own chat too, same as a dashboard-side
        // ticket does via checkUnnotifiedTickets - a ticket someone raises
        // through this screen must show up as a message, not just a push
        // notification, or maintenance has no record of it in-app at all.
        // Self-reported (maintenance reporting on itself) has no one to
        // message it from, so it's skipped there same as the other path.
        if (requester.department_id !== "maintenance" && DEPT_IDS.has(requester.department_id)) {
          let chatBody = description;
          if (guestPresent) chatBody += " · Guest in room";
          if (deadline) chatBody += " · Needed by " + deadline;
          // Backgrounded via waitUntil like the push notification below -
          // the ticket is already saved at this point, so nothing about
          // reporting it should keep waiting on this extra chat write.
          // A reported photo/video rides along as the ping's own attachment
          // (not just referenced in text) - maintenance sees the actual
          // photo in the thread the same as if it had been sent to them
          // directly, per the "everything is a ping" product promise.
          const chatMessagePromise = insertMessage(env, ctx, {
            from: requester.department_id, to: "maintenance", type: photoPath ? (isVideoAttachment ? "file" : "image") : "text",
            body: "🔧 New ticket #" + ticketNumber + ": " + chatBody,
            fileName: photoPath ? (isVideoAttachment ? "Issue video" : "Issue photo") : undefined,
            filePath: photoPath || undefined, fileSize: photoSize || undefined,
            roomNumber: roomNumber || null, taskStatus: "not_started",
          }).catch((e) => console.error("insertMessage (new maintenance ticket) error:", e && e.stack || e));
          if (ctx && ctx.waitUntil) ctx.waitUntil(chatMessagePromise); else await chatMessagePromise;
          // A voice note rides along as its own ping right behind the main
          // one, same "everything is a ping" rule as the photo/video above -
          // maintenance hears the actual recording in the thread, not just
          // a note that one was attached.
          if (voicePath) {
            const voiceMessagePromise = insertMessage(env, ctx, {
              from: requester.department_id, to: "maintenance", type: "audio",
              filePath: voicePath, duration: voiceDuration || undefined,
              roomNumber: roomNumber || null,
            }).catch((e) => console.error("insertMessage (new maintenance ticket voice) error:", e && e.stack || e));
            if (ctx && ctx.waitUntil) ctx.waitUntil(voiceMessagePromise); else await voiceMessagePromise;
          }
        }
        const notifyPromise = notifyDepartment(env, "maintenance", {
          title: priority === "safety" ? "🚨 Safety issue reported" : "🔧 New maintenance ticket",
          body: notifyBody,
          url: "/",
          tag: "hotel-ping-maintenance-" + id,
        }, requester.department_id).catch(function(e){ console.error("notifyDepartment (maintenance) error:", e && e.stack || e); });
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ ticket: rowToTicket(mergeTicketRow(coreRow, { pinned_at: null, escalation_level: 0, escalated_at: null, rowid: ticketNumber })) }, 201);
      }

      if (method === "GET" && p.startsWith("/api/maintenance/") && p.endsWith("/replies")) {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/replies".length));
        const rows = await env.NOIR_DB.prepare("SELECT * FROM maintenance_replies WHERE ticket_id = ? ORDER BY created_at ASC").bind(id).all();
        return json({ replies: rows.results.map((r) => rowToTicketReply(noirReplyRow(r))) });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/replies")) {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/replies".length));
        const existing = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const body = await readJsonBody(request);
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "Message is required" }, 400);
        const requester = request._staff;
        const replyId = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          "INSERT INTO maintenance_replies (id, ticket_id, from_department_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(replyId, id, toNoirDept(requester.department_id), text, now).run();
        const row = await env.NOIR_DB.prepare("SELECT * FROM maintenance_replies WHERE id = ?").bind(replyId).first();

        const creatorDept = fromNoirDept(existing.creator_dept);
        const notifyTarget = requester.department_id === "maintenance" ? creatorDept : "maintenance";
        if (notifyTarget !== requester.department_id) {
          const notifyPromise = notifyDepartment(env, notifyTarget, {
            title: (DEPT_NAMES[requester.department_id] || requester.department_id) + " · job reply",
            body: text,
            url: "/",
            tag: "hotel-ping-maint-reply-" + id,
          }, requester.department_id).catch(function(e){ console.error("notifyDepartment (maint reply) error:", e && e.stack || e); });
          if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;
        }

        return json({ reply: rowToTicketReply(noirReplyRow(row)) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/status")) {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/status".length));
        const body = await readJsonBody(request);
        const status = body.status;
        if (!MAINT_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
        const existing = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        if (request._staff.department_id !== "maintenance" && !request._staff.is_admin) {
          return json({ error: "Only Maintenance can update a ticket's status" }, 403);
        }
        const now = new Date().toISOString();
        const newOwner = !existing.owner_staff_id && status !== "reported" ? request._staff.id : existing.owner_staff_id;
        await env.NOIR_DB.prepare(
          "UPDATE maintenance_tickets SET status = ?, updated_at = ?, resolved_at = ?, owner_staff_id = ? WHERE id = ?"
        ).bind(status, now, status === "fixed" ? now : null, newOwner, id).run();
        const row = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        const meta = (await ticketMetaMap(env, [id]))[id];

        // A provable, per-transition record of exactly who changed this
        // ticket's status and when - a plain overwrite of mt.status alone
        // can't answer "who marked this fixed" after the fact, which the
        // paid-for accountability promise requires.
        await env.DB.prepare(
          "INSERT INTO maintenance_ticket_status_log (id, ticket_id, from_status, to_status, changed_by_staff_id, changed_by_name, changed_by_department_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), id, existing.status, status, request._staff.id, request._staff.name || null, request._staff.department_id, now).run();

        const creatorDept = fromNoirDept(existing.creator_dept);
        const statusNotice = { in_progress: "Started work on: ", fixed: "Fixed: " };
        if (statusNotice[status] && creatorDept !== "maintenance") {
          const byName = request._staff.name ? request._staff.name + " – " : "";
          await insertMessage(env, ctx, {
            from: "maintenance", to: creatorDept, type: "text",
            body: byName + statusNotice[status] + existing.description + (existing.room_number ? " (" + existing.room_number + ")" : ""),
          });
        }

        return json({ ticket: rowToTicket(mergeTicketRow(row, meta)) });
      }

      if (method === "GET" && p.startsWith("/api/maintenance/") && p.endsWith("/history")) {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/history".length));
        const rows = await env.DB.prepare(
          "SELECT * FROM maintenance_ticket_status_log WHERE ticket_id = ? ORDER BY created_at ASC"
        ).bind(id).all();
        return json({
          history: rows.results.map((r) => ({
            id: r.id,
            fromStatus: r.from_status,
            toStatus: r.to_status,
            byName: r.changed_by_name || undefined,
            byDepartment: r.changed_by_department_id,
            createdAt: r.created_at,
          })),
        });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/owner")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/owner".length));
        const existing = await env.NOIR_DB.prepare("SELECT id FROM maintenance_tickets WHERE id = ?").bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        if (request._staff.department_id !== "maintenance" && !request._staff.is_admin) {
          return json({ error: "Only Maintenance can assign a ticket's owner" }, 403);
        }
        const body = await readJsonBody(request);
        const staffId = body.staffId || null;
        if (staffId) {
          const staffRow = await env.NOIR_DB.prepare("SELECT id FROM staff WHERE id = ? AND department_id = ? AND active = 1")
            .bind(staffId, NOIR_DEPT_ID_MAP.maintenance).first();
          if (!staffRow) return json({ error: "Not a Maintenance staff member" }, 400);
        }
        await env.NOIR_DB.prepare("UPDATE maintenance_tickets SET owner_staff_id = ? WHERE id = ?").bind(staffId, id).run();
        const row = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        const meta = (await ticketMetaMap(env, [id]))[id];
        return json({ ticket: rowToTicket(mergeTicketRow(row, meta)) });
      }

      if (method === "POST" && p === "/api/maintenance/reorder") {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const body = await readJsonBody(request);
        const order = Array.isArray(body.order) ? body.order : [];
        if (!order.length) return json({ error: "order is required" }, 400);
        for (let i = 0; i < order.length; i++) {
          await env.DB.prepare(
            `INSERT INTO maintenance_ticket_meta (ticket_id, sort_order) VALUES (?, ?)
             ON CONFLICT(ticket_id) DO UPDATE SET sort_order = excluded.sort_order`
          ).bind(order[i], i * 10).run();
        }
        const placeholders = order.map(() => "?").join(",");
        const rows = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id IN (${placeholders})`
        ).bind(...order).all();
        const meta = await ticketMetaMap(env, order);
        return json({ tickets: rows.results.map((r) => rowToTicket(mergeTicketRow(r, meta[r.id]))) });
      }

      if (method === "POST" && p.startsWith("/api/maintenance/") && p.endsWith("/pin")) {
        if (!canManageMaintenance(request._staff)) return json({ error: "Not authorized" }, 403);
        const id = decodeURIComponent(p.slice("/api/maintenance/".length, -"/pin".length));
        const existing = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const existingMeta = (await ticketMetaMap(env, [id]))[id];
        const nextPinned = !(existingMeta && existingMeta.pinned_at);
        await env.DB.prepare(
          `INSERT INTO maintenance_ticket_meta (ticket_id, pinned_at) VALUES (?, ?)
           ON CONFLICT(ticket_id) DO UPDATE SET pinned_at = excluded.pinned_at`
        ).bind(id, nextPinned ? new Date().toISOString() : null).run();
        const meta = (await ticketMetaMap(env, [id]))[id];
        return json({ ticket: rowToTicket(mergeTicketRow(existing, meta)) });
      }

      if (method === "DELETE" && p.startsWith("/api/maintenance/")) {
        const id = decodeURIComponent(p.slice("/api/maintenance/".length));
        const existing = await env.NOIR_DB.prepare(
          `SELECT mt.*, s.department_id AS creator_dept FROM maintenance_tickets mt
           LEFT JOIN staff s ON s.id = mt.created_by_staff_id WHERE mt.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Ticket not found" }, 404);
        const requester = request._staff;
        if (!canManageMaintenance(requester)) {
          return json({ error: "Not authorized" }, 403);
        }
        if (existing.status !== "reported" && !requester.is_admin) {
          return json({ error: "This job has already been picked up and can't be deleted" }, 400);
        }
        await env.NOIR_DB.prepare("DELETE FROM maintenance_replies WHERE ticket_id = ?").bind(id).run();
        await env.NOIR_DB.prepare("DELETE FROM maintenance_tickets WHERE id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM maintenance_ticket_meta WHERE ticket_id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "GET" && p === "/api/guest-requests") {
        const requester = request._staff;
        if (requester.department_id !== "foh") {
          return json({ error: "Reception access required" }, 403);
        }
        const rows = await env.DB.prepare("SELECT * FROM guest_requests ORDER BY created_at DESC").all();
        return json({ requests: rows.results.map(rowToGuestRequest) });
      }

      if (method === "POST" && p.startsWith("/api/guest-requests/") && p.endsWith("/status")) {
        const requester = request._staff;
        if (requester.department_id !== "foh") {
          return json({ error: "Reception access required" }, 403);
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
        if (requester.department_id !== "foh") {
          return json({ error: "Reception access required" }, 403);
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

      // Dashboard's asset_requests has no department column, only a staff FK
      // (requested_by_staff_id) - so department-level ownership is resolved
      // by joining staff to look up which department the requester belongs to,
      // matching this table's original "your department's requests" behavior.
      if (method === "GET" && p === "/api/assets") {
        const rows = await env.NOIR_DB.prepare(
          `SELECT ar.*, s.department_id AS requester_dept FROM asset_requests ar
           LEFT JOIN staff s ON s.id = ar.requested_by_staff_id ORDER BY ar.created_at DESC`
        ).all();
        return json({ requests: rows.results.map((r) => rowToAssetRequest(noirAssetRow(r))) });
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
        await env.NOIR_DB.prepare(
          "INSERT INTO asset_requests (id, hotel_id, item_name, notes, status, requested_by_staff_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)"
        ).bind(id, resolvedNoirHotelId, itemName, notes, requester.id, now, now).run();
        const row = { id, item_name: itemName, notes, status: "requested", requester_dept: toNoirDept(requester.department_id), created_at: now, updated_at: now, returned_at: null };

        const notifyPromise = Promise.all([...DEPT_IDS].filter((d) => d !== requester.department_id).map((deptId) =>
          notifyDepartment(env, deptId, {
            title: "📦 Asset request",
            body: (DEPT_NAMES[requester.department_id] || requester.department_id) + " needs: " + itemName,
            url: "/",
            tag: "hotel-ping-asset-" + id,
          }, requester.department_id).catch(function(e){ console.error("notifyDepartment (asset) error:", e && e.stack || e); })
        ));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notifyPromise); else await notifyPromise;

        return json({ request: rowToAssetRequest(noirAssetRow(row)) }, 201);
      }

      if (method === "POST" && p.startsWith("/api/assets/") && p.endsWith("/status")) {
        const id = decodeURIComponent(p.slice("/api/assets/".length, -"/status".length));
        const body = await readJsonBody(request);
        const status = body.status;
        if (!ASSET_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
        const existing = await env.NOIR_DB.prepare(
          `SELECT ar.*, s.department_id AS requester_dept FROM asset_requests ar
           LEFT JOIN staff s ON s.id = ar.requested_by_staff_id WHERE ar.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        if (fromNoirDept(existing.requester_dept) !== request._staff.department_id && !request._staff.is_admin) {
          return json({ error: "You can only update your own department's requests" }, 403);
        }
        const now = new Date().toISOString();
        await env.NOIR_DB.prepare(
          "UPDATE asset_requests SET status = ?, updated_at = ?, returned_at = ? WHERE id = ?"
        ).bind(status, now, status === "returned" ? now : null, id).run();
        existing.status = status; existing.updated_at = now; existing.returned_at = status === "returned" ? now : null;
        return json({ request: rowToAssetRequest(noirAssetRow(existing)) });
      }

      if (method === "DELETE" && p.startsWith("/api/assets/")) {
        const id = decodeURIComponent(p.slice("/api/assets/".length));
        const existing = await env.NOIR_DB.prepare(
          `SELECT ar.*, s.department_id AS requester_dept FROM asset_requests ar
           LEFT JOIN staff s ON s.id = ar.requested_by_staff_id WHERE ar.id = ?`
        ).bind(id).first();
        if (!existing) return json({ error: "Request not found" }, 404);
        const requester = request._staff;
        if (fromNoirDept(existing.requester_dept) !== requester.department_id && !requester.is_admin) {
          return json({ error: "You can only remove your own department's requests" }, 403);
        }
        await env.NOIR_DB.prepare("DELETE FROM asset_requests WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (method === "POST" && p === "/api/escalations/check") {
        if (!request._staff.is_admin) return json({ error: "Admin access required" }, 403);
        const count = await checkEscalations(env);
        await checkUnnotifiedTickets(env, ctx);
        await checkPlannerAlerts(env, ctx);
        return json({ escalated: count });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      // The failure detail (SQL error text, stack) goes to the Worker's own
      // logs only - returning it to the caller would hand out internal
      // schema/implementation info (table names, column names, query shape)
      // to anyone who can trigger a 500, not just to us debugging via
      // `wrangler tail`.
      console.error("Unhandled error:", err && err.stack || err);
      return json({ error: "Server error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // checkEscalations/checkUnnotifiedTickets read and write each hotel's
    // own messages/tickets, so every provisioned hotel needs its own run -
    // otherwise a second hotel's overdue urgent messages would just never
    // escalate. checkDashboardDepartmentDrift/checkPlannerAlerts are about
    // the external dashboard-bridge integration specifically (not
    // per-hotel data), which only "main" has configured today, so those
    // stay single-run against the unscoped env.
    for (const hotel of Object.values(hotelRegistry(env))) {
      const hotelEnv = Object.assign({}, env, { DB: hotel.db, NOIR_DB: hotel.noirDb, UPLOADS: hotel.uploads });
      ctx.waitUntil(checkEscalations(hotelEnv));
      ctx.waitUntil(checkUnnotifiedTickets(hotelEnv, ctx));
    }
    ctx.waitUntil(checkDashboardDepartmentDrift(env));
    ctx.waitUntil(checkPlannerAlerts(env, ctx));
  },
};
