# Pinterest AI Quote Agent

Telegram-controlled generator, multi-board scheduler and publisher for Pinterest quote Pins.

Send keywords to the bot → it writes original quotes + SEO metadata (Gemini), generates text-free backgrounds (Imagen / Gemini image), sets the quote with real typography (Sharp + Pango), stores images on Cloudflare R2, shows previews in Telegram, recommends boards from your real Pinterest boards, and publishes on a schedule through the official Pinterest API v5 — **only after your explicit confirmation**.

## Architecture

```
Telegram ──webhook──> API service (Express + grammY) ──> PostgreSQL (source of truth)
                              │                              ▲
                              └──> BullMQ (Redis) ──> Worker service
                                                        ├─ content-generation   (quotes + SEO, rewrites)
                                                        ├─ background-generation (AI background → R2)
                                                        ├─ image-rendering       (Sharp typography → JPEG → R2)
                                                        ├─ pinterest-publishing  (publish + reconcile unknown outcomes)
                                                        └─ maintenance           (schedule reconciliation, image cleanup)
```

Both services run from the same image: `node dist/server.js` (API) and `node dist/worker.js` (worker).

## Feature map

| Spec area | Where |
| --- | --- |
| Commands & natural-language input | `src/bot/commands.ts`, `src/bot/handlers/text.ts` |
| Batch review, edit, regenerate, approve/reject | `src/bot/handlers/callbacks.ts`, `src/modules/batches/*` |
| Quote + SEO generation, Zod validation, duplicate checks (lexical + embeddings) | `src/modules/ai/*` |
| Backgrounds (10 styles), typography (6 presets), measured auto-fit, contrast scrim, watermark | `src/modules/images/*` |
| Cloudflare R2 storage (S3 SDK v3), unique keys, cache headers, cleanup | `src/modules/storage/r2.service.ts`, `src/modules/scheduling/reconciliation.service.ts` |
| Pinterest OAuth (single-use state), AES-256-GCM token storage, refresh, boards pagination, pin creation | `src/modules/pinterest/*` |
| Board assignment: Auto / Manual / Unique, never invents board IDs | `src/modules/boards/assignment.service.ts` |
| Scheduling: now / hourly / custom interval / custom start, timezone aware, pause/resume/reschedule/cancel | `src/modules/scheduling/schedule.service.ts` |
| Publishing safety: atomic claims, version-locked approvals, `PUBLISH_UNKNOWN` reconciliation, no blind retries | `src/modules/publishing/publishing.service.ts` |
| Restart recovery & missed-schedule policy | `src/modules/scheduling/reconciliation.service.ts`, `src/worker.ts` |
| Security: allowlist, webhook secret, rate limits, stale-callback rejection, log redaction | `src/bot/bot.ts`, `src/app.ts`, `src/config/logger.ts` |

## Key design decisions

- **Approval is version-locked.** Every content/board change bumps `pin_drafts.version` and clears approval. The final *Confirm Schedule* approves exactly the versions shown in the review; the publisher re-checks `version == approvedVersion` before calling Pinterest.
- **PostgreSQL is the schedule source of truth.** BullMQ only triggers. On worker start (and every 5 min) schedules are reconciled with the queue. Missed slots are shifted (or paused, `MISSED_SCHEDULE_POLICY=pause`) — never published as a burst.
- **No duplicate pins.** A publish is claimed with row locks + conditional updates; a draft can have only one `SUCCEEDED` publish (partial unique index). Timeouts/5xx on create mark the job `PUBLISH_UNKNOWN`; the reconciler searches the board for the pin (title + description + alt text, excluding known pins) several times before retrying.
- **Telegram callbacks** carry only short IDs (UUIDs as 22-char base64url) and the draft version; all state lives in PostgreSQL.
- **ORM: Drizzle** (instead of Prisma). Same PostgreSQL schema and SQL migrations in `drizzle/`; chosen because Prisma's engine binaries could not be downloaded in the build sandbox, which would have made the database layer untestable.
- **AI background fallback.** If the image model fails on the final retry (or refuses for safety reasons), a procedural gradient background is used and recorded in `image_assets.generation_prompt` as `[fallback:…]`, so a batch is never lost. You can regenerate the background afterwards.
- One finished image per pin (no automatic variations) to control image API cost; regenerate on demand.

## Local development

```bash
npm install
cp .env.example .env    # fill in; for offline dev use AI_*_PROVIDER=mock, STORAGE_DRIVER=local, TELEGRAM_USE_POLLING=true
npm run db:migrate:dev
npm run dev             # API + bot
npm run dev:worker      # workers (second terminal)
npm run render:sample   # writes sample pins to ./samples
```

## Tests

Requires PostgreSQL (database `pinterest_agent_test`) and Redis (db 1) on localhost, or set `TEST_DATABASE_URL` / `TEST_REDIS_URL`.

```bash
npm test
```

Suites: unit (text/time/crypto/callbacks/state machine/AI validation & dedupe/board assignment/renderer), integration (Pinterest OAuth, refresh, pagination, API error classes, webhook secret, OAuth callback) and an end-to-end flow (Telegram update → workers → previews → auto boards → edit → regenerate → approve → schedule → publish → confirmation → duplicate prevention → pause/resume → restart recovery → missed schedules → unknown-outcome reconciliation → history). External APIs are mocked (fake Telegram API, fake Pinterest v5 server, mock AI providers); **real Gemini/Imagen, R2, Telegram and Pinterest calls have not been exercised by the test suite.**

## Deploying on Railway

1. Create a Railway project; add **PostgreSQL** and **Redis**.
2. Add service **api** from this GitHub repo. Settings → Config file: `railway.json`. Generate a public domain.
3. Add service **worker** from the same repo. Config file: `railway.worker.json`. No public domain needed.
4. Set variables on both services (see `.env.example`). Use references: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`. Set `APP_BASE_URL` to the api domain.
5. Deploy. The api runs migrations as a pre-deploy step (`node dist/db/migrate.js`), then registers the Telegram webhook at `APP_BASE_URL/telegram/webhook` on boot. Health check: `GET /health`.
6. Backups: enable Railway PostgreSQL backups (Database → Backups) and/or schedule `pg_dump`.

### Cloudflare R2

Create a bucket, connect a **custom domain** (recommended for production; `r2.dev` URLs are rate-limited) and create an API token with *Object Read & Write* on that bucket. Set `R2_*` variables; `R2_PUBLIC_BASE_URL` must be the public HTTPS base. Pinterest must be able to fetch images from it.

### Pinterest app

1. developers.pinterest.com → create app; add redirect URI `https://<api-domain>/oauth/pinterest/callback`.
2. Scopes used: `boards:read, pins:read, pins:write, user_accounts:read`.
3. New apps start with **Trial access**: per Pinterest's docs, pins created with trial access go to the sandbox (`PINTEREST_API_BASE=https://api-sandbox.pinterest.com/v5`) and are not public. Apply for **Standard access** to publish real pins. Verify current rules in Pinterest's documentation.
4. In Telegram: `/connect` → authorize → `/boards`.

### First real end-to-end test

1. `/start` (must say “Access verified”), `/account`, `/boards`.
2. Send `3 heartbreak and healing` → wait for the album + summary.
3. Preview, edit one title, assign boards (Auto), *Approve All*.
4. *Approve & Schedule* → *Custom Schedule* → *Every 1h* → *Start now* → check the review → *Confirm Schedule*.
5. Expect “Pin 1 Published Successfully!” with a Pinterest link; check `/queue` and `/history`.
