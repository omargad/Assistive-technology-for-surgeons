# SurgeonPulse mobile app — architecture & build spec

Expo SDK 58 / React Native 0.88 / React 19 / Expo Router. One codebase targets
**iOS, Android and the web**. The web build is used for demos, browser-based
recording via Web Bluetooth, and automated UI tests.

Read `AGENTS.md` in this folder first. Expo changes between SDK releases, so when you're unsure about an
Expo/RN API, check the installed package's type definitions in
`/home/user/Assistive-technology-for-surgeons/node_modules/<pkg>` and the versioned docs at
`https://docs.expo.dev/versions/v58.0.0/`. Don't rely on memory.

## Users & context of use

- **Surgeon (participant):** consultant or trainee. They're sterile during the case and **can't touch the phone**, so:
  - A circulating nurse, an anaesthetist or a researcher may tap phase/event buttons. The `loggedBy` field records
    `self` vs `team`, and a toggle on the live screen sets who is logging.
  - The phone sits on a stand, often for 1–5 hours, sometimes plugged in. The screen stays awake (`expo-keep-awake`)
    while recording.
  - Laparoscopic/robotic theatres are dark, so the live screen uses a dark, low-glare "OR mode".
  - Big touch targets: ≥ 64 pt for phase/event buttons, readable from 1–2 m (HR digits ≥ 96 pt).
  - After the case, the surgeon completes a 1–2 minute debrief (SURG-TLX plus a few items) and can correct event
    times retrospectively.
- **Researcher:** enrols participants (enrolment token + participant code), exports or uploads de-identified data,
  and uses the web dashboard (`apps/dashboard`) for cohort analysis.
- Not a medical device. It doesn't diagnose and doesn't alert on patient safety. Show this disclaimer in About and
  onboarding.

## Directory layout (`src/`)

```
src/
  app/                          # Expo Router routes ONLY
    _layout.tsx                 # Root Stack, providers, bootstraps stores, onboarding gate, interrupted-session recovery prompt
    onboarding.tsx              # welcome → study info & consent (version from app.json extra.consentVersion) → participant code → profile
    (tabs)/_layout.tsx          # Tabs: Record (index), History, Insights, Settings
    (tabs)/index.tsx            # Record home: start new case, sensor readiness, last session card
    (tabs)/history.tsx          # Session list (summary chips), search/filter by procedure
    (tabs)/insights.tsx         # generateInsights cards + trend charts + by-procedure comparison; empty state with "Load demo data"
    (tabs)/settings.tsx         # profile, recording prefs, sensors, data (export/import/delete/demo), research upload, privacy/consent, about
    record/setup.tsx            # procedure (catalogue picker + custom), role/approach/urgency/complexity, sensor choice + connect
    record/baseline.tsx         # resting baseline countdown (default 3 min, adjustable 1–5) with live HR; skip allowed
    record/live.tsx             # OR mode live screen
    record/debrief.tsx          # post-op SURG-TLX (6 sliders 0–100 step 5) + optional pairwise weighting + performance, perceived stress, sleep, caffeine, outcome, notes
    session/[id].tsx            # Session detail dashboard
    session/events/[id].tsx     # Retrospective event editor (adjust times, add/remove phases/markers on a timeline)
    sensors.tsx                 # Modal: scan / choose device; Web Bluetooth chooser on web
    about.tsx                   # About, disclaimer, licences, data handling summary
  components/                   # UI primitives & composite components (owned by UI agent)
  components/charts/            # react-native-svg charts (owned by UI agent)
  theme/                        # tokens, light/dark/OR palettes, useTheme (owned by UI agent)
  hooks/                        # UI hooks (owned by UI agent) e.g. useElapsed, useSessionSummary
  services/                     # (owned by services agent)
    sensors/types.ts            # CONTRACT (do not edit)
    sensors/ble.native.ts       # react-native-ble-plx implementation
    sensors/ble.web.ts          # Web Bluetooth implementation
    sensors/ble.ts              # fallback (unsupported) — resolution order: .native/.web/.ts
    sensors/simulated.ts        # createLiveSimulator-based source (1 Hz ticks via setInterval)
    sensors/registry.ts         # getSource(choice): HeartRateSource; availableSources(): Promise<{choice, label, supported, live}[]>
    health/types.ts             # CONTRACT (do not edit)
    health/index.ts             # unsupported fallback (web)
    health/index.ios.ts         # @kingstinct/react-native-healthkit
    health/index.android.ts     # react-native-health-connect
    storage/types.ts            # CONTRACT (do not edit)
    storage/sqlite.ts           # expo-sqlite implementation
    storage/memory.ts           # in-memory (+ optional localStorage persistence)
    storage/index.ts            # export const repository: SessionRepository (memory+localStorage on web, sqlite on native) — use index.web.ts / index.ts split
    export/share.ts             # shareBundle(sessions, {deidentify}) & shareCsv(session) — native: expo-file-system + expo-sharing; web: Blob download
    upload/research.ts          # uploadSessions(sessions, {url, token}) → POST {url}/api/v1/sessions with ExportBundle (deidentified) — see apps/server/SPEC.md
    platform.ts                 # currentPlatform(): Platform; appInfo(): AppInfo; tzOffsetMin(t)
  state/
    types.ts                    # CONTRACT (do not edit)
    recording.ts                # export const useRecording = create<RecordingStore>(…) (zustand)
    settings.ts                 # export const useSettings = create<SettingsStore>(…)
    sessions.ts                 # export const useSessions = create<SessionsStore>(…)
```

