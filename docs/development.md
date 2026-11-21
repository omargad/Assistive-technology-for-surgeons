# Development guide

How to set up, run, test and extend SurgeonPulse. Commands are run from the **repository root** unless a section says
otherwise. Every npm command below matches a script in a `package.json`; the CI commands are copied from
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

Related documents: [architecture](architecture.md) · [data model](data-model.md) · [metrics](metrics.md) · app guides:
[mobile](../apps/mobile/README.md), [dashboard](../apps/dashboard/README.md), [server](../apps/server/README.md),
[Python toolkit](../analysis/README.md).

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | **22**, at least **22.13** for the server | Everything in TypeScript. `.nvmrc` contains `22`; the root `package.json` declares `"engines": { "node": ">=22.13" }`. The server uses the built-in `node:sqlite` module, which needs Node 22.13 or newer to load without a command-line flag. CI uses `actions/setup-node` with `node-version: 22`. |
| npm | the version bundled with Node 22 | npm workspaces and `package-lock.json`. Use `npm ci` for a clean install. |
| Python | ≥ 3.10 (CI tests 3.10 and 3.13) | The [analysis toolkit](../analysis/README.md) only |
| Chromium for Playwright | installed by Playwright | Dashboard end-to-end tests and the mobile web flow script |
| Xcode (macOS) and/or Android Studio | versions supported by Expo SDK 58 | Local native builds only (the app targets iOS 16.4+ and Android 8.0 / API 26+, compiled against Android SDK 36). [EAS](#native-builds-eas-and-prebuild) can build in the cloud instead. |
| A physical phone and a Bluetooth heart-rate strap | | Testing real sensors. Bluetooth does not work in the iOS Simulator or most Android emulators. |
| Docker | optional | Building the server image |

Check your Node version with `node --version`. With nvm: `nvm use` in the repository root.

## Install

```bash
npm ci                                   # all workspaces: packages/core, apps/*

# Python toolkit (optional), in a virtual environment
python -m venv .venv
source .venv/bin/activate                # Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -e "analysis[dev]" # installs the `surgeonpulse` command and pytest
```

The workspaces are `packages/*` and `apps/*`. `@surgeonpulse/core` has no build step: its `package.json` points
`main`, `types` and `exports` at `src/index.ts`, and each consumer compiles it from source (Metro for the app, Vite for
the dashboard, `tsx`/esbuild for the server).

## Scripts

### Root

| Command | Runs |
| --- | --- |
| `npm test` | `npm run test --workspaces --if-present` (every workspace's tests) |
| `npm run typecheck` | `npm run typecheck --workspaces --if-present` |
| `npm run build` | `npm run build --workspaces --if-present` (the dashboard and server builds) |
| `npm run dashboard` | `npm run dev -w @surgeonpulse/dashboard` |
| `npm run server` | `npm run start -w @surgeonpulse/server` |
| `npm run mobile` | `npm run start -w @surgeonpulse/mobile` |

npm runs a workspace script with the workspace folder as its working directory. That matters for the server's `.env`
file, which is read from `apps/server`.

### Per workspace

Run any of these from the root with `-w <workspace>`, or with `npm run <script>` inside the workspace folder.

| Workspace | Script | Command |
| --- | --- | --- |
| `@surgeonpulse/core` | `test`, `test:watch` | `vitest run`, `vitest` |
| | `typecheck` | `tsc --noEmit -p tsconfig.json` |
| | `fixtures` | `tsx scripts/generate-fixtures.ts` |
| `@surgeonpulse/mobile` | `start` | `expo start` |
| | `web` | `expo start --web` |
| | `ios`, `android` | `expo run:ios`, `expo run:android` (local native builds) |
| | `export:web` | `expo export --platform web` |
| | `typecheck` | `tsc --noEmit` |
| | `test` | `jest` (preset `jest-expo`) |
| | `doctor` | `expo-doctor` |
| | `e2e:web` | `node e2e/web-flow.mjs` |
| | `native:prebuild` | `expo prebuild --clean` (deletes and regenerates `ios/` and `android/`) |
| `@surgeonpulse/dashboard` | `dev` | `vite` |
| | `build` | `npm run typecheck && vite build` |
| | `preview` | `vite preview` |
| | `lint` | `oxlint` |
| | `typecheck` | `tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit` |
| | `test`, `test:watch` | `vitest run`, `vitest` (jsdom) |
| | `e2e` | `playwright test` |
| `@surgeonpulse/server` | `start` | `tsx src/main.ts` |
| | `dev` | `tsx watch src/main.ts` |
| | `build` | `tsx scripts/build.ts` (esbuild bundle into `dist/`) |
| | `start:dist` | `node dist/main.js` |
| | `backup` | `tsx src/backup.ts` |
| | `simulate` | `tsx scripts/simulate.ts` |
| | `test` | `vitest run` |
| | `typecheck` | `tsc --noEmit -p tsconfig.json` |

## Running each part

### Mobile app

```bash
npm run web -w @surgeonpulse/mobile      # web build with the simulator, http://localhost:8081
npm run mobile                           # Expo dev server (press w for web, or scan the QR code)
```

Expo Go does not contain the Bluetooth, Apple Health or Health Connect native modules. In Expo Go only the simulator
source works. Real sensors need a development build: see [Native builds](#native-builds-eas-and-prebuild) and the
[mobile README](../apps/mobile/README.md#running-on-a-phone-development-build). Web Bluetooth works only in
Chromium-based browsers (Chrome, Edge) on `https://` or `localhost`.

### Dashboard

```bash
npm run dashboard                        # Vite dev server, http://localhost:5173
npm run build -w @surgeonpulse/dashboard # typecheck + production build into apps/dashboard/dist
npm run preview -w @surgeonpulse/dashboard
```

On the **Data** page choose **Load demo data**, or open `fixtures/cohort-small.json`. The build uses `base: './'` and
hash routes, so `dist/` can be served from any static host or sub-directory.

### Server

```bash
cd apps/server
cp .env.example .env                     # Windows PowerShell: Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# paste the output into .env as ADMIN_TOKEN=...
npm run dev                              # restarts on change; or `npm start`
curl http://127.0.0.1:8787/health
```

The server **refuses to start** without an `ADMIN_TOKEN` of at least 32 characters. To produce a test upload:
`npm run simulate -- SP-014 bundle.json` (inside `apps/server`) writes a de-identified bundle of simulated sessions.
The server rejects simulated and demo sessions unless it runs with `ACCEPT_SIMULATED=true`, so set that in `.env` for
a local test server (never on a study server).
For the API, enrolment and deployment, see the [server README](../apps/server/README.md).

To let the app's web build or the dashboard call a local server, add their origins to `CORS_ORIGINS`, for example
`CORS_ORIGINS=http://localhost:8081,http://localhost:5173`.

### Python toolkit

```bash
surgeonpulse summarize fixtures/cohort-small.json -o summaries.csv
surgeonpulse frames fixtures/cohort-small.json -o frames/
surgeonpulse report fixtures/cohort-small.json
python -m surgeonpulse_analysis --help   # same CLI if the scripts folder is not on PATH
```

## Tests, type checks and builds

| Suite | Command (as in CI) | What it covers |
| --- | --- | --- |
| Core types | `npm run typecheck -w @surgeonpulse/core` | Strict type-check, including the compile-time check that the zod schemas match `types.ts` |
| Core unit tests | `npm test -w @surgeonpulse/core` | Vitest, one file per module in `packages/core/test/`: statistics, HR, RR cleaning and HRV, zones, phases, baseline, episodes, summaries, trends and insights, TLX, BLE parser, schema, bundle, CSV, de-identification, catalogue, labels, ids, session helpers, RNG and simulator, plus integration and conformance tests |
| Fixtures current | `npm run fixtures -w @surgeonpulse/core`, then `git status --porcelain -- fixtures` must be empty | See [Fixtures and parity](#fixtures-and-parity) |
| Server | `npm run typecheck -w @surgeonpulse/server`, `npm test -w @surgeonpulse/server`, `npm run build -w @surgeonpulse/server` | Vitest with Fastify `app.inject()` against a temporary `DATA_DIR`: config (including `TRUST_PROXY` and `ACCEPT_SIMULATED`), database migrations, auth, upload, sessions, export (including the optional date shift), participants, withdrawal (including the WAL checkpoint), rate limiting, audit, security headers, recomputing summaries after an analytics change; then the esbuild bundle in `dist/` |
| Core and server on Windows and macOS | The same core and server typecheck and test commands | Job `cross-platform`: catches path, file-mode and line-ending assumptions (the POSIX file-mode test is skipped on Windows) |
| Dashboard | `npm run typecheck -w @surgeonpulse/dashboard`, `npm test -w @surgeonpulse/dashboard`, `npm run build -w @surgeonpulse/dashboard` | Vitest (jsdom): reducer, filters, store, data table, file reading, downloads, exports, server client, chunked scheduler, formatters, router, column dictionary |
| Dashboard end-to-end | `npx playwright install --with-deps chromium` (in `apps/dashboard`), then `npm run e2e -w @surgeonpulse/dashboard -- --trace off` | Playwright in Chromium against `vite preview` on `127.0.0.1:4317`: the research workflow (demo data, overview, sessions table, session detail, participant feedback view, analysis, CSV download, importing `fixtures/cohort-small.json`), first-run empty states, the research-server token kept in memory, the tablet layout under 900 px, and the theme toggle and skip link |
| Mobile | `npm run typecheck -w @surgeonpulse/mobile`, `npm test -w @surgeonpulse/mobile -- --ci` | Jest (`jest-expo`): recording state machine (including out-of-range values, unsaved data at the debrief, the undo window and background flushes), settings store and secret storage, sessions store (including the case in progress and duplicate imports), SQLite and memory repositories (including a full browser storage quota), native BLE and Web Bluetooth sources with mocks (including Bluetooth switched off and battery refresh), reconnect back-off, keep-awake, simulator, source registry, health-store mapping and merge, upload client, export (de-identification, skipped sessions, native file clean-up), charts, slider, and UI tests for the live, debrief, insights, settings, event editor and cross-platform screens |
| Mobile UI tests on Android | `npx jest --ci --preset jest-expo/android src/components __tests__/ui` (in `apps/mobile`) | The component and screen tests again with `Platform.OS = 'android'` |
| Mobile native bundles | `npx expo export --platform ios --platform android --output-dir <dir>` and `npx expo config --type public` (in `apps/mobile`) | Both Hermes bundles build and the app config (with every config plugin) resolves |
| Mobile web end-to-end | In `apps/mobile`: `npx playwright install --with-deps chromium`; `npx expo export --platform web --output-dir dist-web`; `node e2e/serve-spa.mjs dist-web 8090 &`; `node e2e/web-flow.mjs http://127.0.0.1:8090` | Job `mobile-web-e2e`: Playwright walks the exported web build (onboarding, setup with the simulator, baseline, live screen, hold to end, debrief, session detail, Insights, Settings, reload) and fails on a failed step or **any** console error or warning. `e2e/serve-spa.mjs` is a dependency-free static server with a single-page-app fallback. Screenshots are uploaded as a CI artifact. |
| Python | `python -m pip install -e "analysis[dev]"`, `python -m pytest -q analysis` | Unit tests and the TypeScript ↔ Python parity tests, on Linux, Windows and macOS with Python 3.10 and 3.13 |
| Python CLI | `surgeonpulse summarize fixtures/cohort-small.json -o analysis-out/summaries.csv` | The installed console script runs |

Not in CI, but worth running before a release (see the [mobile README](../apps/mobile/README.md#testing)):

```bash
cd apps/mobile
CI=1 npx expo prebuild --no-install --clean                      # inspect native projects, then delete ios/ and android/
npx expo-doctor                                                  # dependency and config checks
```

Also not in CI: `npm run lint -w @surgeonpulse/dashboard` (oxlint), building the server's Docker image, and anything on
a physical device.

## Fixtures and parity

The analytics exist twice: in TypeScript (`packages/core`) and in Python (`analysis/`). Parity fixtures make sure they
agree.

1. [`packages/core/scripts/generate-fixtures.ts`](../packages/core/scripts/generate-fixtures.ts) uses only the public
   core API to write simulated and hand-built sessions, a small cohort bundle and the TypeScript outputs (summaries,
   HRV, extras with non-default options, CSVs, aggregates, import results) to [`fixtures/`](../fixtures/README.md). It
   is deterministic (fixed seeds and clocks), so the output is byte-identical on every run and every OS.
2. [`analysis/tests/test_parity.py`](../analysis/tests/test_parity.py) recomputes everything in Python. Counts, ids,
   timestamps and strings must match exactly; other numbers within `rtol = 1e-9, atol = 1e-6`; the samples, RR and
   events CSVs byte for byte.

```bash
npm run fixtures -w @surgeonpulse/core   # regenerate after any change to core analytics or CSV output
python -m pytest -q analysis             # check the Python port against the new fixtures
git status -- fixtures                   # review and commit the changes with the code change
```

**Why CI checks that the fixtures are current.** The CI job regenerates the fixtures and fails if `fixtures/` changes.
Without that check, someone could change the TypeScript analytics, forget to regenerate, and the Python parity tests
would keep passing against outdated expectations, so the two implementations could drift apart silently. The check
also catches accidental non-determinism in core (for example a stray `Date.now()`).

If a mismatch turns out to be a TypeScript bug against `SPEC.md`, add the check id (such as
`sim-7:hrv.rollingHrv`) to `TS_DISCREPANCIES` in `test_parity.py`. The check is then marked `xfail(strict=True)`: the
suite stays green until TypeScript is fixed and then fails as a reminder to remove the entry. The fixtures must stay
under 15 MB (a test enforces this). `fixtures/.gitattributes` turns off line-ending conversion, because the CSVs are
compared byte for byte.

## Adding a sensor source

**First check whether you need one.** Any device that implements the standard Bluetooth LE Heart Rate Profile
(service `0x180D`, characteristic `0x2A37`) already works through the existing `ble` (native) and `web-bluetooth`
sources. Some straps do not advertise the service; the sensor screen's **Show all devices** option finds them.

A live source implements `HeartRateSource` from
[`apps/mobile/src/services/sensors/types.ts`](../apps/mobile/src/services/sensors/types.ts):

| Member | Contract |
| --- | --- |
| `kind` | A `SensorSourceKind` value, stored as `session.sensor.source` |
| `label` | Short label for pickers |
| `isSupported()` | Whether this platform and runtime can use the source at all |
| `requestPermissions()` | Ask for runtime permissions; resolve `false` when denied |
| `canScan`, `scan(onDevice, { timeoutMs, showAll })` | Device discovery. Returns a function that stops the scan. Sources that use a system chooser set `canScan = false`. |
| `connect(deviceId?)` | Connect and resolve with `SensorInfo` (`source`, `name`, `id`, `location`) |
| `start(listener)` | Deliver data with `listener.onData(samples, rr)` (wall-clock epoch ms) and status with `listener.onStatus(status)`. Must reconnect automatically with exponential back-off capped at 30 s (use `backoffDelayMs` from `backoff.ts`) until `stop()`. |
| `stop()`, `disconnect()` | Stop delivery; tear down. `disconnect` must be safe to call more than once. |
| `onPhase?`, `onMarker?` | Optional hooks (the simulator uses them) |

Steps:

1. **Decide on the source kind.** If the data is a new kind of source, add it to `SensorSourceKind` in
   [`packages/core/src/types.ts`](../packages/core/src/types.ts), to the `sensorSource` enumeration in
   [`io/schema.ts`](../packages/core/src/io/schema.ts) and to `SENSOR_SOURCE_LABELS` in
   [`presentation/labels.ts`](../packages/core/src/presentation/labels.ts) (the compiler flags every exhaustive record
   that is missing it). **This is a format change:** older app versions reject sessions with an unknown source, so
   bump `SCHEMA_VERSION` with a migration (see [data model](data-model.md#versioning-and-compatibility)) and update the
   Python port. `types.ts` is the shared contract; agree such changes with the team first.
2. **Implement the source** in `apps/mobile/src/services/sensors/`. For platform-specific code use file suffixes
   (`mysource.native.ts`, `mysource.web.ts`, with a base `mysource.ts` that defines the exports, usually via
   `createUnsupportedSource`). Parse standard BLE payloads with core's `parseHeartRateMeasurement` (see
   `measurement.ts`). Callbacks from native libraries must never throw.
3. **Register it.** Add the choice to `SourceChoice` in `services/sensors/types.ts`, a label and description to
   `LABELS` in [`registry.ts`](../apps/mobile/src/services/sensors/registry.ts), a branch in `createSource`, its place
   in `availableSources()`, and the choice to `SOURCE_CHOICES` in
   [`state/settings.ts`](../apps/mobile/src/state/settings.ts) so it can be remembered as the preferred source.
4. **Declare permissions** in [`app.json`](../apps/mobile/app.json) or a config plugin, never by editing `ios/` or
   `android/`. Install native libraries with `npx expo install <package>` so the versions match the Expo SDK.
5. **Test it** in `services/sensors/__tests__/` with the native library mocked, following `ble.native.test.ts`
   (parse path, status transitions, reconnect back-off with fake timers). Run `npx expo export --platform web` to
   confirm that nothing native reaches the web bundle.
6. **Check it on real hardware** with a development build before any study use: connect, walk out of range and back,
   lock the screen during a recording (iOS; on Android this pauses recording: expect a gap and the "was in the
   background" banner), and compare against a reference device.

Health-store imports (data read after the case) implement `HealthStore` in
[`services/health/types.ts`](../apps/mobile/src/services/health/types.ts) instead, and are wrapped by the timed source
in `timed.ts`.

## Adding a metric

A metric must be defined once in core, ported to Python, pinned by fixtures and then shown in the apps.

1. **Core.** Write a pure function in the right module under `packages/core/src/analytics/` and export it through
   `src/index.ts`. Follow the [core conventions](#core-library): return `null` when there is not enough data, never
   `NaN` or `Infinity`, no platform APIs, no clock or randomness. Add tests in `packages/core/test/<module>.test.ts`
   and document the behaviour in [`packages/core/SPEC.md`](../packages/core/SPEC.md).
2. **Summary and cross-session use (if needed).**
   - A new `SessionSummary` field changes `types.ts` (agree it with the team) and `summarizeSession`.
   - For trends and group comparisons, add a `MetricKey`, a `METRICS` entry (label, unit, `higherIsBetter`,
     decimals) and a `metricValue` case in [`analytics/trends.ts`](../packages/core/src/analytics/trends.ts). The
     dashboard's Analysis page lists `METRICS` keys automatically.
   - For the summary CSV, add the column to `SUMMARY_BASE_COLUMNS` in [`io/csv.ts`](../packages/core/src/io/csv.ts)
     and a description to the dashboard's [`lib/columnDictionary.ts`](../apps/dashboard/src/lib/columnDictionary.ts)
     (a test fails if a column is undescribed). Adding columns shifts positions, so tell analysts whose scripts read
     the CSV by position.
3. **Python port.** Implement the same definition in `analysis/src/surgeonpulse_analysis/` (for example `hrv.py`,
   `summary.py`, `cohort.py` with `SUMMARY_CSV_COLUMNS` and `METRIC_COLUMNS`), with unit tests in `analysis/tests/`.
   Match JavaScript arithmetic: left-to-right sums and half-up rounding.
4. **Fixtures.** If the generator does not already exercise the new output, extend `generate-fixtures.ts` and
   `test_parity.py`. Run `npm run fixtures -w @surgeonpulse/core` and `python -m pytest -q analysis`, and commit the
   regenerated fixtures with the code.
5. **Apps.** Show the metric in the dashboard and the mobile app with labels from `METRICS` or
   `presentation/labels.ts`, with an accessible text alternative for any chart.
6. **Documentation.** Add the definition, interpretation and caveats to [metrics.md](metrics.md) and, if it is in the
   CSV, to [data-model.md](data-model.md#summary-csv).

**Cached summaries.** The mobile app caches each session's summary when the debrief is submitted, and the server
stores a summary per session when the session is first uploaded or changes. Existing cached summaries do not gain a
new field, or a corrected value, until they are recomputed. On the server an identical re-upload is `unchanged` and
does not recompute, and no endpoint does so yet, so the server's summaries CSV can lag behind the code. The dashboard
and the Python toolkit always recompute from the sessions, so prefer the JSON export for analysis after an analytics
change.

## Coding conventions

### TypeScript (all workspaces)

Shared settings live in [`tsconfig.base.json`](../tsconfig.base.json), which core and the server extend. The dashboard
sets the same options in `tsconfig.app.json`. The mobile app extends `expo/tsconfig.base` and adds `strict` and
`noUncheckedIndexedAccess`; it does not set `erasableSyntaxOnly`, but follow the same rules there, because the app
compiles core from source.

| Setting | Consequence |
| --- | --- |
| `strict: true` | Full strict mode |
| `noUncheckedIndexedAccess: true` | `xs[i]` has type `T \| undefined`. Check it, or use `!` only where the index is provably in range. |
| `erasableSyntaxOnly: true` | No `enum`, no `namespace`, no constructor parameter properties. Use string-literal unions and `as const` objects. Code must be type-strippable by tsx, esbuild, Vite and Metro. |
| `verbatimModuleSyntax: true`, `isolatedModules: true` | Import types with `import type`. |
| `noImplicitOverride: true` | Mark overrides with `override`. |
| `moduleResolution: "Bundler"`, `target: "ES2022"` | Relative imports have no file extension (`from './rr'`). |

Editor settings come from [`.editorconfig`](../.editorconfig): UTF-8, LF line endings, 2-space indents (4 for Python),
a final newline.

### Core library

- **No platform APIs.** No `Buffer`, `fs`, `window`, `document`, DOM types or Node built-ins. Only ES2022 and `zod`.
  The core `tsconfig.json` sets `"types": []` and `lib: ["ES2022"]`, so such APIs fail the type-check. Core must run
  unchanged on Hermes (iOS and Android), in browsers and in Node.
- **Hermes-safe code.** Do not spread long arrays into calls (`Math.max(...xs)`); use loops. Do not rely on the engine's
  sort being stable; use `stableSortBy`. Do not use `Intl`, `toLocaleString` or `localeCompare`, whose output differs
  between engines.
- **Deterministic.** Never call `Date.now()` or `Math.random()`, except in `createId()` and the simulator's documented
  defaults. Inject clocks and seeds.
- **Pure.** Never mutate inputs. Return new objects.
- **No `NaN` or `Infinity` in outputs.** Return `null` when there is not enough data.
- **`types.ts` is the contract** between all components. Changes need agreement and, for persisted shapes, a schema
  version bump.
- Every module has unit tests in `test/<module>.test.ts`.

### Mobile app

- Routes only in `src/app/` (Expo Router). Components, hooks and services live outside it. The path alias `@/` maps to
  `src/`.
- Platform differences go in suffixed files (see [architecture](architecture.md#cross-platform-design)). Never import
  a native-only module from shared code.
- Install packages with `npx expo install` so they match the Expo SDK. Configure native behaviour in `app.json` and
  config plugins; `ios/` and `android/` are generated and ignored by Git.
- Expo changes between SDK releases. When unsure about an API, check the installed package's type definitions and the
  versioned docs for SDK 58, as [`apps/mobile/AGENTS.md`](../apps/mobile/AGENTS.md) describes.
- **Accessibility.** Every control has `accessibilityRole` and `accessibilityLabel`. State and value use the ARIA props
  that React Native supports (`aria-checked`, `aria-disabled`, `aria-selected`, `aria-expanded`, `aria-busy`,
  `aria-valuemin`/`-valuemax`/`-valuenow`/`-valuetext`, `aria-hidden`), which react-native-web also renders as real ARIA
  attributes; the code base does not use `accessibilityState` or `accessibilityValue`. Adjustable controls such as the
  slider expose `accessibilityActions` (increment, decrement) with `onAccessibilityAction`. Charts carry a text summary
  in `accessibilityLabel`. Live-screen buttons are at least 64 pt; text scales with the system font size.
- Never log the enrolment token or session data. Copy is plain, non-judgemental and uses no emoji.

### Dashboard

- Never re-implement analytics; call core.
- Format numbers and dates without `Intl` or locale APIs, so every machine shows the same values.
- Charts are `role="img"` with a text summary, a legend and a **View as table** toggle.
- Unused variables are left to `oxlint` (`npm run lint -w @surgeonpulse/dashboard`) rather than `tsc`, because core is
  compiled as part of the dashboard program.

### Server

- Node built-ins are fine here (`node:sqlite`, `node:crypto`). Validate configuration and request bodies with zod.
- Never log request bodies or secrets. Every mutating call writes an audit row.
- All analytics, parsing and de-identification come from core.

### Python

- Function names are snake_case ports of the TypeScript names; options become keyword arguments.
- Match JavaScript arithmetic for parity: left-to-right summation, half-up rounding (`floor(x + 0.5)`), `None` where
  TypeScript returns `null`.

## Native builds (EAS and prebuild)

The [mobile README](../apps/mobile/README.md) has the full instructions. The essentials:

- **Development build.** `expo-dev-client` is already a dependency of `apps/mobile`, so a development build can be
  made straight away.
- **EAS (cloud) builds.** [`apps/mobile/eas.json`](../apps/mobile/eas.json) defines three profiles:

  | Profile | Settings |
  | --- | --- |
  | `development` | `developmentClient: true`, internal distribution, Android APK |
  | `preview` | Internal distribution, Android APK |
  | `production` | `autoIncrement: true` (`appVersionSource: "remote"`) |

  ```bash
  cd apps/mobile
  npx eas-cli@latest login
  npx eas-cli@latest init                                     # links the project
  npx eas-cli@latest build --profile development --platform android
  npx eas-cli@latest build --profile development --platform ios
  ```

- **Local builds.** `npx expo run:ios --device` or `npx expo run:android --device` (also `npm run ios` / `npm run
  android`). Needs Xcode or Android Studio; the device must run iOS 16.4+ or Android 8.0 (API 26)+.
- **Prebuild.** `ios/` and `android/` are generated by `expo prebuild` (Continuous Native Generation) and ignored by
  Git. `npm run native:prebuild -w @surgeonpulse/mobile` runs `expo prebuild --clean`, which **deletes and regenerates**
  both folders. To inspect the generated permissions without installing pods:
  `CI=1 npx expo prebuild --no-install --clean`, then delete the folders.
- **Store and platform requirements** (check the current rules before a release): iOS device builds need an Apple
  Developer Program membership, and reading Apple Health needs the HealthKit capability, which the config plugin adds.
  Google Play reviews apps that request Health Connect permissions and is likely to require a declaration of how the
  health data is used. The app requests read access only.
- **Status.** The native Bluetooth, HealthKit and Health Connect code paths have been tested with mocks and compiled
  bundles, **not on physical devices**. Test on real hardware before any study use.
- The script is called `native:prebuild`, not `prebuild`: npm would run a `prebuild` script automatically before any
  future `build` script and silently wipe `ios/` and `android/`.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main` and `ccr-*` branches and on pull
requests. Concurrent runs for the same ref are cancelled. Permissions are read-only.

| Job | Runner | Steps |
| --- | --- | --- |
| `typescript`: Typecheck & unit tests (core, server, dashboard, mobile) | ubuntu-latest, Node 22, 30 min | `npm ci`; core typecheck and tests; regenerate fixtures and fail if `fixtures/` changed; server typecheck, tests and build; dashboard typecheck, tests and build; mobile typecheck and `jest --ci`; mobile UI tests with the `jest-expo/android` preset; iOS and Android bundle export and `expo config --type public` |
| `cross-platform`: Core & server | windows-latest and macos-latest, Node 22, 30 min, `fail-fast: false`, bash shell, `core.autocrlf false` | `npm ci`; core typecheck and tests; server typecheck and tests (Ubuntu is covered by `typescript`) |
| `dashboard-e2e`: Dashboard end-to-end (Playwright) | ubuntu-latest, Node 22, 30 min | `npm ci`; install Chromium with system dependencies; `npm run e2e -w @surgeonpulse/dashboard -- --trace off` |
| `mobile-web-e2e`: Mobile web build end-to-end (Playwright) | ubuntu-latest, Node 22, 30 min | `npm ci`; install Chromium; export the web build to `apps/mobile/dist-web`; serve it with `e2e/serve-spa.mjs` on port 8090; `node e2e/web-flow.mjs`; upload the screenshots |
| `python`: Python analysis toolkit (incl. TS ↔ Python parity) | ubuntu, windows and macOS × Python 3.10 and 3.13, 15 min, `fail-fast: false` | `pip install -e "analysis[dev]"`; `pytest -q analysis`; CLI smoke test |

CI does **not** build the server's Docker image, run oxlint, run `expo-doctor` or prebuild, build native apps, or
test on devices.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Server exits with "Invalid configuration" | `ADMIN_TOKEN` is missing, shorter than 32 characters or contains spaces. Set it in `apps/server/.env` or the environment. |
| `ExperimentalWarning` about SQLite | Node 22 marks `node:sqlite` as experimental. `main.ts` filters that one warning; it is harmless. |
| `node:sqlite` cannot be found | Node is older than 22.13. Upgrade Node. |
| Bluetooth option shows as unavailable on the web | Web Bluetooth needs Chrome or Edge on `https://` or `localhost`. Safari and Firefox do not support it. |
| Only the simulator is offered on a phone | You are in Expo Go. Use a development build. |
| The dashboard cannot reach the server | Add the dashboard's origin to `CORS_ORIGINS`. An `https://` page can only call an `https://` server. |
| CI fails with "fixtures/ is stale" | Run `npm run fixtures -w @surgeonpulse/core` and commit `fixtures/`. |
