# SurgeonPulse research ingest server

A small, self-hostable API that collects **de-identified** surgical sessions from enrolled participants' phones and
serves them to researchers (through the dashboard or as JSON/CSV exports). It is built to run on
university-controlled infrastructure. It needs no third-party services, keeps everything in one SQLite file, and stores
no patient data.

> SurgeonPulse is a research tool, **not a medical device**. Participants are identified only by pseudonymous study
> codes (e.g. `SP-014`). Never put names, e-mail addresses, staff numbers or patient details in codes, labels or
> profiles.

- **Runs on Windows, macOS and Linux.** It needs Node.js only: SQLite is Node's built-in `node:sqlite`, so there are
  no native add-ons to compile and no build tools to install. A Dockerfile is included (it builds for amd64 and
  arm64); no image is built or published for you, and CI does not build it.
- **Serves every SurgeonPulse client.** The iOS and Android apps upload over HTTPS with an enrolment token. The app's
  web build and the research dashboard run in browsers and are allowed through CORS.

Contents: [Quick start](#quick-start) · [Configuration](#configuration) ·
[Enrol a participant and upload](#enrol-a-participant-and-upload) · [API](#api) ·
[Connecting the apps](#connecting-the-apps) · [Deployment](#deployment) · [Backups](#backups) ·
[Privacy and security](#privacy-and-security) · [Development](#development)

## Quick start

You need Node.js **22.13 or newer** (`node --version`). The repository's `.nvmrc` pins Node 22.

```bash
# From the repository root, once:
npm ci

cd apps/server
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
# Generate an admin token and paste it into .env as ADMIN_TOKEN=...
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm start                       # or, from the repository root: npm run server
```

The server listens on `http://127.0.0.1:8787` and creates `./data/surgeonpulse.sqlite`. Check it with
`curl http://127.0.0.1:8787/health`, which returns `{"status":"ok","version":"0.1.0"}`.

The `.env` file is read the same way on every OS, so you don't need shell-specific `VAR=value` syntax. Variables
already set in the environment take precedence over the file. The server **refuses to start** without an `ADMIN_TOKEN`
of at least 32 characters, and prints which setting is wrong.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `ADMIN_TOKEN` | (required) | Researcher bearer token, ≥ 32 characters and no spaces. Keep it in a secret store. To rotate it, change it and restart. |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in containers, or to reach the server from other devices. |
| `DATA_DIR` | `./data` | Holds `surgeonpulse.sqlite`. Created with mode 0700 on macOS and Linux. On Windows, put it in a folder that only the service account can read. A relative path is resolved from the directory the server starts in. |
| `CORS_ORIGINS` | (empty) | Comma-separated browser origins, e.g. `https://dashboard.example.ac.uk,http://localhost:5173`. Empty means no CORS. `*` is not allowed. |
| `MAX_UPLOAD_MB` | `25` | Largest request body. Bigger uploads get `413`. The mobile app splits uploads to stay below it. |
| `TRUST_PROXY` | `false` | Which reverse proxies may set `X-Forwarded-For` (used for rate limiting and logs). `false`: none, the client is the connecting address. `true`: trust exactly the one proxy directly in front of the server, so the client is the right-most `X-Forwarded-For` entry. Or a comma-separated list of proxy IP addresses, CIDR ranges and the presets `loopback`, `linklocal`, `uniquelocal`, e.g. `127.0.0.1,10.0.0.0/8`. Anything else stops the server at start-up. |
| `ACCEPT_SIMULATED` | `false` | `true` also accepts simulated and demo sessions (sensor source `simulated`, or a `simulated`/`demo` tag). Leave it `false` on a study server so the exports contain real recordings only; set it to `true` for a local test server fed by `npm run simulate`. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Request bodies and `Authorization` headers are never logged. |

## Enrol a participant and upload

The steps are: a researcher creates an enrolment, the participant enters the server URL and token in the app, and the
app uploads.

### bash / zsh (macOS, Linux, WSL, Git Bash)

```bash
export SP_URL=http://127.0.0.1:8787
export ADMIN_TOKEN='paste-the-admin-token'

# 1. Researcher: enrol participant SP-014. This also creates the participant.
#    The token appears in this response only, so hand it to the participant.
curl -s -X POST "$SP_URL/api/v1/admin/enrolments" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"participantCode":"SP-014","label":"study iPhone"}'
# → {"id":"…","token":"spk_…","participantCode":"SP-014","label":"study iPhone","createdAt":…}
export SP_TOKEN='spk_paste-the-enrolment-token'

# 2. Phone: confirm the enrolment.
curl -s "$SP_URL/api/v1/me" -H "Authorization: Bearer $SP_TOKEN"
# → {"participantCode":"SP-014","sessionCount":0,"lastUploadAt":null}

# 3. Phone: upload an export from the app, or a simulated bundle for testing.
#    Simulated sessions are rejected ("simulated or demo data is not accepted by this server")
#    unless the server runs with ACCEPT_SIMULATED=true, which is for test servers only.
npm run simulate -- SP-014 bundle.json
curl -s -X POST "$SP_URL/api/v1/sessions" \
  -H "Authorization: Bearer $SP_TOKEN" -H "Content-Type: application/json" --data-binary @bundle.json
# → {"accepted":[{"id":"…","status":"created"},…],"rejected":[]}
# Uploading the same file again reports "unchanged". Edited sessions report "updated".

# 4. Researcher: list, then export (-OJ saves the file under the server-provided name).
curl -s "$SP_URL/api/v1/sessions?participant=SP-014&limit=10" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -OJ "$SP_URL/api/v1/export/summaries.csv" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -OJ "$SP_URL/api/v1/export" -H "Authorization: Bearer $ADMIN_TOKEN"

# 5. Withdrawal: the participant (from the app), or the researcher on their behalf.
curl -s -X POST "$SP_URL/api/v1/me/withdraw" -H "Authorization: Bearer $SP_TOKEN"
curl -s -X DELETE "$SP_URL/api/v1/admin/participants/SP-014" -H "Authorization: Bearer $ADMIN_TOKEN"
```

### PowerShell (Windows PowerShell 5.1 and PowerShell 7 on any OS)

In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` for the commands above, or use
the native cmdlets:

```powershell
$Url   = 'http://127.0.0.1:8787'
$Admin = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }

$enrolment = Invoke-RestMethod -Method Post "$Url/api/v1/admin/enrolments" -Headers $Admin `
  -ContentType 'application/json' -Body (@{ participantCode = 'SP-014'; label = 'study iPhone' } | ConvertTo-Json)
$Phone = @{ Authorization = "Bearer $($enrolment.token)" }

Invoke-RestMethod "$Url/api/v1/me" -Headers $Phone
npm run simulate -- SP-014 bundle.json      # writes UTF-8 directly (PowerShell 5.1's ">" would write UTF-16)
Invoke-RestMethod -Method Post "$Url/api/v1/sessions" -Headers $Phone -ContentType 'application/json' -InFile bundle.json
Invoke-RestMethod "$Url/api/v1/sessions?participant=SP-014" -Headers $Admin
Invoke-WebRequest "$Url/api/v1/export/summaries.csv" -Headers $Admin -OutFile summaries.csv
Invoke-RestMethod -Method Post "$Url/api/v1/me/withdraw" -Headers $Phone
```

## API

All API routes are under `/api/v1`. Responses are JSON. Errors are `{ "error": string, "details"?: string[] }`, and
unknown routes return `404 {"error":"not found"}`. Authentication uses `Authorization: Bearer <token>`. Every
authentication failure returns the same `401 {"error":"unauthorized"}`, which doesn't say which check failed.

| Method & path | Auth | Behaviour |
| --- | --- | --- |
| `GET /health` | none | `{ status: 'ok', version }`. Returns 503 if the database doesn't answer. |
| `POST /api/v1/admin/participants` | admin | `{ code, profile? }` creates the participant (201) or replaces their profile (200). The code must pass core's `isValidParticipantCode` and can't be an e-mail-like string. Codes are stored in upper case (`sp-014` becomes `SP-014`) and matched case-insensitively everywhere. A withdrawn code returns 409. |
| `GET /api/v1/admin/participants` | admin | `{ items }`, each with `profile`, `withdrawn`, `sessionCount`, `enrolmentCount`, `activeEnrolmentCount` and `lastUploadAt`. |
| `DELETE /api/v1/admin/participants/:code` | admin | Researcher-actioned withdrawal (same effect as self-withdrawal). 204, or 404 if the code is unknown. |
| `POST /api/v1/admin/enrolments` | admin | `{ participantCode, label? }` returns 201 `{ id, token, participantCode, label, createdAt }`. The token is shown **once**. Creates the participant if missing. |
| `GET /api/v1/admin/enrolments` | admin | `{ items }`. Never includes tokens or hashes. |
| `DELETE /api/v1/admin/enrolments/:id` | admin | Revokes the enrolment. 204. |
| `GET /api/v1/admin/audit` | admin | The latest 500 audit rows, newest first. |
| `POST /api/v1/sessions` | enrolment | Accepts an `ExportBundle`, a session, or an array of sessions (anything core's `parseImport` accepts). Returns `200 { accepted: [{id, status}], rejected: [{index, id?, reason}] }`, where `status` is `created`, `updated` or `unchanged`. An empty or unparseable body returns 400. A bundle whose profile for this participant records withdrawn consent (`consent.withdrawnAt`) returns `409 {"error":"consent withdrawn"}` and stores nothing. |
| `GET /api/v1/me` | enrolment | `{ participantCode, sessionCount, lastUploadAt }` |
| `POST /api/v1/me/withdraw` | enrolment | Deletes all of the participant's sessions, marks them withdrawn and revokes all their tokens. Returns `200 { deletedSessions }`. |
| `GET /api/v1/sessions` | admin | Filters: `participant`, `from`/`to` (epoch ms on `startedAt`; `from` is inclusive, `to` exclusive), `specialty` (case-insensitive), `limit` (1–1000, default 200) and `offset`. Returns `{ items: [{ id, participantCode, startedAt, endedAt, procedureName, specialty, receivedAt, summary }], total }` in start order. |
| `GET /api/v1/sessions/:id` | admin | The full de-identified session JSON, or 404. |
| `DELETE /api/v1/sessions/:id` | admin | 204, or 404. |
| `GET /api/v1/export` | admin | Same filters (no limit by default). Returns a de-identified `ExportBundle` with participant profiles as a `.json` attachment. Timestamps are real unless you add `shiftDates=true` (see below). |
| `GET /api/v1/export/summaries.csv` | admin | Core's `summariesToCsv` output (one wide row per session for R, SPSS, Stata or pandas) as a `.csv` attachment. Also accepts `shiftDates=true`. |

**Date-shifted exports.** `?shiftDates=true` on either export moves every timestamp of a participant by the same
secret number of whole weeks (between 1 and 52, earlier or later), derived with HMAC-SHA256 from the participant code
and a random key that the server creates in its database on first use. Weekday, time of day and every interval are
kept, so circadian and rota analyses still work, but calendar dates can't be matched to theatre lists. A participant
gets the same shift in every export, the shift is never returned or written to the audit log, and `exportedAt` becomes
the latest shifted session end. Use it for files that leave the research team; the unshifted export is for the team's
own dashboard.

Upload rules, enforced server-side whatever the client does:

- Every session's `participantCode` must equal the token's participant (compared case-insensitively; the session is
  stored under the enrolment's spelling). Otherwise it is rejected with a reason.
- Simulated and demo sessions are rejected with "simulated or demo data is not accepted by this server" unless
  `ACCEPT_SIMULATED=true`.
- Session and event ids must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`, so an id can't carry free text and every
  stored session is reachable at `/api/v1/sessions/:id`. Other ids are rejected with a reason.
- Each session is **de-identified again** with core's `deidentifySession` defaults. That removes event notes, post-op
  notes and the sensor id, and replaces a procedure name that is not in the catalogue with `Unspecified procedure`.
  The server also keeps a specialty (in the procedure, the participant snapshot and the bundle profile) only if it is
  one of core's catalogue specialties, and `sensor.location` only if it is a standard Bluetooth body-sensor location.
- The server then summarises each session with core's `summarizeSession` and stores it under its id. A SHA-256 of the
  canonical JSON (sorted keys) detects `unchanged` re-uploads. A session id that belongs to another participant is
  rejected.
- If the bundle contains the token's participant profile, it replaces the stored profile. The code itself can't
  change.
- Summaries are stored with core's `analyticsVersion`. When the server starts after an upgrade that changed the
  analytics, it recomputes every stored summary from an older version (and writes an audit row); a re-upload of an
  unchanged session also refreshes an outdated summary.

Rate limits apply per client IP: 30 uploads per minute, and 10 authentication failures per minute. After that, the
server returns `429` with a `Retry-After` header in seconds. Phones behind one hospital NAT share these buckets, and
while an address is locked out after authentication failures, requests with a valid token from that address wait too.

## Connecting the apps

- **iOS and Android apps.** In the app, go to Settings › Research study and enter the server URL and the enrolment
  token. Use **HTTPS** in production. iOS App Transport Security and Android (since version 9) block plain HTTP, and
  the app only accepts `http://` for local development addresses. For development:
  - The **Android emulator** reaches your computer at `http://10.0.2.2:8787`.
  - The **iOS simulator** uses `http://127.0.0.1:8787`.
  - A **physical phone** on the same Wi-Fi needs `HOST=0.0.0.0` and your computer's LAN address. Use this on a
    trusted test network only.
- **Browsers (the app's web build and the dashboard).** Add their origins to `CORS_ORIGINS`. In development these are
  `http://localhost:8081` for Expo web and `http://localhost:5173` for the Vite dashboard. A page served over HTTPS
  can only call an HTTPS server.
- **Dashboard.** On the Data page, under Research server, enter the URL and the admin token. The dashboard loads
  `GET /api/v1/export`.

## Deployment

### Docker (Linux, or Docker Desktop on Windows and macOS)

Build from the **repository root**, because the server bundles the `packages/core` workspace:

```bash
docker build -f apps/server/Dockerfile -t surgeonpulse-server .
docker run -d --name surgeonpulse --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" -e CORS_ORIGINS=https://dashboard.example.ac.uk \
  -v surgeonpulse-data:/data \
  surgeonpulse-server
```

The image is based on `node:22-alpine`. It runs as the unprivileged `node` user (uid 1000) with `HOST=0.0.0.0`, stores
data in `VOLUME /data` with mode 0700, includes a `HEALTHCHECK` and stops gracefully on `SIGTERM`. Esbuild bundles the
server ahead of time, so the runtime image contains no `node_modules` and no compilers. To build for several
architectures, use
`docker buildx build --platform linux/amd64,linux/arm64 …`.

Use a **named volume**, as shown above. On Docker Desktop for Windows and macOS, bind mounts go through a file-sharing
layer where SQLite's WAL locking is unreliable. On a Linux host, a bind mount is fine if uid 1000 can write to it
(`sudo chown 1000:1000 /srv/surgeonpulse && sudo chmod 700 /srv/surgeonpulse`).

### Plain Node (any OS)

```bash
npm run build -w @surgeonpulse/server      # writes apps/server/dist (self-contained, no node_modules needed)
cd apps/server && node dist/main.js        # or: npm run start:dist
```

Copy `apps/server/dist` and `apps/server/package.json` to the server and run `node dist/main.js` under a service
manager:

- **Linux:** systemd. Use `Restart=on-failure`, `User=surgeonpulse`, `EnvironmentFile=/etc/surgeonpulse.env`,
  `WorkingDirectory=/opt/surgeonpulse`.
- **Windows:** a Windows service, e.g. with NSSM, or a Task Scheduler task "at startup". The server stops cleanly on
  Ctrl+C, Ctrl+Break and console close.
- **macOS:** launchd.

`npm start` (tsx) also works and is handy for development.

### TLS and hosting notes

- **Always put the server behind TLS.** Use a reverse proxy on university infrastructure (Caddy, nginx, Apache or IIS
  ARR) with an institutional certificate. Keep `HOST=127.0.0.1` so that only the proxy can reach the server, and set
  `TRUST_PROXY=true` (trust only the proxy directly in front) so that rate limiting sees real client addresses. If
  requests pass through more than one proxy (e.g. a load balancer and then nginx), list their addresses instead, e.g.
  `TRUST_PROXY=127.0.0.1,10.0.0.0/8`.
- **Allow large enough requests at the proxy.** Set the proxy's body limit to at least `MAX_UPLOAD_MB`, e.g. nginx
  `client_max_body_size 25m;`. Caddy has no limit by default.
- Caddy example: `surgeonpulse.example.ac.uk { reverse_proxy 127.0.0.1:8787 }`.
- Host on university-managed servers with encrypted disks, inside the institution's data-governance arrangements for
  your ethics approval. The server makes **no outbound connections**.
- Consider restricting `/api/v1/admin/*` and `/api/v1/export*` to the university network or VPN at the proxy.
  Participants' phones only need `/api/v1/sessions` (POST) and `/api/v1/me*`.
- Run one instance per database file. The rate-limit state is in memory, and SQLite expects a single writer process.

## Backups

The database is the single file `DATA_DIR/surgeonpulse.sqlite`. The server runs it in WAL mode, so **don't copy the
file while the server is running**. Use one of these methods:

- **Server stopped:** copy `surgeonpulse.sqlite`. A clean shutdown leaves no `-wal` or `-shm` files. If they exist,
  copy them too.
- **Server running:** `sqlite3 data/surgeonpulse.sqlite ".backup 'surgeonpulse-backup.sqlite'"`.
- **Server running, no `sqlite3` CLI needed (Windows, containers):** `npm run backup -- path/to/backup.sqlite`. The
  default path is `DATA_DIR/backups/surgeonpulse-<UTC time>.sqlite`. In Docker, run
  `docker exec surgeonpulse node dist/backup.js /data/backups/manual.sqlite`.

Backups contain research data. Store them encrypted, with the same access controls as the server, keep them only as
long as your ethics approval allows, and test restores. To restore, stop the server, replace the file, delete any
`-wal`/`-shm` files, then start the server.

## Privacy and security

- **What is stored.** The server stores de-identified sessions (heart rate, RR intervals, phase and marker events
  without notes, procedure metadata, and the post-op questionnaire without free text) and their summaries. It also
  stores participant profiles with fields such as training level and birth year, enrolments (only a SHA-256 of each
  token), and an audit log.
- **Enrolment tokens** are `spk_` followed by 32 random bytes in base64url. They are shown once, and only their
  SHA-256 is stored. Revoked tokens, and tokens of withdrawn participants, stop working immediately.
- **The admin token** is compared in constant time over SHA-256 digests.
- **Withdrawal**, whether by the participant or by the researcher, deletes all of that participant's sessions, revokes
  every token, clears the profile back to the bare code, and retires the code: it can't be re-enrolled, so use a new
  code if the participant re-consents. The audit log keeps the code, the action and the counts. The database runs with
  SQLite `secure_delete`, so deleted data is overwritten rather than left recoverable in the file. `secure_delete`
  does not reach the write-ahead log, so after each withdrawal and each `DELETE /api/v1/sessions/:id` the server also
  checkpoints and truncates the WAL (`PRAGMA wal_checkpoint(TRUNCATE)`; best effort, retried at the next erasure or
  shutdown if another connection is busy). Backups taken before the withdrawal still contain the data, so handle them
  as your protocol requires.
- **The audit log** records every change (actor `admin` or `participant:<code>`, the action and the target) and every
  export. It never records health data or secrets.
- **Logging.** Request bodies are never logged, and `Authorization`/`Cookie` headers are redacted. Errors never echo
  request content into logs.
- **Response headers.** Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and
  `X-Frame-Options: DENY`. CORS is off unless `CORS_ORIGINS` lists exact origins.
- **Request parsing.** The admin JSON routes use Fastify's secure JSON parser, which rejects prototype-poisoning keys
  (`__proto__`, `constructor.prototype`). The upload route hands the raw body to core's `parseImport`, whose zod
  schemas keep only known fields, so such keys never reach the stored session.

## Development

```bash
cd apps/server
npm test            # Vitest: app.inject() against a temp DATA_DIR per test (CI runs it on Linux, Windows and macOS)
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle in dist/
npm run dev         # restart on change
```

From the repository root, run `npm test -w @surgeonpulse/server` and `npm run typecheck -w @surgeonpulse/server`.

Source layout (`src/`):

| File | Contents |
| --- | --- |
| `config.ts` | `loadConfig(env)`: zod validation with readable errors |
| `db.ts` | `openDatabase(file)`: WAL, foreign keys, migrations (`schema_version`), the `transaction()` helper |
| `repo.ts` | Typed data access with prepared statements |
| `auth.ts` | Bearer parsing, admin and enrolment token checks, `requireAdmin`/`requireEnrolment` hooks |
| `rateLimit.ts` | Token bucket per (IP, group) and 429 handling |
| `http.ts` | Uniform errors, JSON 404, security headers, JSON parser |
| `services/ingest.ts` | Upload pipeline: `parseImport`, then `deidentifySession`, then `summarizeSession`, then the sha256 upsert |
| `services/participants.ts` | Participants, enrolments, withdrawal (each one transaction plus an audit row) |
| `services/recompute.ts` | Recomputes stored summaries from an older `analyticsVersion` at start-up |
| `dateShift.ts` | Per-participant secret date shift for `?shiftDates=true` exports |
| `routes/*.ts`, `app.ts` | `buildApp(config, { db? })`, exported for tests |
| `main.ts` | Entry point with graceful shutdown |
| `backup.ts` | `npm run backup` |

`node:sqlite` is still flagged experimental in Node 22, so Node prints an `ExperimentalWarning` when it loads.
`main.ts` filters out that single warning (see `src/warnings.ts`), and every other warning is still printed.

All analytics, parsing and de-identification come from `@surgeonpulse/core`. The server never re-implements them.
