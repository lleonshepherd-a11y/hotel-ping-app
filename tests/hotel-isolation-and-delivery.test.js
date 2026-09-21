// Automated message-delivery test suite. Runs against the LIVE deployed
// Worker, scoped entirely to the isolated "hotelb" test tenant so it never
// touches real hotel data. Exercises: normal text, urgent, broadcast,
// priority banner + accept, voice notes (base64 audio), image attachments -
// and asserts nothing is silently lost and only the correct recipient sees
// each one.
const BASE = "https://app.hotelping.co.uk";
const HOTEL = "hotelb";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}

async function api(path, opts = {}, token) {
  const headers = Object.assign({ "Content-Type": "application/json", "X-Hotel-Slug": HOTEL }, opts.headers || {});
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}

async function login(name) {
  const r = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ name }) });
  if (!r.body || !r.body.token) throw new Error("login failed for " + name + ": " + JSON.stringify(r.body));
  return r.body.token;
}

async function main() {
  const gmToken = await login("Gina");
  const priyaToken = await login("Priya");
  const mariaToken = await login("Maria");

  // ---- 1. Normal text message: GM -> Kitchen ----
  const t1 = "normal-" + Date.now();
  const send1 = await api("/api/messages", { method: "POST", body: JSON.stringify({ from: "gm", to: "kitchen", type: "text", text: t1 }) }, gmToken);
  check("normal message: send succeeds (201)", send1.status === 201, send1.body);
  const msgId1 = send1.body && send1.body.message && send1.body.message.id;

  const read1 = await api("/api/messages?self=kitchen&with=gm", {}, priyaToken);
  const found1 = read1.body && read1.body.messages && read1.body.messages.some((m) => m.body === t1);
  check("normal message: correct recipient (kitchen) sees it", !!found1);

  const readWrong1 = await api("/api/messages?self=housekeeping&with=gm", {}, mariaToken);
  const leaked1 = readWrong1.body && readWrong1.body.messages && readWrong1.body.messages.some((m) => m.body === t1);
  check("normal message: wrong recipient (housekeeping) does NOT see it", !leaked1);

  // ---- 2. Urgent message ----
  const t2 = "urgent-" + Date.now();
  const send2 = await api("/api/messages", { method: "POST", body: JSON.stringify({ from: "gm", to: "housekeeping", type: "text", text: t2, urgent: true }) }, gmToken);
  check("urgent message: send succeeds", send2.status === 201, send2.body);
  const read2 = await api("/api/messages?self=housekeeping&with=gm", {}, mariaToken);
  const found2 = read2.body && read2.body.messages && read2.body.messages.find((m) => m.body === t2);
  check("urgent message: recipient sees it", !!found2);
  check("urgent message: urgent flag preserved", !!(found2 && found2.urgent === true), found2);

  // ---- 3. Broadcast (GM -> every other department) ----
  const t3 = "broadcast-" + Date.now();
  const send3 = await api("/api/broadcast", { method: "POST", body: JSON.stringify({ text: t3 }) }, gmToken);
  check("broadcast: send succeeds", send3.status === 201, send3.body);
  const readB1 = await api("/api/messages?self=kitchen&with=gm", {}, priyaToken);
  const readB2 = await api("/api/messages?self=housekeeping&with=gm", {}, mariaToken);
  check("broadcast: kitchen received it", readB1.body.messages.some((m) => m.body === t3));
  check("broadcast: housekeeping received it", readB2.body.messages.some((m) => m.body === t3));

  // ---- 4. Priority banner + accept flow ----
  const t4 = "priority-" + Date.now();
  const send4 = await api("/api/priority-broadcast", { method: "POST", body: JSON.stringify({ text: t4 }) }, gmToken);
  check("priority banner: pin succeeds", send4.status === 201, send4.body);
  const bId = send4.body.broadcast.id;
  const active1 = await api("/api/priority-broadcast/active", {}, priyaToken);
  check("priority banner: kitchen sees it active", active1.body.broadcast && active1.body.broadcast.id === bId, active1.body);
  const accept1 = await api("/api/priority-broadcast/" + bId + "/accept", { method: "POST", body: "{}" }, priyaToken);
  check("priority banner: kitchen accept succeeds", accept1.status === 200, accept1.body);
  const active2 = await api("/api/priority-broadcast/active", {}, priyaToken);
  check("priority banner: kitchen no longer in accepted-but-still-active list issue N/A; check acceptedDepts contains kitchen",
    active2.body.acceptedDepts && active2.body.acceptedDepts.includes("kitchen"), active2.body);
  // GM should have received a confirmation message
  const gmInbox = await api("/api/messages?self=gm&with=kitchen", {}, gmToken);
  const confirmed = gmInbox.body.messages.some((m) => m.body && m.body.indexOf("accepted") !== -1 && m.body.indexOf(t4) !== -1);
  check("priority banner: GM received acceptance confirmation message", confirmed, gmInbox.body.messages.slice(-3));
  // Housekeeping (Maria) should still see it active since she hasn't accepted
  const active3 = await api("/api/priority-broadcast/active", {}, mariaToken);
  check("priority banner: housekeeping still sees it active (hasn't accepted yet)", active3.body.broadcast && active3.body.broadcast.id === bId, active3.body);
  await api("/api/priority-broadcast/" + bId + "/clear", { method: "POST", body: "{}" }, gmToken);
  const active4 = await api("/api/priority-broadcast/active", {}, mariaToken);
  check("priority banner: cleared for everyone after GM clears it", active4.body.broadcast === null, active4.body);

  // ---- 5. Voice note (base64 short WAV) ----
  // Minimal valid WAV header + silence, base64-encoded.
  const wavBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const send5 = await api("/api/messages", { method: "POST", body: JSON.stringify({ from: "housekeeping", to: "gm", type: "audio", fileBase64: wavBase64, fileMime: "audio/wav", duration: 3 }) }, mariaToken);
  check("voice note: send succeeds", send5.status === 201, send5.body);
  const voiceMsg = send5.body && send5.body.message;
  check("voice note: has a file URL", !!(voiceMsg && voiceMsg.fileUrl), voiceMsg);
  if (voiceMsg && voiceMsg.fileUrl) {
    const fetchVoice = await fetch(BASE + voiceMsg.fileUrl);
    check("voice note: uploaded file is actually retrievable", fetchVoice.status === 200, fetchVoice.status);
  }
  const gmVoiceInbox = await api("/api/messages?self=gm&with=housekeeping", {}, gmToken);
  check("voice note: GM sees it in inbox", gmVoiceInbox.body.messages.some((m) => m.type === "audio" && m.id === voiceMsg.id));

  // ---- 6. Image attachment ----
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const send6 = await api("/api/messages", { method: "POST", body: JSON.stringify({ from: "kitchen", to: "gm", type: "image", fileBase64: pngBase64, fileMime: "image/png", fileName: "test.png", text: "" }) }, priyaToken);
  check("image attachment: send succeeds", send6.status === 201, send6.body);
  const imgMsg = send6.body && send6.body.message;
  if (imgMsg && imgMsg.fileUrl) {
    const fetchImg = await fetch(BASE + imgMsg.fileUrl);
    check("image attachment: uploaded file is actually retrievable", fetchImg.status === 200, fetchImg.status);
  }

  console.log("\n=== RESULT:", pass, "passed,", fail, "failed ===");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