Path alias: `@/` → `src/` (tsconfig `paths`). Core library: `import { … } from '@surgeonpulse/core'`.

## Services & state (services agent)

- **Recording store** (`state/recording.ts`) implements `RecordingStore` from `state/types.ts`:
  - Keeps the live session in memory. Every 5 s it flushes newly ingested samples/RR to
    `repository.appendSignals` (track a flushed index). Events and other metadata changes go to `updateMeta`
    immediately.
  - `ingest` updates `currentBpm`, appends to the session (or to a baseline buffer during `baseline`), and ignores data
    when idle.
  - `markPhase` and `addMarker` create events with `createId()`, `t = Date.now()`, and `loggedBy` taken from a
    `logger` field ('self'|'team'; add `setLogger`). They forward to `source.onPhase/onMarker` (simulator),
    set `lastEvent`, and trigger haptics if enabled. The first `markPhase` when no phase exists yet is allowed at any
    time. Phase order isn't enforced: real cases loop.
  - `endRecording` performs a final flush and sets `endedAt` and status `completed` only after the debrief. Until
    then, status stays `recording`. `submitDebrief` first retries the flush and rejects (stage stays `debrief`, the
    UI shows the error and the user can save again) while any captured sample or RR interval is still only in
    memory, so the cached summary always matches the stored signals. It then computes `summarizeSession` with the
    profile, caches it via `saveSummary`, and triggers an auto-upload when enabled. `reset()` flushes in the
    `recording` and `debrief` stages.
  - `ingest` drops values that the core session schema would reject (bpm outside 0–300, RR outside 0–5000 ms;
    `services/util/signals.ts`), for the session and the baseline buffer: one glitching notification (a uint16
    heart rate, an RR > 5 s) must never make a session unreadable. The storage implementations skip such values
    when reading back data written by older versions.
  - `undoLastEvent` works only within `UNDO_WINDOW_MS` (10 s, plus a short grace) of the event; the live screen's
    snackbar shows only the remaining part of that window.
  - App lifecycle (`subscribeAppState`, React Native `AppState`): while recording, leaving the foreground flushes
    at once (and `persistNow` writes the web repository to `localStorage`); returning re-checks the signal at once.
    **Android has no foreground service yet**: JS timers stop while the app is in the background or the screen is
    locked, so the setup screen, the keep-awake setting and the live screen (after a return from the background)
    tell the team to keep the app open with the screen on.
  - `activeSessionOf(state)` names the session the flow owns (recording, debrief, or a resumed interrupted case).
    That session cannot be deleted (`useSessions.deleteSession` / `deleteAll` reject with
    `CASE_IN_PROGRESS_ERROR`, wired through `state/activeSession.ts`; `removeDemoData` skips it), is never replaced
    by an import, and its session detail hides "Edit events" and "Delete"; the event editor refuses it.
  - Sensor status transitions update `sensorStatus`. A long dropout (> 15 s without data while recording) sets a
    warning status for the UI. Data gaps are fine: analytics handles gaps.
  - The participant snapshot comes from the profile, and `tzOffsetMin` comes from `-new Date().getTimezoneOffset()`.
  - Keep-awake: activate (`expo-keep-awake` `activateKeepAwakeAsync('recording')`) during baseline/recording when the
    setting is on, and deactivate on end/abort. On the web the browser releases the Screen Wake Lock whenever the
    page is hidden, so the controller requests it again on every `visibilitychange` to visible while active.
