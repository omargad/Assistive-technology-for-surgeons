# SurgeonPulse research ingest server — spec

A small, self-hostable reference API that collects **de-identified** sessions from enrolled participants' phones
and serves them to researchers (through the dashboard or direct export). It's designed to run on
university-controlled infrastructure: no third-party services, a single SQLite file, and no patient data.

Stack: Node ≥ 22.13 (`node:sqlite` loads without a flag from 22.13), Fastify 5, `node:sqlite` (`DatabaseSync`; built in, no native deps), zod (through
`@surgeonpulse/core` schemas), and `tsx` to run the TypeScript. Tests use Vitest with `app.inject()`.

## Configuration (environment)

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in containers |
| `DATA_DIR` | `./data` | Holds `surgeonpulse.sqlite`. Created on start with mode 0700 |
| `ADMIN_TOKEN` | — (**required**, ≥ 32 chars) | Researcher bearer token. The server refuses to start without one |
| `CORS_ORIGINS` | `` | Comma-separated allowed origins (e.g. the dashboard URL). Empty means no CORS |
| `MAX_UPLOAD_MB` | `25` | Fastify `bodyLimit` |
| `TRUST_PROXY` | `false` | Which `X-Forwarded-For` hops to trust for the client IP (rate limiting). `false`: none. `true`: only the reverse proxy directly in front of the server (the client is the right-most forwarded address). Or a comma-separated list of the proxies' IPs, CIDR ranges or presets (`loopback`, `linklocal`, `uniquelocal`); the client is the right-most forwarded address that isn't one of them. A client-supplied (left-most) address is never trusted |
| `ACCEPT_SIMULATED` | `false` | Store uploaded simulated/demo sessions (`sensor.source: 'simulated'`, or tagged `simulated`/`demo`). Off in production so synthetic data never enters the dataset; turn on only for a demo or test server |
| `LOG_LEVEL` | `info` | Never log request bodies or Authorization headers (configure redaction) |

## Modules (`src/`)

- `config.ts`: `loadConfig(env)` validates with zod and throws a readable error.
- `db.ts`: `openDatabase(file)`, WAL, `PRAGMA foreign_keys=ON`, and migrations with a `schema_version` table.
  Tables:
  - `participants(code TEXT PRIMARY KEY, profile TEXT JSON, created_at INTEGER, withdrawn_at INTEGER NULL)`
  - `enrolments(id TEXT PRIMARY KEY, participant_code TEXT REFERENCES participants(code) ON DELETE CASCADE, token_hash TEXT UNIQUE, label TEXT, created_at INTEGER, last_used_at INTEGER NULL, revoked_at INTEGER NULL)`
  - `sessions(id TEXT PRIMARY KEY, participant_code TEXT REFERENCES participants(code) ON DELETE CASCADE, started_at INTEGER, ended_at INTEGER, procedure_name TEXT, specialty TEXT, body TEXT JSON, sha256 TEXT, summary TEXT JSON, received_at INTEGER, updated_at INTEGER)`
  - Stored summaries carry core's `analyticsVersion`. At start-up (`buildApp`), every summary whose `analyticsVersion` differs from the current `ANALYTICS_VERSION` (or is missing) is recomputed from the stored de-identified body (`summarizeSession(parseSession(body))`); body and sha256 are unchanged, and one `summaries.recompute` audit row records the counts. So `summaries.csv` and `GET /sessions` never mix analytics definitions.
  - `audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT)`
  - `server_secrets(name TEXT PRIMARY KEY, value TEXT, created_at INTEGER)` (migration 2): the random key for export
    date shifts. Never returned by the API.
  - `secure_delete=ON`, and after every erasure (withdrawal, `DELETE /sessions/:id`) the server runs
    `PRAGMA wal_checkpoint(TRUNCATE)` so the deleted rows don't survive in the `-wal` file while it runs.
- `repo.ts`: typed data access (prepared statements). All writes go in transactions (`BEGIN IMMEDIATE`/`COMMIT`).
- `auth.ts`: `requireAdmin` and `requireEnrolment` preHandlers. Bearer token parsing. The admin token is compared
  with `crypto.timingSafeEqual` over SHA-256 digests (equal length). Enrolment tokens are 32 random bytes in
  base64url, prefixed `spk_`, stored only as SHA-256 hex, and checked with a lookup by hash. Revoked tokens and
  tokens of withdrawn participants are rejected. Failures return 401 with a uniform body (`{ error: 'unauthorized' }`)
  and don't reveal which check failed.
- `rateLimit.ts`: a simple in-memory token bucket per (IP, route group). Uploads get 30/min and auth failures 10/min.
  Responds 429 with `Retry-After`.
- `routes/*.ts` and `app.ts`: `buildApp(config, { db? }) → FastifyInstance` (exported for tests). `main.ts` starts
  the app and handles SIGINT/SIGTERM for a graceful close.

## API (JSON, `/api/v1`)

