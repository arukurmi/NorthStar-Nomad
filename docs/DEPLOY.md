# Deploying Northstar Nomad

The app ships as **one Node service**: Express serves the API *and* the built
frontend (`web/dist`). No separate frontend host needed.

## Render (recommended, free, ~3 clicks)

The repo contains a `render.yaml` blueprint.

1. Go to https://dashboard.render.com → **New → Blueprint**.
2. Connect the `arukurmi/northstar-nomad` GitHub repo.
3. Render reads `render.yaml`, provisions the free web service, generates a
   `JWT_SECRET`, builds the frontend, and starts the server. Done — you get
   `https://northstar-nomad.onrender.com`.

Every `git push` to `main` auto-deploys after that.

**Free-tier caveats (worth knowing, fine for launch):**
- The service sleeps after 15 min idle; first visit after that takes ~30s.
- The disk is ephemeral: the SQLite file (users + trips) **resets on every
  deploy/restart**. For real users, upgrade later to a Render paid disk, or
  point the DB layer at Turso (free serverless SQLite) — the code only needs
  a different `NOMAD_DB`/driver, nothing else changes.

## Local production sanity check

```bash
npm run build --workspace=web
npm run start --workspace=server   # serves app + API on :4000
```

## Environment variables

| Var | Purpose | Default |
| --- | --- | --- |
| `NOMAD_MASTER_KEY` | Encrypts every user's AI API key at rest (AES-256-GCM). **Required in production** — the server refuses to boot without it. Must carry ≥ 32 bytes of key material: `openssl rand -base64 48`. | public dev key, non-production only |
| `JWT_SECRET` | Signs auth tokens. **Required in production** — the server refuses to boot without it, or with the built-in dev value. `openssl rand -base64 48`. | dev fallback, non-production only |
| `NODE_ENV` | `production` on any deployed host. Selects the strict boot checks and the file-backed SQLite database. | unset (development) |
| `NOMAD_WEB_ORIGIN` | Comma-separated origins allowed to call the API cross-origin. Not needed when this service also serves `web/dist`. | none in production, permissive in dev |
| `PORT` | Listen port | 4000 |
| `NOMAD_DB` | SQLite file path | `data.sqlite` |

`render.yaml` sets `NOMAD_MASTER_KEY` and `JWT_SECRET` with `generateValue: true`,
so Render generates both on first provision and never shows them in the repo.
**Rotating `NOMAD_MASTER_KEY` makes every stored AI key permanently unreadable**
— there is no re-encryption tooling. See `docs/THREAT-MODEL.md`.

Two things are deliberately fatal rather than degraded:

- A production process without a usable `NOMAD_MASTER_KEY` would encrypt real
  users' keys under a constant that is published in this repository.
- A production process without a usable `JWT_SECRET` would accept session tokens
  anyone could forge, which reaches those same keys.

Both are also refused when a platform marker (`RENDER`, `K_SERVICE`, `DYNO`,
`FLY_APP_NAME`, …) is present, even if `NODE_ENV` was never set.

## Why not Vercel?

The frontend alone could live on Vercel, but auth + trips need a persistent
Node process and a writable disk; Vercel's serverless functions have neither.
One Render service keeps it simple and free.
