/**
 * End-to-end simulator flow on the SurgeonPulse web build (Playwright + Chromium).
 *
 * Walks onboarding (consent, code SP-001) -> Record -> setup (catalogue procedure, simulator)
 * -> 1-min baseline finished early -> live (phases, complication marker, Self/Team logger toggle,
 * undo) -> landscape live check -> hold-to-end -> debrief (sliders) -> session detail (chart +
 * stored events) -> Insights (demo data) -> History -> Settings -> reload persistence.
 * Exits non-zero on a failed step or on any console error/warning.
 *
 * Usage:
 *   npx expo export --platform web --output-dir /tmp/mobile-web
 *   node e2e/serve-spa.mjs /tmp/mobile-web 8090 &
 *   node e2e/web-flow.mjs [baseUrl=http://localhost:8090]
 * Screenshots: $SCREENSHOT_DIR/mobile-*.png (default: the OS temp dir), 390x844 at deviceScaleFactor 1.
 * Works against `npx expo start --web` too, which also surfaces development-only React warnings.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `playwright` is installed at the repo root (dashboard devDependency); require() also honours NODE_PATH.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = process.env.SCREENSHOT_DIR ?? tmpdir();
const BASE = process.argv[2] ?? 'http://localhost:8090';
const PHONE = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

const consoleIssues = [];
const steps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, detail = '') {
  steps.push(`${step}${detail ? `: ${detail}` : ''}`);
  console.log(`✓ ${step}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') consoleIssues.push(`[${type}] ${msg.text()}`);
});
page.on('pageerror', (err) => consoleIssues.push(`[pageerror] ${err.message}`));

const byTestId = (id) => page.locator(`[data-testid="${id}"]`).first();
const shot = async (name, opts = {}) => {
  const path = join(OUT, `mobile-${name}.png`);
  await page.screenshot({ path, ...opts });
  return path;
};
/** Capture a tall screenshot of a scrolling screen by temporarily growing the viewport. */
const tallShot = async (name, height = 2400) => {
  const prev = page.viewportSize();
  await page.setViewportSize({ width: prev.width, height });
  await sleep(600);
  const p = await shot(name);
  await page.setViewportSize(prev);
  await sleep(300);
  return p;
};
const clickText = (text, opts = {}) => page.getByText(text, { exact: true, ...opts }).first().click();

