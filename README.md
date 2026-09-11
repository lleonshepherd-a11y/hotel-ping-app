# Hotel Ping

Department messaging app for hotel staff. Real backend (Node.js + SQLite), real frontend, staff sign-in.

## Run it

Needs Node.js 22.5 or newer (uses the built-in `node:sqlite` module — no external database).

```
npm start
```

Opens on http://localhost:4100

First run creates `data/message-dash.sqlite` and seeds one admin account:

- Name: `Dave`
- PIN: `1234`

Sign in as Dave, then use "Manage staff" to add real staff accounts and change that PIN.

## Deploying to a server

1. Copy this folder to the server.
2. Install Node.js 22+ if it isn't already there.
3. Run `npm start` (or better, keep it running with a process manager like `pm2` so it survives reboots/crashes: `pm2 start server/index.js --name hotel-ping`).
4. Put it behind a reverse proxy (nginx or Caddy) on port 80/443 so it's reachable at the real domain, with HTTPS.
5. Point the domain's DNS A record at the server's IP.

`data/` holds the database and uploaded files — back it up regularly.