- **BLE native** (`ble.native.ts`): a single `BleManager` for the whole app (lazy). Scanning filters on
  `HEART_RATE_SERVICE` unless `showAll`. Some straps don't advertise service UUIDs, so offer "Show all devices".
  Dedupe by id. On Android, request `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (API ≥ 31), or
  `ACCESS_FINE_LOCATION` (≤ 30), via `PermissionsAndroid`. Wait for the `PoweredOn` state (and report
  "Bluetooth is off"). On connect, call `discoverAllServicesAndCharacteristics`, read Body Sensor Location and Battery
  Level if present, then `monitorCharacteristicForService(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT)` →
  `base64ToBytes` → `parseHeartRateMeasurement` → sample `{t: Date.now(), bpm, contact}` + RR `{t, ms}` for each RR.
  Re-subscribe after reconnect. Auto-reconnect on unexpected disconnect with exponential back-off (1 s → 30 s cap)
  while started; while the adapter is off the reconnect status says "Bluetooth is off…". The cancellation /
  link-loss error a removed monitor reports (BleErrorCode 2, 201, 205) is not shown as an error. Re-read the
  battery level every 5 min while streaming (`BATTERY_REFRESH_MS`; Web Bluetooth too). Requested MTU isn't needed.
  Remove subscriptions on stop/disconnect. Never throw out of BLE callbacks.
- **Web Bluetooth** (`ble.web.ts`): `navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service'] })`.
  Subscribe to `characteristicvaluechanged` → parse the `DataView` bytes, and handle `gattserverdisconnected` with
  reconnect. `isSupported` = `!!navigator.bluetooth`. `canScan = false`.
- **Simulated** (`simulated.ts`): ticks `createLiveSimulator` every 1000 ms with `Date.now()`, implements
  `onPhase/onMarker`, and reports status `streaming` with deviceName "Simulator".
- **Health import**: on iOS, use `@kingstinct/react-native-healthkit` (read its installed `lib/typescript` d.ts for
  the v16 API: authorization + quantity samples for HeartRate and HeartRateVariabilitySDNN, plus heartbeat series
  where available). On Android, use `react-native-health-connect` (`initialize`, `requestPermission`,
  `readRecords('HeartRate' | 'HeartRateVariabilityRmssd', { timeRangeFilter: { operator: 'between', … } })`; read
  its installed types). Map records to `HeartRateSample` / `ExternalHrvReading`. The web fallback reports itself as
  unavailable. A session recorded with source `healthkit`/`health-connect` is a "timed session" (no live data): the
  live screen shows elapsed time and event buttons only, with a note that heart rate will be imported after the case.
  `endRecording` then offers the import, and the session detail has an "Import from Apple Health / Health Connect"
  action. The import merges samples into the session (`saveSession`) and recomputes the summary. It is offered and
  accepted only for timed sessions or sessions without any HR data (`canImportHealthInto`): a second device's
  samples and beats are never interleaved with a live sensor's series.
