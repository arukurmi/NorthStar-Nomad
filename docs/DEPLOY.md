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
| `JWT_SECRET` | Signs auth tokens — set a strong value in prod | dev fallback |
| `PORT` | Listen port | 4000 |
| `NOMAD_DB` | SQLite file path | `data.sqlite` |

## Why not Vercel?

The frontend alone could live on Vercel, but auth + trips need a persistent
Node process and a writable disk; Vercel's serverless functions have neither.
One Render service keeps it simple and free.
