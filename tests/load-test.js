// Load test: ~30 concurrent staff, each logging in once then repeatedly
// polling (GET /api/messages, matching the real app's 1.5s poll cadence)
// and periodically sending a message, sustained for DURATION_MS. Runs
// against the isolated "hotelb" test tenant on the live deployed Worker -
// never touches real hotel data. Reports latency percentiles and error
// rate per endpoint.
const BASE = "https://app.hotelping.co.uk";
const HOTEL = "hotelb";
const STAFF_COUNT = 30;
const DURATION_MS = 30000;
const POLL_INTERVAL_MS = 1500;
const SEND_INTERVAL_MS = 4000;

const DEPTS = ["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"];

const stats = {}; // endpoint -> { ok, fail, latencies: [] }
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

async function timedFetch(endpoint, url, opts) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, opts);
    const ms = Date.now() - t0;
    record(endpoint, res.status >= 200 && res.status < 300, ms);
    return res;
  } catch (e) {
    record(endpoint, false, Date.now() - t0);
    return null;
  }
}

async function login(name) {
  const res = await timedFetch("login", BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hotel-Slug": HOTEL },
    body: JSON.stringify({ name }),
  });
  if (!res) return null;
  const body = await res.json().catch(() => null);
  return body && body.token;
}

async function worker(i, endTime) {
  const name = "LoadStaff" + i;
  const dept = DEPTS[i % DEPTS.length];
  const token = await login(name);
  if (!token) { console.log("worker", i, "failed to log in"); return; }
  const headers = { "Content-Type": "application/json", "X-Hotel-Slug": HOTEL, "Authorization": "Bearer " + token };
  const other = DEPTS[(i + 1) % DEPTS.length];

  let lastSend = 0;
  while (Date.now() < endTime) {
    await timedFetch("get_messages", BASE + "/api/messages?self=" + dept + "&with=" + other, { headers });
    await timedFetch("get_conversations", BASE + "/api/conversations?self=" + dept, { headers });

    if (Date.now() - lastSend > SEND_INTERVAL_MS) {
      lastSend = Date.now();
      await timedFetch("post_message", BASE + "/api/messages", {
        method: "POST", headers,
        body: JSON.stringify({ from: dept, to: other, type: "text", text: "load-" + i + "-" + Date.now() }),
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  console.log("Starting load test:", STAFF_COUNT, "concurrent staff for", DURATION_MS / 1000, "seconds...");
  const endTime = Date.now() + DURATION_MS;
  const workers = [];
  for (let i = 0; i < STAFF_COUNT; i++) {
    workers.push(worker(i, endTime));
    await new Promise((r) => setTimeout(r, 50)); // stagger logins slightly, like real staff opening the app
  }
  await Promise.all(workers);

  console.log("\n=== LOAD TEST RESULTS ===");
  let totalOk = 0, totalFail = 0;
  for (const [endpoint, s] of Object.entries(stats)) {
    totalOk += s.ok; totalFail += s.fail;
    console.log(
      endpoint.padEnd(18),
      "ok=" + s.ok, "fail=" + s.fail,
      "p50=" + pctl(s.latencies, 0.5) + "ms",
      "p95=" + pctl(s.latencies, 0.95) + "ms",
      "max=" + Math.max(...s.latencies) + "ms"
    );
  }
  console.log("\nTOTAL requests:", totalOk + totalFail, " errors:", totalFail, " error rate:", ((totalFail / (totalOk + totalFail)) * 100).toFixed(2) + "%");
}

main();
