// Heavy multi-tenant stress test: 5 synthetic hotels, 24 staff each (120
// concurrent workers), mixed workload sustained over DURATION_MS, against
// the live deployed Worker. Every sent message body is tagged with a
// unique nonce + the hotel it was sent from, so a post-hoc audit can prove:
// zero cross-hotel leakage, zero lost messages, zero duplicated messages.
const BASE = "https://app.hotelping.co.uk";
const HOTELS = ["hotelb", "hotelc", "hoteld", "hotele", "hotelf"];
const DEPTS = ["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"];
const STAFF_PER_DEPT = 3;
const DURATION_MS = 45000;
const POLL_INTERVAL_MS = 1500;
const SEND_INTERVAL_MS = 3000;

const stats = {};
function record(endpoint, ok, ms) {
  stats[endpoint] = stats[endpoint] || { ok: 0, fail: 0, latencies: [] };
  if (ok) stats[endpoint].ok++; else stats[endpoint].fail++;
  stats[endpoint].latencies.push(ms);
}
function pctl(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const sentNonces = []; // { nonce, hotel, dept, other, type }
const failures = [];

async function timedFetch(endpoint, url, opts) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, opts);
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 300;
    record(endpoint, ok, ms);
    if (!ok) failures.push({ endpoint, status: res.status, url });
    return res;
  } catch (e) {
    record(endpoint, false, Date.now() - t0);
    failures.push({ endpoint, error: String(e), url });
    return null;
  }
}

async function login(hotel, name) {
  const res = await timedFetch("login", BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hotel-Slug": hotel },
    body: JSON.stringify({ name }),
  });
  if (!res) return null;
  const body = await res.json().catch(() => null);
  return body && body.token;
}

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

async function worker(hotel, dept, idx, endTime, adminToken) {
  const name = "Staff_" + dept + "_" + idx;
  const token = await login(hotel, name);
  if (!token) { console.log("LOGIN FAILED:", hotel, name); return; }
  const headers = { "Content-Type": "application/json", "X-Hotel-Slug": hotel, "Authorization": "Bearer " + token };
  const otherDepts = DEPTS.filter((d) => d !== dept);
  let sendCount = 0;

  let lastSend = 0;
  while (Date.now() < endTime) {
    await timedFetch("get_messages", BASE + "/api/messages?self=" + dept + "&with=" + otherDepts[sendCount % otherDepts.length], { headers });
    await timedFetch("get_conversations", BASE + "/api/conversations?self=" + dept, { headers });

    if (Date.now() - lastSend > SEND_INTERVAL_MS) {
      lastSend = Date.now();
      const other = otherDepts[Math.floor(Math.random() * otherDepts.length)];
      const nonce = hotel + "-" + dept + "-" + idx + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const roll = Math.random();
      let payload, type;
      if (roll < 0.7) {
        type = "text";
        payload = { from: dept, to: other, type: "text", text: "STRESS|" + nonce };
      } else if (roll < 0.85) {
        type = "urgent";
        payload = { from: dept, to: other, type: "text", text: "STRESS|" + nonce, urgent: true };
      } else if (roll < 0.93) {
        type = "voice";
        payload = { from: dept, to: other, type: "audio", fileBase64: TINY_WAV, fileMime: "audio/wav", duration: 3, transcript: "STRESS|" + nonce };
      } else {
        type = "image";
        payload = { from: dept, to: other, type: "image", fileBase64: TINY_PNG, fileMime: "image/png", fileName: "s.png", text: "STRESS|" + nonce };
      }
      sentNonces.push({ nonce, hotel, dept, other, type });
      await timedFetch("post_message", BASE + "/api/messages", { method: "POST", headers, body: JSON.stringify(payload) });
      sendCount++;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// One admin per hotel also fires priority broadcasts periodically ("front
// events") - pin, let it sit, clear it, repeat - to load-test that path
// concurrently with everything else.
async function bannerWorker(hotel, endTime) {
  const token = await login(hotel, "Staff_gm_0");
  if (!token) return;
  const headers = { "Content-Type": "application/json", "X-Hotel-Slug": hotel, "Authorization": "Bearer " + token };
  while (Date.now() < endTime) {
    const nonce = hotel + "-banner-" + Date.now();
    const res = await timedFetch("post_priority_banner", BASE + "/api/priority-broadcast", {
      method: "POST", headers, body: JSON.stringify({ text: "STRESS-BANNER|" + nonce }),
    });
    if (res && res.ok) {
      const body = await res.json().catch(() => null);
      await new Promise((r) => setTimeout(r, 2500));
      if (body && body.broadcast) {
        await timedFetch("clear_priority_banner", BASE + "/api/priority-broadcast/" + body.broadcast.id + "/clear", { method: "POST", headers, body: "{}" });
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  console.log("Starting mega load test:", HOTELS.length, "hotels x", DEPTS.length * STAFF_PER_DEPT, "staff each =", HOTELS.length * DEPTS.length * STAFF_PER_DEPT, "concurrent workers, for", DURATION_MS / 1000, "seconds...");
  const endTime = Date.now() + DURATION_MS;
  const workers = [];
  for (const hotel of HOTELS) {
    for (const dept of DEPTS) {
      for (let i = 0; i < STAFF_PER_DEPT; i++) {
        workers.push(worker(hotel, dept, i, endTime));
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    workers.push(bannerWorker(hotel, endTime));
  }
  await Promise.all(workers);

  console.log("\n=== LOAD RESULTS ===");
  let totalOk = 0, totalFail = 0;
  for (const [endpoint, s] of Object.entries(stats)) {
    totalOk += s.ok; totalFail += s.fail;
    console.log(
      endpoint.padEnd(24),
      "ok=" + s.ok, "fail=" + s.fail,
      "p50=" + pctl(s.latencies, 0.5) + "ms",
      "p95=" + pctl(s.latencies, 0.95) + "ms",
      "max=" + (s.latencies.length ? Math.max(...s.latencies) : 0) + "ms"
    );
  }
  console.log("\nTOTAL requests:", totalOk + totalFail, " errors:", totalFail, " error rate:", ((totalFail / (totalOk + totalFail)) * 100).toFixed(3) + "%");
  console.log("Messages sent (all types):", sentNonces.length);
  if (failures.length) {
    console.log("\nFirst 10 failures:");
    failures.slice(0, 10).forEach((f) => console.log(" -", JSON.stringify(f)));
  }

  require("fs").writeFileSync("/tmp/mega-load-nonces.json", JSON.stringify(sentNonces));
  console.log("\nWrote", sentNonces.length, "sent nonces to /tmp/mega-load-nonces.json for post-hoc audit.");
}

main();