try {
  // ---------------------------------------------------------------- Onboarding
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await byTestId('onboarding').waitFor({ timeout: 20000 });
  await shot('01-onboarding-welcome');
  await clickText('Get started');
  await byTestId('onboarding-consent').waitFor();
  await shot('02-onboarding-consent');
  await byTestId('onboarding-consent').click();
  await byTestId('onboarding-agree').click();
  await byTestId('onboarding-code').fill('SP-001');
  await shot('03-onboarding-code');
  await byTestId('onboarding-code-continue').click();
  await page.getByText('About you (optional)').waitFor();
  await shot('04-onboarding-profile');
  await byTestId('onboarding-finish').click();
  await byTestId('record-home').waitFor({ timeout: 10000 });
  await page.getByText('Participant SP-001').waitFor();
  await shot('05-record-home');
  log('Onboarding', 'consent + SP-001 accepted, Record home shows participant');

  // ---------------------------------------------------------------- Setup
  await byTestId('record-start').click();
  await byTestId('record-setup').waitFor();
  await byTestId('procedure-picker-search').fill('chole');
  await page.getByLabel('Laparoscopic cholecystectomy, General surgery').first().click();
  await page.getByText('Case details').waitFor();
  await byTestId('source-simulated').click();
  await byTestId('setup-connect-sim').click();
  await page.waitForFunction(() => document.body.innerText.includes('Simulator'), null, { timeout: 10000 });
  await sleep(1500);
  await shot('06-setup');
  await tallShot('06b-setup-full', 1900);
  log('Setup', 'catalogue procedure + simulator connected');

  // ---------------------------------------------------------------- Baseline
  await byTestId('setup-continue').click();
  await byTestId('record-baseline').waitFor();
  await clickText('1 min');
  await byTestId('baseline-start').click();
  await sleep(22000);
  await shot('07-baseline-running');
  // A baseline under a minute is not used, so "Finish early" is disabled until then (RV-6).
  const finishEarly = byTestId('baseline-finish-early');
  if ((await finishEarly.getAttribute('aria-disabled')) !== 'true') throw new Error('"Finish early" should be disabled before 60 s');
  await page.getByText('Your resting baseline').waitFor({ timeout: 60000 });
  await shot('08-baseline-done');
  const restingTxt = await page.getByText('Resting HR').locator('..').innerText().catch(() => '');
  log('Baseline', `1-minute baseline completed (${restingTxt.replace(/\s+/g, ' ')})`);
  await byTestId('baseline-start-recording').click();

  // ---------------------------------------------------------------- Live
  await byTestId('record-live').waitFor({ timeout: 10000 });
  await sleep(20000);
  await shot('09-live-start');
  await byTestId('phase-incision').click();
  await sleep(4000);
  await byTestId('phase-critical').click();
  await sleep(3000);
  // Logger defaults to "Team" (sterile surgeon): toggle to Self for the complication, then back.
  const loggerBefore = await byTestId('live-logger-team').getAttribute('aria-checked').catch(() => null)
    ?? await byTestId('live-logger-team').getAttribute('aria-selected');
  await byTestId('live-logger-self').click();
  await byTestId('marker-complication').click();
  await sleep(1000);
  await shot('10-live-events');
  await byTestId('live-logger-team').click();
  await sleep(300);
  await byTestId('marker-equipment').click();
  await byTestId('live-undo-action').waitFor();
  await shot('11-live-undo-visible');
  // The undo bar must never cover a button (a tap on a half-covered "Teaching" used to land on Undo): every visible
  // phase / event / logger control is hit-testable at its centre while the bar shows.
  const covered = await page.evaluate(() => {
    // The part of an element not clipped by scroll containers or the window (scrolled-away buttons are not "covered").
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      let top = Math.max(r.top, 0);
      let bottom = Math.min(r.bottom, innerHeight);
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowY)) {
          const pr = p.getBoundingClientRect();
          top = Math.max(top, pr.top);
          bottom = Math.min(bottom, pr.bottom);
        }
      }
      return { x: (r.left + r.right) / 2, top, bottom };
    };
    return [...document.querySelectorAll('[data-testid^="phase-"],[data-testid^="marker-"],[data-testid^="live-logger-"],[data-testid="live-end"]')]
      .filter((el) => {
        const v = visible(el);
        if (v.bottom - v.top < 24) return false; // (almost) scrolled out of view
        const hit = document.elementFromPoint(v.x, (v.top + v.bottom) / 2);
        return !hit || !el.contains(hit);
      })
      .map((el) => el.getAttribute('data-testid'));
  });
  if (covered.length > 0) throw new Error(`Undo bar covers live controls: ${covered.join(', ')}`);
  await byTestId('live-undo-action').click();
  await sleep(800);
  await shot('12-live-after-undo');
  const liveText = await page.locator('[data-testid="record-live"]').innerText();
  log('Live', `team logger initially selected=${loggerBefore}; incision+critical (team), complication (self), equipment (team) undone; phase chip: ${/Critical step/.test(liveText) ? 'Critical step' : '?'}`);

  // Landscape check
  await page.setViewportSize(LANDSCAPE);
  await sleep(1500);
  await shot('13-live-landscape');
  await page.setViewportSize(PHONE);
  await sleep(1000);
  await sleep(6000); // let the complication response show in the HR

  // ---------------------------------------------------------------- End case (hold)
  const end = byTestId('live-end');
  await end.scrollIntoViewIfNeeded();
  // A short tap must NOT end the case.
  await end.click();
  await sleep(600);
  if (!(await byTestId('record-live').isVisible())) throw new Error('A short tap on End case ended the case');
  const box = await end.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(800);
  await shot('14-live-holding-end');
  await sleep(1000);
  await page.mouse.up();
  await byTestId('record-debrief').waitFor({ timeout: 10000 });
  log('End case', 'short tap ignored; 1.8 s hold opened the debrief');

  // ---------------------------------------------------------------- Debrief
  await shot('15-debrief-top');
  // Tap on tracks at different positions and nudge with +/-.
  const dims = ['mental', 'physical', 'temporal', 'complexity', 'stress', 'distraction'];
  for (const [i, d] of dims.entries()) {
    const track = byTestId(`tlx-${d}`);
    await track.scrollIntoViewIfNeeded();
    const b = await track.boundingBox();
    await page.mouse.click(b.x + b.width * (0.2 + i * 0.12), b.y + b.height / 2);
  }
  await byTestId('tlx-stress-increment').click();
  await byTestId('tlx-stress-increment').click();
  // Drag the mental-demand slider horizontally.
  const mental = byTestId('tlx-mental');
  await mental.scrollIntoViewIfNeeded();
  const mb = await mental.boundingBox();
  await page.mouse.move(mb.x + mb.width * 0.2, mb.y + mb.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(mb.x + mb.width * (0.2 + k * 0.06), mb.y + mb.height / 2);
  await page.mouse.up();
  const values = {};
  for (const d of dims) values[d] = await byTestId(`tlx-${d}`).getAttribute('aria-valuenow');
  const score = await byTestId('debrief-score').innerText();
  await byTestId('debrief-performance-increment').click();
  await byTestId('debrief-performance-increment').click();
  await byTestId('debrief-stress-decrement').click();
  await clickText('No');
  await shot('16-debrief-filled');
  await tallShot('16b-debrief-full', 3200);
  log('Debrief', `ratings ${JSON.stringify(values)}, workload score ${score}`);
  await byTestId('debrief-submit').click();

  // ---------------------------------------------------------------- Session detail
  await byTestId('session-detail').waitFor({ timeout: 15000 });
  await byTestId('session-hr-chart').waitFor();
  await sleep(1200);
  await shot('17-session-detail');
  await tallShot('17b-session-detail-full', 4200);
  const chartLabel = await byTestId('session-hr-chart-plot').getAttribute('aria-label');
  const svgCount = await page.locator('[data-testid="session-hr-chart-plot"] svg path, [data-testid="session-hr-chart-plot"] svg polyline').count();
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem('surgeonpulse.sessions.v1') ?? '';
    const found = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        if (Array.isArray(v.events) && v.procedure && !(v.tags ?? []).includes('demo')) found.push(v);
        Object.values(v).forEach(walk);
      }
    };
    try { walk(JSON.parse(raw)); } catch { /* ignore */ }
    const s = found[0];
    return s ? { status: s.status, events: s.events.map((e) => `${e.phase ?? e.marker}/${e.loggedBy}`), hasPostOp: !!s.postOp, baseline: s.baseline?.restingHr } : null;
  });
  if (!saved || saved.events.join() !== 'incision/team,critical/team,complication/self') throw new Error(`Unexpected saved events: ${JSON.stringify(saved)}`);
  log('Session detail', `chart "${chartLabel}"; svg paths ${svgCount}; stored ${JSON.stringify(saved)}`);

  // ---------------------------------------------------------------- Insights
  // Back to tabs via the header back button, then the Insights tab.
  const back = page.getByRole('button', { name: /back/i }).first();
  if (await back.isVisible().catch(() => false)) await back.click();
  else await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await byTestId('record-home').waitFor({ timeout: 10000 });
  await shot('18-record-home-after');
  await page.getByRole('tab', { name: /Insights/ }).first().click().catch(async () => clickText('Insights'));
  await byTestId('insights').waitFor();
  await shot('19-insights-before-demo');
  await page.getByText('Load demo data', { exact: true }).last().click();
  // The case recorded above used the simulator, so it is practice data too: Insights shows the simulated sessions,
  // clearly labelled, and never as "your" cases.
  await page.waitForFunction(() => /Patterns across (\d{2,}) simulated sessions/.test(document.body.innerText), null, { timeout: 30000 });
  if (!(await byTestId('insights-demo-banner').isVisible())) throw new Error('Insights: demo data shown without the demo banner');
  await sleep(1500);
  await shot('20-insights-demo');
  await tallShot('20b-insights-full', 3000);
  const insightCount = await page.locator('[data-testid^="insight-"]').count();
  await byTestId('insights-metric-rmssd').click();
  await sleep(800);
  await tallShot('21-insights-rmssd', 3000);
  const trendLabel = await byTestId('insights-trend-plot').getAttribute('aria-label');
  log('Insights', `demo loaded, ${insightCount} insight cards; trend label "${trendLabel}"`);

  // ---------------------------------------------------------------- History + Settings
  await page.getByRole('tab', { name: /History/ }).first().click();
  await sleep(1200);
  await shot('22-history');
  await page.getByRole('tab', { name: /Settings/ }).first().click();
  await sleep(1200);
  await shot('23-settings');
  await tallShot('23b-settings-full', 3400);
  log('Settings', 'rendered');

  // ---------------------------------------------------------------- Reload persistence
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /History/ }).first().click();
  await page.getByText('Laparoscopic cholecystectomy').first().waitFor({ timeout: 10000 });
  log('Reload', 'session persisted in localStorage');
} catch (e) {
  await shot('zz-failure').catch(() => {});
  console.error('FLOW FAILED at step after:', steps[steps.length - 1] ?? '(start)');
  console.error(e);
  process.exitCode = 1;
} finally {
  console.log('\nConsole errors/warnings:', consoleIssues.length);
  for (const c of consoleIssues) console.log('  ', c.slice(0, 400));
  if (consoleIssues.length > 0) process.exitCode = 1;
  await browser.close();
}
