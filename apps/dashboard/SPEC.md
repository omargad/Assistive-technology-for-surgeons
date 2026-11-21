# SurgeonPulse dashboard — spec

A browser-based dashboard (Vite + React 19 + TypeScript + Recharts) with two audiences:

1. **Researchers** do cohort analysis across participants, procedures and phases, check data quality, and export
   for statistics packages (R/SPSS/Stata/Python).
2. **Surgeons** get an individual performance-feedback view: learning curves, phase stress profiles, and how their
   physiology relates to self-reported workload. The tone is reflective rather than evaluative.

It's cross-platform by nature (any modern browser on desktop or tablet) and **local-first**: data loaded from files
stays in the browser's memory and is never sent anywhere. The only network access is an optional connection to the
research ingest server (`apps/server`) that the user configures.

All analytics come from `@surgeonpulse/core` (`summarizeSession`, `aggregateMetric`, `metricSeries`, `linearTrend`,
`generateInsights`, `rollingHrv`, `resampleHr`, `derivePhases`, `PHASE_COLORS`, labels, CSV/bundle helpers,
`simulateCohort`). Don't re-implement analytics in the dashboard.

## Data sources (Data page / first-run screen)

- **Open files:** drag-and-drop or a file picker for one or more `.json` exports (`parseImport`). Merge by session id,
  with later files winning, and show warnings.
- **Demo data:** `simulateCohort({ seed })` with a "Regenerate" option and a seed input. Label it clearly as
  **Simulated**.
- **Research server:** a URL and admin token. Fetch `GET {url}/api/v1/export` with the bearer token. Remember the URL
  only in `localStorage`, never the token; keep the token in memory unless the user ticks "remember on this device".
- A clear "Data stays in this browser" note and a "Clear all data" button.

Summaries are computed once per session (memoised by id) after loading. Big cohorts (≈ 100 sessions) must stay
responsive, so compute progressively in chunks with `setTimeout`/`requestIdleCallback` yielding, and show a progress bar.

## Pages (simple hash router: `#/overview`, `#/sessions`, `#/sessions/:id`, `#/participants`, `#/participants/:code`, `#/analysis`, `#/export`, `#/data`)

- **Overview:** KPI tiles (participants, sessions, hours recorded, median coverage, median artefact %), a mean HR Δ
  vs baseline by phase chart (bar ± SD from aggregate over per-session phase values), sessions-per-month, workload
  distribution, data-quality flags (sessions with coverage < 80 % or artefact > 5 %, linked).
- **Sessions:** a sortable, filterable table (participant, procedure, specialty, approach, role, date range, text
  search). Columns: date, participant, procedure, duration, mean HR, Δ, RMSSD, SI, workload, coverage. Rows link to
  the detail page. Virtualise or paginate past 200 rows.
- **Session detail:** a header, stat tiles, an HR timeline (Recharts `ComposedChart`: line with `connectNulls={false}`
  over `resampleHr` at 5 s, `ReferenceArea` phase bands in PHASE_COLORS with labels, `ReferenceLine` for events with
  glyph labels, a dashed baseline line and an episode threshold line, brush zoom), a rolling RMSSD chart, zones, a
  phase table, episodes, the post-op report, data quality, and per-session exports (samples/RR/events CSV).
- **Participants:** a list with session counts and date ranges. The detail page is the **feedback view**: insight
  cards (`generateInsights`), learning curves (`metricSeries` + `linearTrend` with a metric selector), a phase
  profile vs the cohort median (anonymised: "cohort median" only, never other participants' codes; the median leaves
  out the viewed participant and is shown only for a phase with ≥ 5 other participants, `cohortPhaseMedians`), a
  workload vs HR Δ scatter with Pearson r, and procedure breakdowns.
- **Analysis:** a metric selector (METRICS) × group-by selector (GroupKey) → table (`aggregateMetric`) and bar chart
  with SD whiskers. A scatter of metric X vs metric Y (colour by group) with OLS line and r. Copyable summary text.
- **Export:** `summariesToCsv` (filtered set), a long-format samples CSV (all filtered sessions concatenated), an
  events CSV, and a de-identified bundle JSON (option: random time shift per participant, consistent within a
  participant). Show the column dictionary for the summaries CSV.
- **Data:** the sources described above.

## UX & accessibility

- A clean, clinical look with system font stack, CSS variables for light/dark (`prefers-color-scheme` plus a toggle),
  and phase colours from core. A responsive layout with a sidebar nav on desktop that collapses to a top bar under
  900 px, so it's usable on an iPad.
- Charts get `role="img"` with `aria-label` summaries and a "View as table" toggle for screen-reader users. Visible
  focus rings, keyboard-operable tables and nav, WCAG AA contrast.
- Empty states on every page that point to the Data page. Error boundary with a friendly message.
- Never display other participants' codes in the participant feedback view's cohort comparisons.

## Engineering

- `src/` layout: `main.tsx`, `App.tsx`, `router.ts`, `state/` (React context + reducer: sessions map, summaries,
  filters, source info), `pages/*`, `components/*` (layout, tables, KPI tiles, charts), `lib/*` (formatters,
  downloads, file reading, server client), `styles/*.css`. No CSS framework is needed.
- `vite.config.ts`: keep the React plugin and add Vitest config (`environment: 'jsdom'`). Set `base: './'` so the
  build can be opened from any static host.
- Tests: Vitest unit tests for state reducers, filters, the server client (mock fetch), and download helpers. A
  Playwright e2e test (`e2e/*.spec.ts`, `playwright.config.ts` with a `webServer` running `vite preview` after a
  build, chromium only) covers load demo → overview renders KPIs → sessions table sort/filter → session detail chart
  visible → participant feedback view → analysis group-by change → export triggers a CSV download → import of
  `/fixtures/cohort-small.json` via the file input.
- `npm run typecheck`, `npm test`, `npm run build` and `npm run e2e` are all green.