| Method & path | Auth | Behaviour |
| --- | --- | --- |
| `GET /health` | none | `{ status: 'ok', version }` |
| `POST /api/v1/admin/participants` | admin | body `{ code, profile? }` → create or update the participant. Validates with `isValidParticipantCode`. Codes are stored in upper case and matched case-insensitively everywhere (`sp-014` = `SP-014`). 201/200 |
| `GET /api/v1/admin/participants` | admin | List with session counts, enrolment counts, withdrawn flag |
| `POST /api/v1/admin/enrolments` | admin | body `{ participantCode, label? }` → `{ id, token }`. The token is shown **once**. Creates the participant if missing |
| `GET /api/v1/admin/enrolments` | admin | List (never includes tokens or hashes) |
| `DELETE /api/v1/admin/enrolments/:id` | admin | Revoke (sets revoked_at). 204 |
| `POST /api/v1/sessions` | enrolment | body: anything `parseImport` accepts (ExportBundle, a session, or an array). Every session must have `participantCode` equal (case-insensitively) to the token's participant, or it's rejected with a reason; it is stored under the enrolment's code. Simulated/demo sessions are rejected (`simulated or demo data is not accepted by this server`) unless `ACCEPT_SIMULATED=true`. Session and event ids must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` (no free text, always addressable by `/sessions/:id`), else the session is rejected. If the bundle's profile for the participant has `consent.withdrawnAt`, the whole upload is refused with `409 { error: 'consent withdrawn' }`. Each accepted session is **de-identified server-side again** (`deidentifySession` with defaults, plus: a specialty that isn't one of core's `PROCEDURE_SPECIALTIES` and a `sensor.location` that isn't a Body Sensor Location value are dropped; defence in depth), summarised with `summarizeSession`, and upserted by id. If the sha256 of the canonical JSON is unchanged, report `unchanged` (but when the stored summary's `analyticsVersion` differs from core's `ANALYTICS_VERSION`, replace the stored summary with the fresh one). A participant profile in the bundle that matches the token's code updates the stored profile (code is immutable). Returns `200 { accepted: [{id, status:'created'|'updated'|'unchanged'}], rejected: [{index, id?, reason}] }`. An empty or unparseable body → 400 |
| `GET /api/v1/me` | enrolment | `{ participantCode, sessionCount, lastUploadAt }`, so the app can confirm enrolment |
| `POST /api/v1/me/withdraw` | enrolment | Participant-initiated withdrawal: deletes all their sessions, marks the participant withdrawn, and revokes all their enrolments. 200 `{ deletedSessions }` |
| `GET /api/v1/sessions` | admin | Query: `participant`, `from`, `to` (epoch ms on started_at), `specialty`, `limit` (≤ 1000, default 200), `offset`. Returns `{ items: [{ id, participantCode, startedAt, endedAt, procedureName, specialty, receivedAt, summary }], total }` |
| `GET /api/v1/sessions/:id` | admin | Full session JSON. 404 if missing |
| `DELETE /api/v1/sessions/:id` | admin | 204 |
| `GET /api/v1/export` | admin | Same filters as the list → `ExportBundle` (deidentified: true, includes participants) as an attachment. Real dates by default; `shiftDates=true` moves each participant's timestamps (sessions, consent) by a secret, consistent whole-week shift in ±1–52 weeks (HMAC of the code with `server_secrets`), and `exportedAt` becomes the latest shifted session end |
| `GET /api/v1/export/summaries.csv` | admin | `summariesToCsv` for the filtered sessions, `text/csv` attachment (includes `sensor_source`, `simulated`, `tz_offset_min`, `started_local`, covariates and `analytics_version`). `shiftDates=true` applies the same per-participant shifts |
| `DELETE /api/v1/admin/participants/:code` | admin | Researcher-actioned withdrawal (same effect as self-withdraw). 204 |
| `GET /api/v1/admin/audit` | admin | Latest 500 audit rows |

Every mutating call writes an audit row: actor `admin`, or `participant:<code>`, plus the action and target. Errors
use the uniform shape `{ error: string, details?: string[] }`. Unknown routes return 404 JSON.

Security headers on all responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cache-Control: no-store` on API routes, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.

## Deliverables

- `src/*` as above, `test/*.test.ts` covering auth (missing/invalid/revoked token, admin vs enrolment separation,
  timing-safe compare path), upload (created/updated/unchanged, a participant mismatch is rejected, notes are stripped
  server-side, an oversize body gives 413, invalid JSON gives 400), list/filter/pagination, export bundle and CSV, both
  withdrawal paths cascade, rate limiting, audit rows, and config validation (missing ADMIN_TOKEN).
- A `Dockerfile` (node:22-alpine, non-root user, `VOLUME /data`, `HOST=0.0.0.0`), `.env.example`, and `README.md`
  (setup, curl examples for enrolling a participant and uploading, backup advice: copy the SQLite file while the server
  is stopped or use `sqlite3 .backup`, and hosting notes: run behind TLS on university infrastructure).
- `npm run typecheck` and `npm test` green.
