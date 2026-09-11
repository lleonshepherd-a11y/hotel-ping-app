# Hotel Ping

Department messaging app for hotel staff. Real backend, real frontend, staff sign-in.

**Live deployment:** runs on Cloudflare Workers, with a D1 database and R2 file storage — no server to maintain.

## Sign in

- Name: `Dave`
- PIN: `1234`

Sign in as Dave, then use "Manage staff" to add real staff accounts and change that PIN.

## Deploying (Cloudflare)

```
npx wrangler deploy
```

Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set, and `wrangler.toml` pointing at your own D1 database and R2 bucket (created once with `wrangler d1 create` / `wrangler r2 bucket create`, then the schema applied with `wrangler d1 execute hotel-ping-db --remote --file=schema.sql`).

## Running locally instead (Node.js version)

A plain Node.js version also exists under `server/` and `public/` for local development, using the built-in `node:sqlite` module — no external database needed.

```
npm start
```

Opens on http://localhost:4100, storing data in `data/` (uploads + SQLite file).
