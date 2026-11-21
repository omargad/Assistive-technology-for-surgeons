# SurgeonPulse dashboard

The browser dashboard for SurgeonPulse, built with Vite, React 19, TypeScript and Recharts. It serves two audiences:

- **Researchers** analyse the cohort across participants, procedures and phases, check data quality, and export
  data for R, SPSS, Stata or Python.
- **Surgeons** get an individual feedback view with insights, learning curves, a phase profile compared with an
  anonymised cohort median, and workload against heart-rate response.

It's **local-first**. Files you open are read into the tab's memory and are never uploaded. The only network request
the dashboard makes is to a research server you configure yourself (`GET {url}/api/v1/export` with a bearer token;
see the [server SPEC](../server/SPEC.md)). All analytics come from `@surgeonpulse/core`. The dashboard doesn't re-implement any of
them. SurgeonPulse is a research tool, not a medical device.

## Scripts

Run these in `apps/dashboard`, or from the repository root with `-w @surgeonpulse/dashboard` (the root's
`npm run dashboard` is a shortcut for `dev`). Install dependencies once at the root with `npm ci`.

```bash
npm run dev         # development server
npm run typecheck   # tsc for the app (src) and the Node-side config/e2e files
npm test            # Vitest unit and component tests (jsdom)
npm run build       # typecheck + production build into dist/
npm run preview     # serve dist/ locally
npm run e2e         # Playwright (Chromium): builds, starts vite preview on :4317, runs e2e/
npm run lint        # oxlint
```

## Data sources (Data page)

- **Open files**: drag and drop, or choose one or more SurgeonPulse `.json` exports. Bundles, single sessions and
  arrays are all accepted (core `parseImport`). Sessions are merged by id, and later files win. Any skipped
  sessions are listed as warnings.
- **Demo data**: `simulateCohort({ seed })`, labelled **Simulated** everywhere it appears. Simulated data is never
  mixed with real data: loading the demo replaces what's loaded, and loading real data replaces a demo.
- **Research server**: the URL is remembered in `localStorage`. The token stays in memory unless you tick
  "Remember the token on this device". The server's `CORS_ORIGINS` must include the dashboard's origin.

Summaries (core `summarizeSession`) are computed once per session in time-boxed chunks while a progress bar is
shown, so a cohort of about 100 sessions stays responsive.

## Pages

Hash routes work on any static host, with no server rewrites:

| Route | Contents |
| --- | --- |
| `#/overview` | KPIs, HR Δ by phase (± SD), workload distribution (raw, unweighted SURG-TLX / NASA-TLX scores), sessions per month, data-quality flags |
| `#/sessions` | Filterable, sortable table. Paginated above 200 rows |
| `#/sessions/:id` | HR timeline (phases, markers, baseline, episode threshold, brush zoom), rolling RMSSD, zones, phases, episodes, events, post-op SURG-TLX, data quality, per-session CSVs |
| `#/participants` | Participant list, with a notice that responses are not for comparing or ranking surgeons |
| `#/participants/:code` | Feedback view. Cohort comparisons show only an anonymised median of the **other** participants (never another participant's code), and only for a phase with at least 5 of them |
| `#/analysis` | Metric × group-by (`aggregateMetric`) table and chart, scatter with OLS fit and Pearson r, copyable summary |
| `#/export` | Summaries CSV (with `sensor_source`, `simulated` and `analytics_version` columns), long samples/events/RR CSVs (the events CSV never contains notes), a de-identified JSON bundle, and the column dictionary |
| `#/data` | Data sources, loaded-data list, and "Clear all data" |

The filters on the Sessions page also apply to Overview, Analysis and Export. Pages are loaded on demand
(`React.lazy` in `App.tsx`), so the first screen does not wait for Recharts.

## Cross-platform support

The dashboard runs in any current browser on Windows, macOS, Linux, ChromeOS, iPadOS and Android. The build
targets Chrome/Edge 111+, Firefox 114+ and Safari 16+ (`vite.config.ts`).

- **Layout**: on desktop there's a sidebar. Under 900 px it turns into a sticky top bar with a scrollable tab row,
  so it works on an iPad in portrait. Touch targets are at least 44 px on coarse pointers, the layout respects
  safe-area insets, and form inputs use a 16 px font so iOS doesn't zoom into them.
- **Safari/iPadOS**: Safari lacks `requestIdleCallback`, so the summary scheduler falls back to `setTimeout`.
  Older WebKit lacks `Blob.text()`, so files are read with `FileReader`. The clipboard falls back to `execCommand`
  on plain-HTTP hosts. Downloads use an attached `<a download>` whose object URL is revoked after a delay.
- **Deterministic text**: numbers and dates are formatted without `Intl` or locale APIs. Dates are shown in the
  recording's own timezone, not the viewer's, so every machine shows the same values.
- **Files**: download names are restricted to `[A-Za-z0-9._-]`, which is safe on every OS. CSVs use RFC 4180 with
  CRLF line endings. The "Excel-friendly" option adds a UTF-8 BOM for Excel on Windows. Leave it off for R,
  pandas, SPSS and Stata.
- **Hosting**: with `base: './'` and hash routing, you can copy `dist/` to any static host or sub-directory, such
  as university web space, an intranet share or GitHub Pages. Browsers won't run module scripts from `file://`, so
  serve the folder over HTTP (for example `python3 -m http.server`).
- **Theme**: follows `prefers-color-scheme`, and the sidebar has a toggle. It supports forced colours (Windows
  High Contrast) and reduced motion.

## Accessibility

- Each chart is a single `role="img"` with a text summary, a legend (colour is never the only cue) and a
  **View as table** toggle.
- Visible focus rings, a skip link, and focus moves to the page heading after navigation.
- Sortable headers are buttons with `aria-sort`, and wide tables are focusable scroll regions.
- Phase colours are the core `PHASE_COLORS` (Okabe–Ito). Text meets WCAG AA in both themes.

## Privacy

- Participants are identified only by pseudonymous codes.
- Nothing is logged: the error boundary shows a message but doesn't record stacks or data.
- The token is never written to storage unless you choose "Remember", and it never appears in error messages.
- The de-identified bundle removes notes, free text and sensor ids, and replaces procedure names with catalogue
  names. It can also drop timezones and birth years, and shift dates by a random number of whole weeks per
  participant. The shift is the same for all of a participant's sessions and isn't stored anywhere.

## Layout

```
src/
  main.tsx, App.tsx, router.ts
  state/        reducer (sessions, summaries, filters, sources), filters, merge, context/provider/hooks
  pages/        Overview, Sessions, SessionDetail, Participants, ParticipantDetail, Analysis, Export, Data, NotFound
  components/   layout shell, DataTable, filters, UI primitives, error boundary, charts/*
  lib/          formatters, downloads, file reading, server client, exports, chunked scheduler, theme, …
  styles/       tokens.css (light/dark), base.css, layout.css, components.css
e2e/            Playwright specs (imports fixtures/cohort-small.json, or generates an equivalent cohort)
```
