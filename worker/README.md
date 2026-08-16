# OmniCloud Cloudflare Worker

This directory is the Cloudflare replacement for the Render Node/Express API.

## Target architecture

- Vue/Vite frontend -> Cloudflare Pages
- HTTP API -> Cloudflare Workers
- Persistent relational data -> Neon PostgreSQL
- Upload progress WebSocket -> Durable Object
- Optional OmniCloud-owned binary storage -> Cloudflare R2
- Scheduled synchronization -> Cloudflare Cron Triggers

## Current migration stage

The Worker currently exposes `/api/health` and a temporary `/api/auth/me` response. The existing Render backend remains untouched and is still the source of truth while routes are migrated.

Do not point production traffic at this Worker yet.

## Required Worker secrets

Set these in the Cloudflare dashboard or with Wrangler secrets:

- `DATABASE_URL`
- `AUTH_SECRET`
- `ENCRYPTION_KEY`
- OAuth client secrets when their routes are migrated

Public configuration such as `FRONTEND_URL`, `CORS_ORIGIN`, and OAuth client IDs can be Worker variables.

## Local development

From `worker/`:

```bash
npm install
npm run dev
```

The database schema in `schema.sql` is the destination schema. The existing OmniCloud database is still a SQLite snapshot stored in Neon, so the migration must copy the SQLite rows into these relational tables before the Worker becomes authoritative.
