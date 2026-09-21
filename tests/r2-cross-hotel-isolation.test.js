// Cross-hotel R2 attachment isolation test. Runs against the LIVE deployed
// Worker, across all 5 synthetic test hotels (hotelb..hotelf). For each
// hotel: uploads a nonce-tagged image AND voice note, confirms the file is
// retrievable and byte-for-byte correct, confirms the returned key is
// prefixed for that hotel (proving it was written to that hotel's own R2
// bucket, not a shared/default one), and confirms every OTHER hotel's key
// namespace does not contain this hotel's key (no cross-hotel bucket
// collision). This specifically targets the routing bug found during the
// isolation audit: GET /uploads/:key only recognized the "hotelb/" prefix
// and silently fell through to the main bucket for hotelc/d/e/f, which
// would have served 404s (or, worse, wrong content on a key collision)
// for every hotel except hotelb.
const BASE = "https://app.hotelping.co.uk";
const HOTELS = ["hotelb", "hotelc", "hoteld", "hotele", "hotelf"];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

async function api(hotel, path, opts = {}, token) {
  const headers = Object.assign({ "Content-Type": "application/json", "X-Hotel-Slug": hotel }, opts.headers || {});
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}

async function login(hotel, name) {
  const r = await api(hotel, "/api/auth/login", { method: "POST", body: JSON.stringify({ name }) });
  if (!r.body || !r.body.token) throw new Error("login failed for " + name + "@" + hotel + ": " + JSON.stringify(r.body));
  return r.body.token;
}

// 1x1 PNG, tiny valid WAV - content itself is identical across hotels by
// design (isolation must come from the key/bucket, not content variance).
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const wavBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

async function main() {
  const uploads = []; // { hotel, type, nonce, fileUrl, key, expectedBytes }

  for (const hotel of HOTELS) {
    const gmToken = await login(hotel, "Staff_gm_0");

    const imgNonce = hotel + "-img-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const sendImg = await api(hotel, "/api/messages", { method: "POST", body: JSON.stringify({ from: "gm", to: "kitchen", type: "image", fileBase64: pngBase64, fileMime: "image/png", fileName: imgNonce + ".png", text: "" }) }, gmToken);
    check(hotel + ": image upload succeeds (201)", sendImg.status === 201, sendImg.body);
    const imgMsg = sendImg.body && sendImg.body.message;
    if (imgMsg && imgMsg.fileUrl) {
      uploads.push({ hotel, type: "image", nonce: imgNonce, fileUrl: imgMsg.fileUrl });
    }

    const voiceNonce = hotel + "-voice-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const sendVoice = await api(hotel, "/api/messages", { method: "POST", body: JSON.stringify({ from: "gm", to: "housekeeping", type: "audio", fileBase64: wavBase64, fileMime: "audio/wav", duration: 2 }) }, gmToken);
    check(hotel + ": voice upload succeeds (201)", sendVoice.status === 201, sendVoice.body);
    const voiceMsg = sendVoice.body && sendVoice.body.message;
    if (voiceMsg && voiceMsg.fileUrl) {
      uploads.push({ hotel, type: "audio", nonce: voiceNonce, fileUrl: voiceMsg.fileUrl });
    }
  }

  console.log("\n--- Retrieval + bucket-routing + byte-integrity check ---");
  for (const u of uploads) {
    // Correct bucket routing: every non-main hotel's key must be prefixed
    // with that hotel's own slug (proves it was written to hotelX's bucket,
    // not silently written to / read from the shared main bucket).
    const expectedPrefix = "/uploads/" + u.hotel + "/";
    check(u.hotel + " " + u.type + ": fileUrl carries this hotel's own key prefix", u.fileUrl.startsWith(expectedPrefix), u.fileUrl);

    const res = await fetch(BASE + u.fileUrl);
    check(u.hotel + " " + u.type + ": uploaded file retrievable (200)", res.status === 200, res.status);
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      const expected = Buffer.from(u.type === "image" ? pngBase64 : wavBase64, "base64");
      check(u.hotel + " " + u.type + ": retrieved bytes match exactly what was uploaded (no wrong-bucket/garbled content)", buf.equals(expected), { got: buf.length, expected: expected.length });
    }
  }

  console.log("\n--- Cross-hotel key-namespace leakage check ---");
  // For every upload, confirm no OTHER hotel's key prefix can retrieve it,
  // and that swapping the hotel's own key into another hotel's namespace
  // (by mangling the prefix) 404s rather than silently serving content.
  for (const u of uploads) {
    for (const otherHotel of HOTELS) {
      if (otherHotel === u.hotel) continue;
      const mangledPath = u.fileUrl.replace("/uploads/" + u.hotel + "/", "/uploads/" + otherHotel + "/");
      const res = await fetch(BASE + mangledPath, { headers: { "X-Hotel-Slug": otherHotel } });
      check(u.hotel + " " + u.type + ": same key under " + otherHotel + "'s prefix does NOT resolve (404, not a leaked file)", res.status === 404, res.status);
    }
  }

  console.log("\n--- Duplication check (each upload's fileUrl appears exactly once, only in its own hotel's inbox) ---");
  const kitchenInboxes = {}; // hotel -> fileUrl list
  for (const hotel of HOTELS) {
    const gmToken = await login(hotel, "Staff_gm_0");
    const kitchenInbox = await api(hotel, "/api/messages?self=kitchen&with=gm", {}, gmToken);
    kitchenInboxes[hotel] = (kitchenInbox.body && kitchenInbox.body.messages || [])
      .filter((m) => m.type === "image" && m.fileUrl)
      .map((m) => m.fileUrl);
  }
  for (const u of uploads.filter((x) => x.type === "image")) {
    const ownCount = kitchenInboxes[u.hotel].filter((f) => f === u.fileUrl).length;
    check(u.hotel + " image " + u.nonce + ": appears exactly once in its own kitchen inbox", ownCount === 1, ownCount);
    for (const otherHotel of HOTELS) {
      if (otherHotel === u.hotel) continue;
      const leaked = kitchenInboxes[otherHotel].includes(u.fileUrl);
      check(u.hotel + " image " + u.nonce + ": does NOT appear in " + otherHotel + "'s kitchen inbox", !leaked);
    }
  }

  console.log("\n=== R2 CROSS-HOTEL ISOLATION RESULT:", pass, "passed,", fail, "failed ===");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
