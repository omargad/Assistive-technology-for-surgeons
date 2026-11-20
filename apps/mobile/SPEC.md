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
    then, status stays `recording`. `submitDebrief` computes `summarizeSession` with the profile and caches it via
    `saveSummary`, and triggers an auto-upload when enabled.
  - Sensor status transitions update `sensorStatus`. A long dropout (> 15 s without data while recording) sets a
    warning status for the UI. Data gaps are fine: analytics handles gaps.
  - The participant snapshot comes from the profile, and `tzOffsetMin` comes from `-new Date().getTimezoneOffset()`.
  - Keep-awake: activate (`expo-keep-awake` `activateKeepAwakeAsync('recording')`) during baseline/recording when the
    setting is on, and deactivate on end/abort.
- **BLE native** (`ble.native.ts`): a single `BleManager` for the whole app (lazy). Scanning filters on
  `HEART_RATE_SERVICE` unless `showAll`. Some straps don't advertise service UUIDs, so offer "Show all devices".
  Dedupe by id. On Android, request `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (API ≥ 31), or
  `ACCESS_FINE_LOCATION` (≤ 30), via `PermissionsAndroid`. Wait for the `PoweredOn` state (and report
  "Bluetooth is off"). On connect, call `discoverAllServicesAndCharacteristics`, read Body Sensor Location and Battery
  Level if present, then `monitorCharacteristicForService(HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT)` →
  `base64ToBytes` → `parseHeartRateMeasurement` → sample `{t: Date.now(), bpm, contact}` + RR `{t, ms}` for each RR.
  Re-subscribe after reconnect. Auto-reconnect on unexpected disconnect with exponential back-off (1 s → 30 s cap)
  while started. Requested MTU isn't needed. Remove subscriptions on stop/disconnect. Never throw out of BLE
  callbacks.
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
  action. The import merges samples into the session (`saveSession`) and recomputes the summary.
- **Storage (SQLite)**: open `surgeonpulse.db` with `openDatabaseAsync` and enable WAL. Schema version table and
  migrations. Tables: `sessions(id TEXT PK, meta TEXT JSON, started_at INTEGER, status TEXT, summary TEXT JSON NULL, updated_at INTEGER)`,
  `samples(session_id TEXT, t INTEGER, bpm REAL, contact INTEGER NULL)` with index `(session_id, t)`,
  `rr(session_id TEXT, seq INTEGER, t INTEGER, ms REAL)` with index `(session_id, seq)`, `profile(id INTEGER PK CHECK (id=1), json TEXT)`.
  Batch inserts inside `withExclusiveTransactionAsync` (or `withTransactionAsync`) using prepared statements.
  Deleting a session deletes its signals. `getSession` reassembles and validates via `parseSession`.
- **Settings**: persist JSON via `expo-sqlite/kv-store` on native and `localStorage` on web (wrapped in try/catch).
  The research token is stored in settings, not in logs or exports.
- **Export**: the bundle JSON via `createExportBundle({ deidentify: true by default, now: Date.now() })`. The
  filename is `surgeonpulse-<code>-<yyyymmdd-hhmm>.json`. CSV export for a single session (samples/rr/events CSVs)
  and for all summaries. Native: write to `Paths.cache` with the new `expo-file-system` API (`File`, `Paths`; read
  the installed types) and call `Sharing.shareAsync`. Web: `Blob` + an anchor download.
- **Upload**: POST JSON with `Authorization: Bearer <token>`. Show a clear result: accepted/rejected counts, plus
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
  steps with no native slider dependency; accessible via `accessibilityActions` increment/decrement), `ListRow`,
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
    `linearTrend`), and `GroupBarChart` (aggregateMetric with mean ± sd whiskers).
  - Every chart has an `accessibilityLabel` summary (e.g. "Heart rate from 62 to 118 bpm; highest during critical phase").
- **Live screen** (`record/live.tsx`): big HR (zone-coloured) with a trend arrow, elapsed clock, current phase chip,
  sensor pill (battery, contact, status), and a signal-lost banner. Phase buttons are shown in PHASE_ORDER with the
  current one highlighted and the next one emphasised. Marker buttons have an optional quick note. The undo snackbar
  lasts 10 s, and there's a "Logged by: Self / Team" toggle. "End case" requires a long press (1.5 s) with a progress
  ring, because accidental taps happen. A timed session (health-store source) shows "HR will be imported after the case".
- **Session detail:** a header (procedure, date, duration, role, approach), stat tiles (mean / peak HR, Δ vs
  baseline, RMSSD, stress index, episodes, workload), HrTimelineChart, RollingHrvChart, ZoneBar, a phase table,
  an episode list (with phase and related events), the post-op report, data quality (coverage %, gaps, artefact %),
  and actions (edit events, export JSON/CSV, import from Health, upload, delete).
- **Insights:** insight cards (kind-coloured with an icon), TrendChart for meanHrDelta / rmssd / workload with a
  metric switcher, and a by-procedure GroupBarChart. Copy is plain and non-judgemental, framed as reflection rather
  than evaluation.
- **Onboarding:** short and friendly. Consent is an explicit checkbox plus "I agree". The participant code is
  validated with `isValidParticipantCode`, with a hint like "Use the code from your research team, e.g. SP-014. Do not
  use your name.". Profile fields are optional.
- **Tests:** render tests for key components and screens with `@testing-library/react-native` (charts render with
  data and empty input, the slider responds to accessibility actions, live screen buttons call store actions with a
  mocked store).

## Quality bar

- `npx tsc --noEmit` is clean, `npx jest` is green, and `npx expo export --platform web` succeeds.
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
export function shareBundle(sessions: SurgicalSession[], opts?: { deidentify?: boolean; profile?: ParticipantProfile | null }): Promise<void>;
export function shareSessionCsv(session: SurgicalSession, kind: 'samples' | 'rr' | 'events'): Promise<void>;
export function shareSummariesCsv(summaries: SessionSummary[]): Promise<void>;
export function pickImportFile(): Promise<string | null>;            // returns file text (expo-document-picker on native, <input type=file> on web)

// '@/services/upload/research'
export interface UploadResult { accepted: { id: string; status: 'created' | 'updated' | 'unchanged' }[]; rejected: { index: number; id?: string; reason: string }[] }
export function uploadSessions(sessions: SurgicalSession[], cfg: { url: string; token: string; profile?: ParticipantProfile | null }): Promise<UploadResult>;
export function checkEnrolment(cfg: { url: string; token: string }): Promise<{ participantCode: string; sessionCount: number }>;

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
```

The UI agent owns `src/hooks/useSessionDetail.ts`
(`useSessionDetail(id) → { session, summary, loading, error, reload }`, which loads through `repository.getSession` and
computes/caches the summary with `summarizeSession` when it's missing).