- **Storage (SQLite)**: open `surgeonpulse.db` with `openDatabaseAsync` and enable WAL. Schema version table and
  migrations. Tables: `sessions(id TEXT PK, meta TEXT JSON, started_at INTEGER, status TEXT, summary TEXT JSON NULL, updated_at INTEGER)`,
  `samples(session_id TEXT, t INTEGER, bpm REAL, contact INTEGER NULL)` with index `(session_id, t)`,
  `rr(session_id TEXT, seq INTEGER, t INTEGER, ms REAL)` with index `(session_id, seq)`, `profile(id INTEGER PK CHECK (id=1), json TEXT)`.
  Batch inserts inside `withExclusiveTransactionAsync` (or `withTransactionAsync`) using prepared statements.
  Deleting a session deletes its signals. `getSession` reassembles and validates via `parseSession` (rows outside
  the schema's signal limits are skipped). Every write transaction sets `PRAGMA secure_delete = ON` (expo-sqlite
  runs each exclusive transaction on a new connection, and the pragma is per connection). `deleteSession`,
  `deleteAll` and `deleteProfile` are followed, once committed and still inside the serial write queue, by
  `PRAGMA wal_checkpoint(TRUNCATE)` on the main connection, so deleted data does not stay in `surgeonpulse.db-wal`;
  a failed checkpoint is ignored (the delete has already committed). The web repository has no checkpoint.
- **Storage (web)**: `memory.ts` persists to `localStorage` within a ~4 M-character budget, leaving out signals of
  the oldest finished sessions first. A quota error leaves out one more session's signals per retry (an
  in-progress recording last) instead of every session's. Sessions stored without signals, and failed writes, are
  reported through `services/storage/warnings.ts`; History shows a banner asking the user to export before the
  page is closed (the data is still in memory). Settings' "Export all" / "Upload all" skip (and report) a session
  that cannot be read instead of failing the batch.
- **Import** (`useSessions.importBundle`): a session whose id is already on the device is skipped with a warning
  (an export is de-identified, so replacing the local copy would lose notes, custom procedure names and upload
  tags).
- **Settings**: persist JSON via `expo-sqlite/kv-store` on native and `localStorage` on web (wrapped in try/catch).
  The research token is part of `Settings` in memory but is **not** written to that document: it is kept through
  `services/secrets` (expo-secure-store, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, on native; its own `localStorage` key
  on the web), and a token found in an older document is moved there on load. Never in logs or exports.
