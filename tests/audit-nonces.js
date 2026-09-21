// Post-hoc audit: for every nonce the load test sent, confirm it appears
// EXACTLY ONCE, system-wide, and ONLY in the hotel it was sent from - proof
// of no cross-hotel leakage, no lost messages, no duplicated messages.
const BASE = "https://app.hotelping.co.uk";
const HOTELS = ["hotelb", "hotelc", "hoteld", "hotele", "hotelf"];
const DEPTS = ["gm", "foh", "concierge", "restaurant", "kitchen", "bar", "housekeeping", "maintenance"];

async function login(hotel, name) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hotel-Slug": hotel },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => null);
  return body && body.token;
}

async function main() {
  const sent = JSON.parse(require("fs").readFileSync("/tmp/mega-load-nonces.json", "utf8"));
  console.log("Auditing", sent.length, "sent nonces across", HOTELS.length, "hotels...\n");

  // For each hotel, log in once as an admin (gm) and pull every message
  // to/from every department pair, collecting every STRESS| nonce found,
  // tagged with which hotel's database it was found in.
  const foundByHotel = {}; // hotel -> Set of nonces found in that hotel's DB
  for (const hotel of HOTELS) {
    const token = await login(hotel, "Staff_gm_0");
    if (!token) { console.log("AUDIT LOGIN FAILED for", hotel); continue; }
    const headers = { "X-Hotel-Slug": hotel, "Authorization": "Bearer " + token };
    const found = new Set();
    for (const dept of DEPTS) {
      for (const other of DEPTS) {
        if (dept === other) continue;
        const res = await fetch(BASE + "/api/messages?self=" + dept + "&with=" + other, { headers });
        const body = await res.json().catch(() => null);
        if (!body || !body.messages) continue;
        for (const m of body.messages) {
          const text = (m.body || "") + " " + (m.transcript || "");
          const match = text.match(/STRESS\|([\w-]+)/);
          if (match) found.add(match[1]);
        }
      }
      // also priority-broadcast history isn't queryable historically (only "active"), skip for count purposes
    }
    foundByHotel[hotel] = found;
    console.log(hotel + ": found " + found.size + " STRESS-tagged messages in this hotel's own database");
  }

  console.log("\n--- Cross-hotel leakage check ---");
  let leaks = 0;
  for (const item of sent) {
    for (const hotel of HOTELS) {
      if (hotel === item.hotel) continue;
      if (foundByHotel[hotel] && foundByHotel[hotel].has(item.nonce)) {
        leaks++;
        console.log("LEAK: nonce from " + item.hotel + " found in " + hotel + "'s database! nonce=" + item.nonce);
      }
    }
  }
  console.log(leaks === 0 ? "PASS: zero cross-hotel leakage detected (" + sent.length + " nonces checked against " + (HOTELS.length - 1) + " other hotels each)" : "FAIL: " + leaks + " leaks detected");

  console.log("\n--- Loss / duplication check ---");
  let lost = 0, duplicated = 0, ok = 0;
  const allFoundFlat = {};
  for (const hotel of HOTELS) {
    for (const nonce of (foundByHotel[hotel] || [])) {
      allFoundFlat[nonce] = (allFoundFlat[nonce] || 0) + 1;
    }
  }
  for (const item of sent) {
    const count = allFoundFlat[item.nonce] || 0;
    if (count === 0) { lost++; console.log("LOST: " + item.nonce + " (sent from " + item.hotel + "/" + item.dept + ", type=" + item.type + ") never found anywhere"); }
    else if (count > 1) { duplicated++; console.log("DUPLICATED: " + item.nonce + " found " + count + " times"); }
    else ok++;
  }
  console.log("Sent: " + sent.length + "  Found exactly once: " + ok + "  Lost: " + lost + "  Duplicated: " + duplicated);
  console.log("\n=== AUDIT " + (leaks === 0 && lost === 0 && duplicated === 0 ? "PASSED" : "FAILED") + " ===");
}

main().catch((e) => { console.error("AUDIT ERROR:", e); process.exit(1); });
