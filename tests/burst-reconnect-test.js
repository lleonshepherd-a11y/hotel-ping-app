// Simulates what a real multi-browser concurrent-offline-reconnect test
// would stress on the SERVER side: many clients whose queued messages all
// fire in the same instant (Promise.all, zero stagger - the worst case,
// exactly what happens when a Wi-Fi outage ends and every phone's
// flushOfflineQueue() fires at once). 10 "clients" (2 per hotel x 5
// hotels), each bursting 5 queued-style messages simultaneously = 50
// messages landing in the same instant, nonce-tagged for the same
// leak/loss/duplication audit as the main load test.
const BASE = "https://app.hotelping.co.uk";
const HOTELS = ["hotelb", "hotelc", "hoteld", "hotele", "hotelf"];

async function login(hotel, name) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hotel-Slug": hotel },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => null);
  return body && body.token;
}

async function burstClient(hotel, staffName, dept, other, burstSize, sentNonces, results) {
  const token = await login(hotel, staffName);
  if (!token) { results.push({ hotel, staffName, ok: false, reason: "login failed" }); return; }
  const headers = { "Content-Type": "application/json", "X-Hotel-Slug": hotel, "Authorization": "Bearer " + token };
  // Build the burst payloads FIRST (this is what a flushed offline queue
  // looks like - already-formed requests waiting to fire), then fire all
  // of this client's burst in one Promise.all with NO stagger.
  const burst = [];
  for (let i = 0; i < burstSize; i++) {
    const nonce = hotel + "-burst-" + staffName + "-" + i + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    sentNonces.push({ nonce, hotel, dept });
    burst.push({ from: dept, to: other, type: "text", text: "STRESS|" + nonce });
  }
  const t0 = Date.now();
  const responses = await Promise.all(burst.map((payload) =>
    fetch(BASE + "/api/messages", { method: "POST", headers, body: JSON.stringify(payload) })
      .then((r) => r.status)
      .catch((e) => "ERR:" + e)
  ));
  results.push({ hotel, staffName, burstSize, statuses: responses, ms: Date.now() - t0 });
}

async function main() {
  const sentNonces = [];
  const results = [];
  const clients = [];
  for (const hotel of HOTELS) {
    clients.push(burstClient(hotel, "Staff_gm_1", "gm", "foh", 5, sentNonces, results));
    clients.push(burstClient(hotel, "Staff_kitchen_1", "kitchen", "housekeeping", 5, sentNonces, results));
  }
  console.log("Firing", clients.length, "simultaneous burst clients (", clients.length * 5, "messages total) across", HOTELS.length, "hotels - all bursts start together via Promise.all...");
  await Promise.all(clients);

  console.log("\n=== BURST RESULTS ===");
  results.forEach((r) => console.log(r.hotel, r.staffName, "burst of", r.burstSize, "statuses:", JSON.stringify(r.statuses), "took", r.ms + "ms"));
  const allOk = results.every((r) => r.statuses.every((s) => s === 201));
  console.log("\nAll bursts fully successful (every message 201):", allOk);

  require("fs").writeFileSync("/tmp/burst-nonces.json", JSON.stringify(sentNonces));
  console.log("Wrote", sentNonces.length, "burst nonces for audit.");
}
main();
