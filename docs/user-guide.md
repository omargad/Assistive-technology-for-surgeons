# SurgeonPulse user guide

Part A is for **surgeons taking part** in a SurgeonPulse study. Part B is for **research coordinators** who run the
study server, enrol participants and use the dashboard. Labels in **bold** are the exact words shown in the app or
dashboard.

> **Research tool, not a medical device.** SurgeonPulse records your own heart rate for research and reflection. It
> does not diagnose anything, does not monitor patients and raises no alerts. Never enter patient names, record
> numbers or other identifiers anywhere in the app.

Contents:

- **Part A: surgeons** — [What you need](#what-you-need) · [Installing](#installing-the-app) ·
  [Onboarding and consent](#onboarding-and-consent) · [Study server and token](#connecting-to-the-study-server) ·
  [Pairing a strap](#pairing-a-chest-strap) · [Starting a case](#starting-a-case) ·
  [Resting baseline](#the-resting-baseline) · [Live screen](#the-live-or-mode-screen) ·
  [Timed sessions](#timed-sessions-apple-watch-or-health-connect) · [Debrief](#the-debrief) ·
  [Reviewing a session](#reviewing-a-session) · [History and Insights](#history-and-insights) ·
  [Exporting](#exporting-your-data) · [Uploading](#uploading-to-the-study-server) ·
  [Interrupted cases](#if-the-app-closes-during-a-case) · [Withdrawing](#withdrawing-from-the-study) ·
  [Deleting data](#deleting-your-data)
- **Part B: research coordinators** — [Running the server](#running-the-study-server) ·
  [Participants and tokens](#creating-participants-and-enrolment-tokens) ·
  [Giving tokens to participants](#giving-tokens-to-participants) · [Monitoring](#monitoring-enrolments-and-uploads) ·
  [Dashboard](#using-the-dashboard) · [De-identified exports](#de-identified-exports) ·
  [Withdrawal](#handling-withdrawal)
- [Troubleshooting](#troubleshooting) · [FAQ](#frequently-asked-questions)

Related documents: [hardware](hardware.md) · [privacy and ethics](privacy-ethics.md) ·
[study protocol template](study-protocol.md) · [mobile app README](../apps/mobile/README.md) ·
[server README](../apps/server/README.md) · [dashboard README](../apps/dashboard/README.md)

---

## Part A: for surgeons (participants)

### What you need

- An iPhone (iOS 16.4 or later) or Android phone (Android 8.0 or later) with the study build of SurgeonPulse, and a
  phone stand for theatre. A charger is useful for long cases.
- A chest strap issued by the research team (see [hardware](hardware.md)), or an Apple Watch or Android smartwatch if
  the study uses timed sessions.
- Your **participant code** (for example `SP-014`) and, if the study uses the research server, the **study server
  URL** and your **enrolment token**.

### Installing the app

The research team gives you the study build of the app (a "preview" build, installed directly rather than from the
App Store or Play Store). The steps depend on how the team distributes it; the technical details are in the
[mobile app README](../apps/mobile/README.md#build-profiles-eas).

- The **Expo Go** app is not enough for real cases: it cannot use Bluetooth, Apple Health or Health Connect, so only
  the simulator works there.
- A web version runs in Chrome or Edge for demonstrations and training. Use the phone app for study cases.

### Onboarding and consent

The first time you open the app, four short steps appear:

1. **Welcome.** An overview, and the notice "Research tool — not a medical device". Tap **Get started**.
2. **Study information.** What is recorded and how it is protected. Tick "I have read the participant information
   and consent to take part in this study." and tap **I agree**. The consent form version is shown underneath
   (it should match your paper or electronic consent form).
3. **Your participant code.** Enter the code from the research team, for example `SP-014`. Never use your name.
   The app accepts 2–32 letters, numbers, `-` or `_`, converts letters to upper case, and rejects anything that looks
   like an e-mail address. Tap **Continue**.
4. **About you (optional).** Training level, specialty, years of surgical experience, birth year (year only),
   typical resting heart rate. These help interpret your data, for example age-predicted heart-rate zones. Tap
   **Finish**, or **Skip for now**. You can change them later in **Settings → Profile**, where you can also enter a
   measured maximum heart rate.

### Connecting to the study server

If your study uses the research server:

1. Open **Settings → Research study**.
2. Enter the **Study server URL** (it must start with `https://`) and your **Enrolment token**, then tap **Save**.
3. Tap **Check enrolment**. "Enrolment confirmed" shows the participant code the server knows you by and how many of
   your sessions it holds. If it also says "Note: your profile code is …", the codes differ: contact the research
   team before recording.
4. Optionally turn on **Upload automatically**, which sends each completed, de-identified session after its debrief.

The token is kept in your phone's secure storage (on the web version, in the browser's storage) and is never shown
in exports. Treat it like a password. **Forget server and token** removes both from the phone.

### Pairing a chest strap

1. Put the strap on and **moisten the electrodes**; many straps stay asleep until they detect skin contact.
2. Open **Settings → Recording → Heart-rate sensor** (or tap **Manage** on the Record tab). The **Heart-rate sensor**
   screen scans for nearby sensors.
3. Tap your strap in the list. The app remembers it as "your usual sensor". If it does not appear, turn on
   **Show all devices** or tap **Scan again**, and make sure the strap is not connected to another app or watch.
4. Once connected, the screen says whether **beat-to-beat (RR) data** is arriving. HRV needs it; if it says it is
   missing, the strap sends heart rate only.

On the web (Chrome or Edge), there is no list: tap **Choose sensor**, and pick the strap in the browser's own
chooser. More detail, including what to do in theatre, is in [hardware](hardware.md).

### Starting a case

Put the strap on a few minutes before scrubbing. Then, on the **Record** tab:

1. Tap **Start new case**. The **New case** screen opens.
2. **Procedure.** Search the catalogue (**Search procedures**) or filter by specialty, and choose the procedure. If it
   is not listed, type a **Custom procedure name** and tap **Use custom name**. Enter the type of procedure only,
   never patient details.
3. **Case details** (optional but useful): **Your role** (primary surgeon, assistant, supervising, observing),
   **Approach**, **Urgency**, and **Anticipated complexity** from 1 (routine) to 5 (very complex), rated before the
   case.
4. **Heart-rate source.** Choose **Bluetooth heart-rate strap** (or another source the study uses) and connect:
   **Connect _your strap_** for the remembered strap, or **Find sensors** to choose another. On the web, use
   **Choose sensor in browser**.
5. Tap **Continue to resting baseline** (recommended), or **Skip baseline and start recording**.

**Cancel** (top right) abandons the case before recording starts.

### The resting baseline

The baseline is your personal reference: changes during the case are measured against it.

1. Sit quietly and breathe normally, **the same way before every case**, ideally before scrubbing. Standing raises
   heart rate, so a standing baseline is not comparable with a seated one.
2. Choose the **Length** (1–5 minutes; the default is 3 minutes, set in **Settings → Recording → Resting baseline
   length**) and tap **Start baseline**. **Finish early** becomes available after 60 seconds (shorter baselines are
   not used), or tap **Skip baseline**.
3. When the countdown ends, the **Your resting baseline** card shows your resting heart rate and RMSSD (RMSSD needs
   beat-to-beat data from the strap). Tap **Start recording**, or **Redo baseline**.

If "No baseline captured" appears, not enough heart-rate data arrived. Redo it, or start without one; your profile's
typical resting heart rate is then used if you entered it.

### The live (OR mode) screen

The live screen is designed to be read from 1–2 metres and operated by a non-sterile team member while you operate.
It uses a dark, low-glare theme (**Settings → Recording → OR mode (dark live screen)**), keeps the screen awake
(**Keep screen awake**), and in landscape shows heart rate on the left and buttons on the right.

What it shows:

- **Heart rate** in large digits, coloured by zone, with a trend arrow and a short recent-history line. To keep the
  number off the screen (the whole team can see it), turn off **Settings → Recording → Show heart rate on the live
  screen**; heart rate is still recorded.
- **Elapsed** time, the current phase (or "No phase yet") and the sensor status (tap it to open the sensor screen).
  The status shows "No RR" if the strap sends heart rate without beat-to-beat data.
- **Signal lost** in the heart-rate panel if no heart-rate data arrives for more than 15 seconds: the number becomes
  "--" with the last reading. Recording continues and the strap reconnects automatically.

What the team taps:

| Control | What it does |
| --- | --- |
| **Logged by: Self / Team** | Records who is tapping. Leave it on **Team** (the default) when a team member logs for you; switch to **Self** if you tap yourself. |
| **Phase** buttons: **Pre-op**, **Incision / access**, **Dissection**, **Critical step**, **Closure**, **Post-op** | Marks the start of that phase now. The current phase is highlighted ("Current") and the following one emphasised ("Next"). Phases can be marked in any order and repeated. |
| **Events** buttons: **Complication**, **Interruption**, **Equipment issue**, **Teaching moment**, **Supervisor takeover**, **Note** | Marks the event now. **Hold** an event button for half a second (on the web: **Shift+Enter** or Shift+click) to add a short note; **Note** always asks for one. Notes must never contain patient details. |
| **Undo** | Appears in the heart-rate panel for 10 seconds after each tap, in case of a mistake. It is not offered again after **Minimise**; correct the event afterwards with **Edit events & times**. |
| **Minimise** | Leaves the live screen while recording continues. Return with **Return to live screen** on the Record tab. |
| **End case** | **Press and hold** for 1.5 seconds ("Keep holding…") to finish. A short tap only shows a reminder. On the web, hold Space or Enter; a keyboard or screen-reader activation asks "End the case now?" instead. |

On Android, the back button does not leave the live screen during a recording. **Keep the live screen open, the
screen on and the phone plugged in**: on Android, recording pauses if the app goes to the background or the screen
locks. What was recorded is saved, and when you return the screen says "SurgeonPulse was in the background".

### Timed sessions (Apple Watch or Health Connect)

If you use a watch instead of a strap, there is no live heart rate; it is imported after the case.

1. Start a workout on the watch before the case.
2. On the **New case** screen, choose **Apple Watch (via Apple Health)** (iPhone) or **Smartwatch (via Health
   Connect)** (Android). Allow access when asked (or use **Allow access to …** on the sensor screen).
3. Tap **Start case**. There is no baseline for timed sessions. The live screen shows elapsed time, the phase and
   event buttons, and "HR will be imported after the case".
4. After **End case**, the debrief offers **Import heart rate now**. Watch data can take a few minutes to sync; if no
   samples are found yet, import later from the session page (**Import from Apple Health** or
   **Import from Health Connect**).

The import is offered only for cases recorded with the watch (health store) as the source, or cases without any
heart-rate data. It never mixes watch data into a case recorded with a strap.

Health Connect is built into Android 14 and later; on Android 9–13 install it from the Play Store.

### The debrief

The **Post-op debrief** opens when you end a case. It takes 1–2 minutes; complete it as soon as you can after the
case (your study protocol may set a time limit).

1. **Workload (SURG-TLX).** Rate six demands from very low to very high on 0–100 sliders (steps of 5): Mental
   Demands, Physical Demands, Temporal Demands, Task Complexity, Situational Stress and Distractions. Each slider
   starts **unanswered** ("Not rated", no thumb): tap the scale or use −/+ to rate it. The **Workload score** (mean of
   the six ratings) shows "—" until all six are rated. If you save with some unrated, the app asks first and saves
   the debrief **without** workload ratings.
2. **Weight the dimensions (optional).** Answer 15 "Which contributed more?" choices. The weighted score is used only
   when all 15 are answered.
3. **About the case:** **Your performance** (0–10), **Perceived stress** (0–10), **Last night's sleep** (hours),
   **Caffeine in the 2 hours before the case?**, and **How did the case go?** (as planned, minor or major deviation
   from plan). Each is optional and shows "Not rated" or "Not answered" until you set it; **Clear** un-answers a
   slider.
4. **Notes (optional).** Never enter patient identifiers. Notes stay on your phone and are removed from exports by
   default.
5. Tap **Save debrief**. **Skip** keeps the recording without the questionnaire (you are asked to confirm). If the
   end of the recording could not yet be saved to storage, the app says so ("…could not be saved to storage yet…
   save the debrief again"); nothing has been lost, so free some space if needed and tap **Save debrief** again.

### Reviewing a session

After the debrief, the session page opens. You can reopen any session from **History**.

- **Summary tiles:** **Mean HR**, **Peak HR** (the highest sustained level, an 11-second rolling median, so a single
  glitch does not count), change **vs resting**, **RMSSD** (needs RR data), **Stress index** (Baevsky), **Episodes**
  (sustained heart-rate rises) and **Workload**. RMSSD and the stress index show "Not shown: too many irregular beats
  or artefacts" when more than 10 % of beats were artefacts.
- **Charts:** **Heart rate** over time with phase bands and event markers, **Heart-rate variability** (RMSSD in
  1-minute windows), **Time in zones**, **Heart rate by phase**, a phase table and **Stress episodes**.
- **Post-op report** and **Data quality** (**Coverage**, **Gaps**, **RR artefacts**, **Sample rate**).
- **Actions:**
  - **Edit events & times**: correct times with **−1 min**, **−10 s**, **+10 s** and **+1 min**, change or remove an
    event, or add a missed phase or marker (added events, and events whose time or kind you change, are recorded as
    "retrospective"). Tap **Save changes**; leaving with unsaved changes asks first. An uploaded session is marked as
    not uploaded again (and re-uploaded if automatic upload is on).
  - **Export session (JSON)**, **Export heart rate (CSV)**, **Export RR intervals (CSV)**, **Export events (CSV)**.
  - **Import from Apple Health / Health Connect** (on phones with a health store, for watch or empty cases only).
  - **Upload to study server** (or **Upload again**), when the study server is set up and you have not withdrawn.
  - **Delete session**.

  While a case is still being recorded, its page shows "Case in progress", and **Edit events & times** and **Delete
  session** are unavailable until the case has ended.

### History and Insights

- **History** lists your sessions. Search by procedure or specialty, or filter with the specialty chips.
- **Insights** shows observations about **your own** cases once you have enough of them, for example which phase
  usually has your highest heart rate (from three cases), how many of your sustained heart-rate rises followed a
  complication or interruption marker, and data-quality tips. Trend, HRV and workload–heart-rate observations need 8–10 cases and appear only when
  the pattern is clear enough not to be ordinary variation; they note other possible influences. They are prompts for
  reflection, not a judgement of performance. **Over time** charts one metric per session (**HR vs rest**, **HRV** or
  **Workload**) and says "no clear trend" unless the trend is statistically clear; **By procedure** compares
  procedures.
- **Load demo data** adds simulated sessions, labelled "Demo", to explore the app. Insights keeps them in a separate,
  labelled view (**Your cases / Demo**, "Simulated data — not your cases"). They are never uploaded and can be deleted
  in Settings.

### Exporting your data

- From a session page: JSON or CSV exports of that session (see above).
- From **Settings → Data**: **Export all sessions (JSON)** (a de-identified bundle for the research team) and
  **Export summaries (CSV)** (one row per session for SPSS, R or Excel; demo and simulator sessions are left out).
  If a session can't be read, Export all skips it and tells you.
- **Import sessions** reads a SurgeonPulse JSON export back into the app. Sessions already on the phone are skipped
  (the phone's copy is kept), and the app says how many.

All exports are de-identified by default: notes and sensor identifiers are removed, and custom procedure names are
replaced with the catalogue name (or "Unspecified procedure", keeping only the specialty). Dates and times are kept.
Exports go through your phone's share sheet, so check where you send them.

### Uploading to the study server

- **Automatic:** turn on **Settings → Research study → Upload automatically**. Each completed session is uploaded
  after its debrief.
- **Manual:** **Upload sessions now** (Settings) sends every completed session not yet uploaded; **Upload to study
  server** on a session page sends that one.
- Uploads are de-identified. Demo and simulator sessions and sessions still recording are never sent, and nothing is
  sent after you withdraw. Uploaded sessions show an **Uploaded** chip. Uploading again is safe: the server recognises
  sessions it already has. **Upload sessions now** skips (and reports) a session that can't be read.
- Recording works without a network connection; upload later.

### If the app closes during a case

Data are saved every 5 seconds, and whenever the app leaves the foreground. If the app is closed or the phone restarts
during a case, the next launch shows **Unfinished case found** with three choices: **Resume recording** (reconnect the sensor and continue the same
session; the time the app was closed stays as a gap), **End case & debrief**, or **Decide later**.

### Withdrawing from the study

You can stop taking part at any time without giving a reason and without any consequence.

1. In the app: **Settings → Privacy & consent → Withdraw consent**, then confirm. This records your withdrawal date,
   turns off automatic upload and stops every further upload. It does **not** delete anything on the phone.
2. If your phone is connected to the study server, the app then asks **Also delete your data on the study server?**
   Choose **Delete server data** to have the server delete every session it holds for you and stop accepting your
   token, or **Cancel** to keep the uploaded data. Either way you can **contact the research team** to have uploaded
   data deleted; they will also tell you what happens to data already analysed, as described in your participant
   information sheet.
3. To remove your data from the phone, see the next section, and return the strap.

### Deleting your data

- **Delete session** on a session page deletes that case from the phone.
- **Settings → Data → Delete all data** deletes every session, your profile and consent record, and the study server
  address and token from the phone, then starts setup again. It does not affect data already uploaded, and it is not
  possible while a case is being recorded (end the case first).
- To remove everything from the phone, uninstall the app. On the web version, clear the site's data in the browser.

---

## Part B: for research coordinators

### Running the study server

The research server collects de-identified sessions from participants' phones and serves them to the dashboard and
to analysis. Follow the [server README](../apps/server/README.md) for installation, configuration, deployment,
TLS and backups. In short:

- It needs Node.js 22.13 or newer, keeps everything in one SQLite file, and refuses to start without an
  `ADMIN_TOKEN` of at least 32 characters.
- `npm run server` from the repository root (or `npm start` in `apps/server`) starts it on `http://127.0.0.1:8787`;
  `GET /health` returns `{"status":"ok","version":"0.1.0"}`.
- For a study, run it on university infrastructure behind a TLS reverse proxy (set `TRUST_PROXY`), add the
  dashboard's address to `CORS_ORIGINS`, and set up encrypted backups.
- It rejects simulated and demo sessions unless `ACCEPT_SIMULATED=true` (for test servers only), so a test upload from
  `npm run simulate` needs that setting.
- Files that leave the research team should come from `GET /api/v1/export?shiftDates=true` (or
  `/export/summaries.csv?shiftDates=true`), which moves each participant's dates by a secret, consistent number of
  weeks.
- A Docker image definition is provided. It has not been built or tested in CI.

### Creating participants and enrolment tokens

Each participant needs a participant record and at least one enrolment token (one per phone). The examples below use
bash; the [server README](../apps/server/README.md#enrol-a-participant-and-upload) also has PowerShell versions.

```bash
export SP_URL=https://surgeonpulse.example.ac.uk     # your server
export ADMIN_TOKEN='paste-the-admin-token'           # keep it out of shell history where possible

# Optional: create the participant with profile fields first (201 = created, 200 = profile replaced).
curl -s -X POST "$SP_URL/api/v1/admin/participants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"SP-014","profile":{"trainingLevel":"registrar","specialty":"General surgery"}}'

# Create an enrolment token. This also creates the participant if needed.
curl -s -X POST "$SP_URL/api/v1/admin/enrolments" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"participantCode":"SP-014","label":"study iPhone"}'
# → {"id":"…","token":"spk_…","participantCode":"SP-014","label":"study iPhone","createdAt":…}
```

Rules to follow:

- **Use upper-case codes** (`SP-014`, not `sp-014`). The app converts what participants type to upper case, and the
  server stores codes in upper case and matches them case-insensitively, so `sp-014` and `SP-014` are the same
  participant everywhere.
- Codes must be 2–32 characters from `A–Z a–z 0–9 _ -`, start with a letter or digit, and must not look like an
  e-mail address. Never use names or staff numbers.
- The **token is shown once**, in this response only. Only its hash is stored. If it is lost, revoke it and create a
  new one.
- The optional `label` describes the device (at most 64 characters). It must never contain a person's name.
- Profile fields use the app's values: `trainingLevel` is one of `consultant`, `fellow`, `registrar`, `resident`,
  `intern`, `student`, `other`. Profiles sent by the app on upload replace the stored profile.

### Giving tokens to participants

- The token lets anyone upload sessions under that participant's code **and withdraw the participant (deleting their
  server data)**. Handle it like a password.
- Ideally, enter the server URL and token directly on the participant's phone during the enrolment visit, then tap
  **Check enrolment** together.
- If it must be sent, use a secure channel approved by the university, and never send the token together with the
  participant's name and code.
- Record which enrolment id belongs to which device (not to which name) so that a lost phone's token can be revoked.

### Monitoring enrolments and uploads

```bash
# Participants: profile, withdrawn flag, session and enrolment counts, last upload
curl -s "$SP_URL/api/v1/admin/participants" -H "Authorization: Bearer $ADMIN_TOKEN"

# Enrolments (never includes tokens), with an "active" flag
curl -s "$SP_URL/api/v1/admin/enrolments" -H "Authorization: Bearer $ADMIN_TOKEN"

# Revoke a lost or replaced device's token (204)
curl -s -X DELETE "$SP_URL/api/v1/admin/enrolments/<enrolment-id>" -H "Authorization: Bearer $ADMIN_TOKEN"

# Sessions for one participant, and the latest 500 audit entries
curl -s "$SP_URL/api/v1/sessions?participant=SP-014&limit=10" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s "$SP_URL/api/v1/admin/audit" -H "Authorization: Bearer $ADMIN_TOKEN"

# Exports (-OJ saves the file under the server-provided name)
curl -s -OJ "$SP_URL/api/v1/export/summaries.csv" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s -OJ "$SP_URL/api/v1/export" -H "Authorization: Bearer $ADMIN_TOKEN"
```

`GET /api/v1/sessions` and both exports accept the filters `participant`, `from` and `to` (epoch milliseconds on the
session start; `from` inclusive, `to` exclusive) and `specialty`. Every export is recorded in the audit log.

Check uploads regularly against the theatre schedule (without recording patient details), and contact participants
whose sessions show low coverage or missing debriefs.

### Using the dashboard

The dashboard runs in any current browser. Run it with `npm run dashboard` from the repository root during
development, or host the built `dist/` folder on any static web host (see the
[dashboard README](../apps/dashboard/README.md)). It is local-first: data are held in the browser tab's memory and
cleared when the tab is closed or reloaded.

#### Loading data (Data page)

| Card | Use |
| --- | --- |
| **Open files** | Drop SurgeonPulse `.json` exports, or **Choose files…**. Several files are merged by session id (later files win). Skipped sessions are listed as warnings. |
| **Demo data** | **Load demo data** generates a simulated cohort from a **Seed** (**Regenerate** picks a new one). Labelled "Simulated" everywhere; it replaces any loaded data, and loading real data replaces it. |
| **Research server** | Enter the **Server URL** and **Admin token**, then **Connect & download** (fetches `GET /api/v1/export`). The URL is remembered; the token is kept in memory unless you tick **Remember the token on this device** (avoid this on shared computers). The server's `CORS_ORIGINS` must list the dashboard's address. |
| **Loaded data** | What is in memory, with **Clear all data**. |

#### Pages

| Page | What it is for |
| --- | --- |
| **Overview** | Key figures (**Participants**, **Sessions**, **Hours recorded**, **Median coverage**, **Median RR artefact**), heart-rate change by phase, workload distribution, sessions per month, and data-quality flags (coverage below 80 % or RR artefact above 5 %) |
| **Sessions** | Sortable table with filters (**Search**, **Participant**, **Procedure**, **Specialty**, **Approach**, **Role**, **From**, **To**). The filters also apply to Overview, Analysis and Export. |
| Session detail | Heart-rate timeline with phases, events, baseline and episode threshold; rolling RMSSD; zones; phases; episodes; events; post-op report; data quality; per-session CSV downloads |
| **Participants** | List of participants. A participant's page is the **feedback view** to go through with that surgeon: insights, learning curve, phase profile against an anonymised cohort median (other participants' codes are never shown), workload and heart rate, sessions by procedure |
| **Analysis** | **Group comparison** (a **Metric** by a **Group by**, as a table and a chart with SD whiskers) and **Relationship between metrics** (**X axis** against **Y axis** with a fitted line and Pearson r), plus copyable **Summary text** |
| **Export** | Downloads for the filtered sessions (see below) and the **Column dictionary** |

When going through the feedback view with a participant, open only that participant's page (the **Participants**
list and other pages show other codes) and close the tab afterwards.

### De-identified exports

| Export | Where | Contents and de-identification |
| --- | --- | --- |
| Summaries CSV | Server `GET /api/v1/export/summaries.csv`; dashboard **Download summaries CSV** | One wide row per session (the columns are listed in the dashboard's **Column dictionary**). Identifiers are the participant code and session id; dates are real unless the server export is called with `?shiftDates=true`. Exclude rows with `simulated` = 1, and do not pool rows with different `analytics_version`. |
| Samples, events and RR CSVs | Dashboard **Download samples CSV**, **Download events CSV**, **Download RR CSV** | Long format, one row per sample, event or beat, as loaded (data from the app or server are already de-identified with the defaults). The events CSV never contains notes. |
| JSON bundle | Server `GET /api/v1/export` | De-identified with the defaults: notes, free-text procedure names and sensor ids removed; real dates, time zone and birth year kept. With `?shiftDates=true`, each participant's dates move by a secret, consistent number of whole weeks (weekday and time of day kept). |
| De-identified bundle | Dashboard **Download de-identified bundle** | As above, plus **Shift dates randomly per participant** (on by default; whole weeks, **Maximum shift (weeks)** 52 by default; the shift is never saved), **Remove timezone offsets** (off by default) and **Remove birth years** (on by default). Use this for sharing outside the team. |

Tick **Excel-friendly CSV** only when the file will be opened in Excel on Windows; leave it off for R, pandas, SPSS
and Stata. For analysis in Python, see the [analysis toolkit](../analysis/README.md) and the
[study protocol template](study-protocol.md#9-statistical-analysis-plan).

### Handling withdrawal

Follow the withdrawal procedure approved by the HREC. A typical sequence:

1. Confirm what the participant wants under the consent form: stop taking part only, or also delete data already
   collected.
2. **To delete server data and close the participant:**

   ```bash
   curl -s -X DELETE "$SP_URL/api/v1/admin/participants/SP-014" -H "Authorization: Bearer $ADMIN_TOKEN"   # 204
   ```

   This deletes all of the participant's sessions, revokes every token, clears the profile to the bare code and
   retires the code. A withdrawn code cannot be re-enrolled (the server answers "participant has withdrawn"); if the
   participant later re-consents, issue a new code. (A participant can do the same with their own token through
   `POST /api/v1/me/withdraw`.)
3. **To stop further uploads but keep data** (if the consent form allows it): revoke the participant's enrolments
   with `DELETE /api/v1/admin/enrolments/<enrolment-id>` instead.
4. Ask the participant to tap **Withdraw consent**, and either **Delete all data** or uninstall the app; collect the
   strap.
5. Remove the participant's data from copies outside the server, as the protocol requires: dashboard sessions
   (**Clear all data**), downloaded exports, analysis datasets and shared datasets. Server backups taken before the
   withdrawal still contain the data; handle them under the backup policy.
6. Record the withdrawal in the study's own records. The server's audit log records the action and counts.

---

## Troubleshooting

| Problem | Likely cause | What to do |
| --- | --- | --- |
| Strap not found, or "Signal lost" during a case | Dry electrodes, strap busy with another device, phone too far away | See [hardware troubleshooting](hardware.md#troubleshooting) |
| "The research server address must start with https:// to keep your data secure." | The URL uses `http://` | Use the `https://` address from the research team |
| "The research server did not accept your enrolment token…" | Wrong or mistyped token; token revoked; participant withdrawn | Re-enter the token; ask the research team for a new one |
| "Enrolment confirmed" also says "Note: your profile code is …" | The profile code differs from the server's code | Contact the research team before recording; the codes must be the same (upper and lower case count as the same) |
| Upload rejected: "participantCode does not match the enrolment token" | Sessions were recorded under a different code from the token's participant | Sessions keep the code they were recorded with; the research team decides how to proceed |
| "Demo data is never uploaded." or "Sessions recorded with the simulator are never uploaded." | Demo and simulator sessions are excluded by design (the server also rejects them: "simulated or demo data is not accepted by this server") | Nothing to do |
| "You have withdrawn consent, so nothing is uploaded to the study server." or "…consent has been withdrawn for this participant." | Consent was withdrawn on this phone or on the server | Nothing is uploaded after withdrawal; contact the research team if this is unexpected |
| A session is listed as "left out" or "skipped" after an export, upload or import | Its participant code is not a study code, it could not be read, or (import) it is already on the phone | The message names the reason; the other sessions were processed |
| "The session is still being recorded." | The case has not ended or the debrief is waiting | End the case and complete or skip the debrief |
| "Too many requests to the research server." | Server rate limit (30 uploads per minute per address) | Wait and try again |
| "Upload sessions now" is greyed out | Server URL or token missing, or consent withdrawn | Complete **Research study** settings; after withdrawal, uploading is disabled |
| "No samples found yet" after a watch session | Watch data not synced | Import later from the session page |
| HRV values missing | The source sends heart rate only, or too few clean RR intervals | Use an ECG chest strap that sends RR intervals |
| Web version lost its sessions | Browser site data cleared (web data live in `localStorage`) | Use the phone app for study cases; export regularly |
| Dashboard: "Could not load data" when connecting to the server | Wrong URL or admin token, CORS not configured, or an `https://` page calling an `http://` server | Check the URL and token; add the dashboard's origin to `CORS_ORIGINS`; serve both over HTTPS |
| Server will not start | `ADMIN_TOKEN` missing, shorter than 32 characters, or containing spaces | Set a valid token in `.env`; the error message names the setting |
| "The upload is too large for the research server…" | Proxy body limit smaller than `MAX_UPLOAD_MB` (the app already splits uploads below the server's default limit) | Raise the proxy limit (for example nginx `client_max_body_size 25m;`) |

## Frequently asked questions

**Does the app record anything about my patients?**
No. There are no patient fields. Procedures come from a catalogue, and free-text fields warn you not to enter patient
details. Notes are removed from exports by default.

**Can my supervisor or employer see my data?**
Only the research team can access the study server, and the study's agreements should state that data will not be
used for performance management, credentialing or medico-legal purposes. By default the app shows your live heart
rate on the theatre screen, so people in the room can see it while you operate; turn off **Settings → Recording →
Show heart rate on the live screen** to hide it (it is still recorded).

**Is this a health check?**
No. SurgeonPulse is a research tool, not a medical device, and nobody monitors your data in real time. If you feel
unwell, seek medical advice in the usual way.

**Who should tap the buttons during the case?**
A non-sterile team member (circulating nurse, anaesthetist or researcher), with **Logged by** set to **Team**. Clinical
duties always come first; missed events can be added afterwards in **Edit events & times**.

**What if we forget to mark a phase, or mark it late?**
Fix it after the case in **Edit events & times**. Added events, and events whose time or kind you change, are labelled
as retrospective so researchers can tell them apart.

**What if I forget to end the case?**
Hold **End case** as soon as you remember and tell the research team the approximate real end time. The end time
cannot be edited in the app.

**Why does my session have no HRV?**
HRV needs beat-to-beat (RR) intervals. Optical arm bands and watches usually do not provide them, and RR data with
heavy artefacts (for example from a dry strap or diathermy) are partly removed.

**Does the app need mobile data or Wi-Fi in theatre?**
No. Recording works offline. Uploads happen later, when a connection is available.

**Can I use SurgeonPulse after the study?**
The app keeps your data on your phone until you delete it, and you can export it at any time. Ask the research team
about continued use, and about uploads after the study closes.

**What does "Simulated" or "Demo" mean?**
Generated data for training and demonstrations. It is never real, demo sessions are never uploaded, and simulated
sessions are labelled throughout the app and dashboard.