- **Delete all data** (Settings) deletes every session (`repository.deleteAll`), the profile
  (`repository.deleteProfile`) and the study server address and token, then returns to onboarding. **Remove demo
  data** (Settings › Data, between "Load demo data" and "Delete all data", shown only while demo sessions exist,
  subtitle "N demo sessions; your own sessions are kept") confirms "Remove demo data?" (button "Remove"; a browser
  confirm on the web), then `useSessions.removeDemoData()` deletes only the sessions tagged `demo` (`DEMO_TAG`),
  one by one, skipping the session the recording flow owns, and returns the count for the toast "Removed N demo
  sessions". Own and imported sessions, simulator recordings, the profile and consent, and the settings are kept. The
  store refreshes its list even when a delete fails part-way. **Withdraw
  consent** records `consent.withdrawnAt` locally; when a server is configured it also offers
  `POST /api/v1/me/withdraw` (server deletes the participant's data and revokes the token), then forgets the token.
  No upload path (manual, per-session, automatic) sends anything once `consent.withdrawnAt` is set.
- **Backups**: `android.allowBackup` is `false`. iOS has no backup exclusion for the SQLite directory yet (see the
  privacy text in Settings).
- **Export**: the bundle JSON via `createExportBundle({ deidentify: true by default, now: Date.now() })`. The
  filename is `surgeonpulse-<code>-<yyyymmdd-hhmm>.json`. CSV export for a single session (samples/rr/events CSVs)
  and for all summaries. The summaries CSV takes the History list items, replaces each cached summary's procedure
  name/specialty with the de-identified values, and leaves out demo and simulator sessions (a participant's file
  should hold real cases only; the core CSV's `simulated` column would be 1 for them). Sessions whose participant code
  fails `isValidParticipantCode` are skipped (and reported) by every export and upload path (a single-session CSV
  refuses with a plain message), and skipped with a warning on import. Native: write to `Paths.cache` with the new
  `expo-file-system` API (`File`, `Paths`, `Directory`; read the installed types) and call `Sharing.shareAsync`; each
  export first deletes earlier `surgeonpulse-*` export files in the cache that are more than an hour old
  (`removeStaleExports`; not straight after sharing, because Android receivers read the file later), and the
  document picker's cached copy of an imported file is deleted once it has been read. Web: `Blob` + an anchor
  download.
- **Upload**: POST JSON with `Authorization: Bearer <token>`. Demo sessions, simulator sessions (`sensor.source:
  'simulated'` or tag `simulated`), sessions still recording and sessions with a non-study code are rejected locally.
  The server address must be `https://` (plain `http://` only for localhost/private/`.local` hosts) and its host may
  contain only letters, digits, `.` and `-`. Show a clear result: accepted/rejected counts, plus
  network errors. Retries are up to the user. Track uploaded session ids in session `tags` (`uploaded:<iso>`)
  to avoid duplicates (the server is idempotent anyway).
- **Tests** (jest-expo): recording store state machine with a fake source and the memory repository (flush batching,
  undo, baseline computation, debrief → summary cached); the memory repository; the BLE source with `react-native-ble-plx`
  mocked (parse path, reconnect back-off with fake timers); simulated source; export bundle naming; upload request
  shape (mock fetch).

## UI (UI agent)

- **Design language:** calm, clinical, high contrast. Use a theme with tokens for `light`, `dark` and `or`
  (near-black background, desaturated accents, large type), and follow the system scheme except on the live screen
  (OR mode when `settings.orModeDark`). Use the phase colours from core `PHASE_COLORS`. Respect safe areas. Support
  Dynamic Type (`allowFontScaling`) without breaking layout, and keep contrast at WCAG AA. Provide accessible labels and
  roles (`accessibilityRole`, `accessibilityLabel`, `accessibilityState`) on all controls. Layouts must work on
  phone portrait **and landscape/tablet**: the live screen in landscape puts HR on the left and controls on the right.
  The web build must look intentional too: center the content with a max width of about 720 px on wide screens.
- **Components:** `Screen` (safe area + scroll), `Card`, `Button` (primary/secondary/destructive/ghost), `BigButton`
  (live screen), `StatTile`, `Chip`, `SegmentedControl`, `Slider` (pure-JS, built from `PanResponder`/Pressable
  steps with no native slider dependency; accessible via `accessibilityActions` increment/decrement; on the web the
  track is a tab stop handling Arrow/PageUp/PageDown/Home/End; `value={null}` means unanswered: no thumb or fill, no
  `aria-valuenow`, and the first tap/drag/step records an answer even at the midpoint; optional `onClear`), `ListRow`,
  `EmptyState`, `Banner` (warning/info), `Toast`/undo snackbar, `ConfirmDialog` (uses `Alert` on native and
  `window.confirm` on web), `ProcedurePicker` (searchable catalogue grouped by specialty plus custom entry, with a
  warning not to enter patient identifiers), `SensorStatusPill`.
- **Charts** (react-native-svg, hand-rolled, no chart library):
  - `HrTimelineChart`: HR line (resampled with `resampleHr`; gaps break the line), translucent phase bands with
    labels, event marker ticks with glyphs, a baseline dashed line, an episode threshold line, a time axis
    (elapsed hh:mm) and a bpm axis. Supports a `height` prop and responsive width (onLayout). Tapping or dragging
    shows a crosshair readout of time, bpm and phase.
  - `Sparkline` for the live screen (last 10 min), `RollingHrvChart`, `ZoneBar` (stacked horizontal), `PhaseBars`
    (mean HR delta by phase), `TrendChart` (metric per session with a linear trend line, from `metricSeries` +
    `trendEvidence`), and `GroupBarChart` (aggregateMetric with mean ± sd whiskers).
  - Every chart has an `accessibilityLabel` summary (e.g. "Heart rate from 62 to 118 bpm; highest during critical phase").
- **Live screen** (`record/live.tsx`): big HR (zone-coloured) with a trend arrow, elapsed clock, current phase chip,
  sensor pill (battery, contact, status, "No RR" when the sensor sends no beat-to-beat intervals), and a signal-lost
  notice. Phase buttons are shown in PHASE_ORDER with the current one highlighted and the next one emphasised. Marker
  buttons have an optional quick note (hold; on the web also Shift+Enter). The undo bar lasts 10 s, and there's a
  "Logged by: Self / Team" toggle (≥ 44 pt, like every secondary control). Transient messages — the undo bar (with an
  "Undone: …" confirmation), hints and the signal-lost notice — appear in a fixed-height area of the HR panel (over
  the status line and sparkline), never over a button and without moving the controls. While the signal is lost the
  HR shows "--" with "No signal · last N bpm" and the pill says "No data". "End case" requires a long press (1.5 s)
  with a progress ring, because accidental taps happen; on the web, holding Space/Enter also completes it, and a key
  press or assistive-technology click asks "End the case now?" instead. Short phones (portrait < 740 pt high,
  landscape < 500 pt) use a denser layout so Complication is visible without scrolling at 360 × 640 and 844 × 390.
  `settings.showLiveHr` (default on) can hide the HR from the theatre team (it is still recorded). A timed session
  (health-store source) shows "HR will be imported after the case". Zone colours come from the session itself,
  exactly as the stored summary derives them: resting HR = `session.baseline`, else the recording store's baseline,
  else `participantSnapshot.restingHr`; max HR = core `sessionMaxHr(session)` (snapshot `maxHr`, else Tanaka from the
  snapshot `birthYear` at the UTC year of `startedAt`). Never the current profile or the local calendar year.
- **Debrief:** SURG-TLX ratings and the optional items start unanswered (no default). The score shows once all six
  SURG-TLX items are rated; saving with some unrated asks, and then saves the report without `workload` (never
  midpoint defaults).
- **Session detail:** a header (procedure, date, duration, role, approach), stat tiles (mean / peak HR, Δ vs
  baseline, RMSSD, stress index, episodes, workload), HrTimelineChart, RollingHrvChart, ZoneBar, a phase table,
  an episode list (with phase and related events), the post-op report, data quality (coverage %, gaps, artefact %),
  and actions (edit events, export JSON/CSV, import from Health, upload, delete).
- **Insights:** insight cards (kind-coloured with an icon), TrendChart for meanHrDelta / rmssd / workload with a
  metric switcher, and a by-procedure GroupBarChart. Copy is plain and non-judgemental, framed as reflection rather
  than evaluation. The TrendChart caption shows no R² or p-values: "Trend ±x unit per session over N sessions. This
  is unlikely to be chance." when `trendEvidence` is significant, else "No clear trend over N sessions (…). The
  changes could be ordinary variation." Only the participant's own cases count as "your" sessions: demo and simulator
  sessions are shown only as a separate, labelled view. With no own cases yet, its banner ("Simulated data — not
  your cases") says "These show what Insights looks like. Your own recorded cases replace them here once you complete
  one." plus, while demo-tagged sessions exist, "To delete the demo sessions, use Settings › Remove demo data."
  `generateInsights` gets `{ sessions }` (list metadata with events, no signals).
- **Sensors / setup:** a beat-to-beat line reports whether RR intervals are arriving (store `rrSeenAt`/`streamSince`).
- **Onboarding:** short and friendly. Consent is an explicit checkbox plus "I agree". The participant code is
  validated with `isValidParticipantCode`, with a hint like "Use the code from your research team, e.g. SP-014. Do not
  use your name.". Profile fields are optional.
- **Tests:** render tests for key components and screens with `@testing-library/react-native` (charts render with
  data and empty input, the slider responds to accessibility actions, live screen buttons call store actions with a
  mocked store).

## Quality bar

- `npx tsc --noEmit` is clean, `npx jest` is green (also `npx jest --preset jest-expo/android src/components
  __tests__/ui`), and `npx expo export --platform web` and `npx expo export --platform ios --platform android`
  succeed.
- `e2e/web-flow.mjs` passes against the exported web build served by `e2e/serve-spa.mjs`, with no console errors
  (CI job `mobile-web-e2e`).
- `npx expo config --type public` resolves, and `npx expo prebuild --no-install --clean` generates android/ and
  ios/ with the right permissions (then delete those folders, which are gitignored).
- Simulator mode is fully usable on web: onboarding → setup → baseline → live (with events) → debrief → session
  detail → insights.

## Module exports (contract between services and UI)

The UI imports **only** these names. The services agent must export exactly these names.

```ts
// '@/services/storage'
export const repository: SessionRepository;

// '@/services/sensors/registry'
export interface SourceOption { choice: SourceChoice; label: string; description: string; supported: boolean; live: boolean }
export function availableSources(): Promise<SourceOption[]>;          // ordered: ble | web-bluetooth, healthkit | health-connect, simulated
export function getSource(choice: SourceChoice): HeartRateSource;    // health-store choices return a no-op "timed" source (live=false)

// '@/services/health'
export const healthStore: HealthStore;

// '@/services/export/share'
export function shareBundle(sessions: SurgicalSession[], opts?: { deidentify?: boolean; profile?: ParticipantProfile | null }): Promise<{ exported: number; skipped: number }>;
export function shareSessionCsv(session: SurgicalSession, kind: 'samples' | 'rr' | 'events'): Promise<void>;
export function shareSummariesCsv(items: readonly SessionListItem[]): Promise<{ included: number; skipped: { demo: number; simulated: number; invalidCode: number; noSummary: number } }>;
export function pickImportFile(): Promise<string | null>;            // returns file text (expo-document-picker on native, <input type=file> on web)

// '@/services/upload/research'
export interface UploadResult { accepted: { id: string; status: 'created' | 'updated' | 'unchanged' }[]; rejected: { index: number; id?: string; reason: string }[] }
export function uploadSessions(sessions: SurgicalSession[], cfg: { url: string; token: string; profile?: ParticipantProfile | null }): Promise<UploadResult>;
export function checkEnrolment(cfg: { url: string; token: string }): Promise<{ participantCode: string; sessionCount: number }>;
export function withdrawFromStudy(cfg: { url: string; token: string }): Promise<{ deletedSessions: number }>;  // POST /api/v1/me/withdraw

// '@/services/platform'
export function currentPlatform(): Platform;
export function appInfo(): AppInfo;
export function tzOffsetMin(t?: number): number;
export const consentVersion: string;                                   // from app.json extra.consentVersion

// '@/state/recording'
export const useRecording: UseBoundStore<StoreApi<RecordingStore>>;    // zustand v5 `create<RecordingStore>()(…)`

// '@/state/settings'
export const DEFAULT_SETTINGS: Settings;
export const useSettings: UseBoundStore<StoreApi<SettingsStore>>;

// '@/state/sessions'
export const useSessions: UseBoundStore<StoreApi<SessionsStore>>;
export const CASE_IN_PROGRESS_ERROR: string;                           // deleteSession/deleteAll reject with it during a case

// '@/state/recordingStore' (pure helpers)
export const UNDO_WINDOW_MS: number;                                   // 10 000
export const MIN_MEASURED_BASELINE_SEC: number;                        // 60: shorter baselines are not stored as measured
export function activeSessionOf(state: Pick<RecordingState, 'stage' | 'session'>): string | null;
export function canImportHealthInto(session: Pick<SurgicalSession, 'sensor' | 'samples' | 'rr'>): boolean;
export function shouldAutoUpload(cfg: Settings, profile: ParticipantProfile | null): boolean; // enabled, configured, consent not withdrawn
export function summaryOptionsFor(profile: ParticipantProfile | null): SummaryOptions;        // always {}: the session snapshot decides max HR

// '@/services/upload/tags' (pure; also re-exported from '@/services/upload/research')
export const UPLOADED_TAG_PREFIX: 'uploaded:';
export function withoutUploadedTag(tags: readonly string[] | undefined): string[] | undefined;
export function hasUploadedTag(tags: readonly string[] | undefined): boolean;
// The `uploaded:<ISO>` tag means "the server has this version". A health import and an event-editor save remove it
// (and re-upload when automatic upload is on); an edited event's time or kind sets `loggedBy: 'retrospective'`.

// '@/state/activeSession'
export function activeSessionId(): string | null;                     // the session the recording flow owns

// '@/services/storage/warnings' (web storage problems; always empty on iOS/Android)
export interface StorageWarning { unsavedSignalSessionIds: readonly string[]; writeFailed: boolean }
export function getStorageWarning(): StorageWarning;
export function subscribeStorageWarning(listener: () => void): () => void;
```

The UI agent owns `src/hooks/useSessionDetail.ts`
(`useSessionDetail(id) → { session, summary, loading, error, reload }`, which loads through `repository.getSession` and
computes/caches the summary with `summarizeSession` when it's missing).
