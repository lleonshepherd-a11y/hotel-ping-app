#!/usr/bin/env node
// Compares the route list in src/worker.js (the real, deployed Cloudflare
// Worker) against server/index.js (the local dev mirror) and reports any
// route that exists in one but not the other. Doesn't eliminate the two
// separate implementations - that's a bigger architecture call - but
// catches the class of bug this repo has already hit twice in one night:
// a change (or a whole new endpoint) landing in worker.js without its
// twin in server/index.js, silently breaking local dev / the test suite
// against it, discovered only by accident later.
//
// Run: node scripts/check-route-drift.js
// Exits non-zero (and lists what's missing) if anything's out of sync.

const fs = require("fs");
const path = require("path");

const WORKER_PATH = path.join(__dirname, "..", "src", "worker.js");
const SERVER_PATH = path.join(__dirname, "..", "server", "index.js");

// Matches: (method|req.method) === "X" && p (=== "Y" | .startsWith("Y"))
// - the one line-level shape both files consistently use for every route.
const ROUTE_RE = /(?:req\.)?method\s*===\s*["'](\w+)["']\s*&&\s*p(\.startsWith\(|s*===\s*)["']([^"']+)["']/g;

function extractRoutes(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const routes = new Set();
  let m;
  while ((m = ROUTE_RE.exec(text))) {
    const method = m[1];
    const matchType = m[2].startsWith(".startsWith") ? "prefix" : "exact";
    const routePath = m[3];
    routes.add(method + " " + matchType + " " + routePath);
  }
  return routes;
}

const workerRoutes = extractRoutes(WORKER_PATH);
const serverRoutes = extractRoutes(SERVER_PATH);

const onlyInWorker = [...workerRoutes].filter((r) => !serverRoutes.has(r)).sort();
const onlyInServer = [...serverRoutes].filter((r) => !workerRoutes.has(r)).sort();

console.log("worker.js routes: " + workerRoutes.size + " | server/index.js routes: " + serverRoutes.size);

if (!onlyInWorker.length && !onlyInServer.length) {
  console.log("No drift detected - every route pattern in worker.js has a matching one in server/index.js, and vice versa.");
  process.exit(0);
}

if (onlyInWorker.length) {
  console.log("\nIn worker.js but missing from server/index.js (" + onlyInWorker.length + "):");
  onlyInWorker.forEach((r) => console.log("  " + r));
}
if (onlyInServer.length) {
  console.log("\nIn server/index.js but missing from worker.js (" + onlyInServer.length + "):");
  onlyInServer.forEach((r) => console.log("  " + r));
}
console.log("\nNote: this compares route SHAPES (method + path pattern), not behavior - two routes can match here and still do different things inside. It catches a route existing in only one file, not every kind of drift.");
process.exit(1);
