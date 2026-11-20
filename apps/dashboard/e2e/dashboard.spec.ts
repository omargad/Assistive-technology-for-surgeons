import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/cohort-small.json', import.meta.url));

/**
 * Path to a small cohort export. Uses the shared fixture when present;
 * otherwise (or with E2E_GENERATE_COHORT=1) generates an equivalent bundle
 * with the core simulator.
 */
async function cohortFile(): Promise<string> {
  if (existsSync(FIXTURE) && !process.env.E2E_GENERATE_COHORT) return FIXTURE;
  const core = await import('@surgeonpulse/core');
  const cohort = core.simulateCohort({ seed: 2026, participants: 3, sessionsPerParticipant: 4 });
  const bundle = core.createExportBundle({ ...cohort, now: Date.UTC(2026, 6, 1) });
  const dir = await mkdtemp(join(tmpdir(), 'surgeonpulse-e2e-'));
  const file = join(dir, 'cohort-small.json');
  await writeFile(file, JSON.stringify(bundle));
  return file;
}

async function waitForSummaries(page: Page): Promise<void> {
  await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 45_000 });
}

async function loadDemo(page: Page): Promise<void> {
  await page.goto('./#/data');
  await page.getByTestId('load-demo').click();
  await expect(page).toHaveURL(/#\/overview$/);
  await waitForSummaries(page);
}

function kpi(page: Page, label: string) {
  return page.getByTestId('kpis').locator('.kpi', { hasText: label }).locator('.kpi__value');
}

test.describe('SurgeonPulse dashboard', () => {
  test('research workflow: demo → overview → sessions → detail → feedback → analysis → export → import', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('./');
    await expect(page).toHaveTitle('SurgeonPulse Dashboard');

    // Load demo data → overview KPIs.
    await loadDemo(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(kpi(page, 'Participants')).toHaveText('8');
    await expect(kpi(page, 'Sessions')).toHaveText('96');
    await expect(kpi(page, 'Hours recorded')).toContainText(/\d+\.\d/);
    await expect(page.locator('.sidebar').getByText('Simulated')).toBeVisible();
    await expect(page.getByTestId('phase-delta-chart').locator('svg').first()).toBeVisible();
    // The chart frame is one image with a text alternative (Recharts' own SVG sits inside it).
    await expect(page.getByTestId('phase-delta-chart').locator('.chart__plot[role="img"]')).toHaveAttribute('aria-label', /Critical step/);

    // Sessions table: sort and filter.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sessions' }).click();
    await expect(page).toHaveURL(/#\/sessions$/);
    const table = page.getByTestId('sessions-table');
    await expect(table.locator('tbody tr')).toHaveCount(96);

    const meanHrHeader = table.getByRole('columnheader', { name: /Mean HR/ });
    await meanHrHeader.getByRole('button').click();
    await expect(meanHrHeader).toHaveAttribute('aria-sort', 'ascending');
    const meanHrIndex = await table.locator('thead th').evaluateAll((ths) =>
      ths.findIndex((th) => th.textContent?.includes('Mean HR')),
    );
    const values = (await table.locator(`tbody tr > :nth-child(${meanHrIndex + 1})`).allTextContents()).map(Number);
    expect(values.length).toBe(96);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    await meanHrHeader.getByRole('button').click();
    await expect(meanHrHeader).toHaveAttribute('aria-sort', 'descending');

    await page.getByLabel('Participant').selectOption('SIM-003');
    await expect(table.locator('tbody tr')).toHaveCount(12);
    await expect(page.getByText('Showing 12 of 96 sessions')).toBeVisible();
    await page.getByLabel('Search').fill('no-such-procedure');
    await expect(table.getByText('No sessions match the filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(96);

    // Session detail: HR timeline chart with phases.
    await table.locator('tbody tr').first().getByRole('link').click();
    await expect(page).toHaveURL(/#\/sessions\/[0-9a-f-]+$/);
    const timeline = page.getByTestId('hr-timeline');
    await expect(timeline.locator('svg.recharts-surface').first()).toBeVisible();
    await expect(timeline.locator('.recharts-reference-area').first()).toBeAttached();
    await expect(timeline.locator('.recharts-brush')).toBeAttached();
    await expect(timeline.locator('.chart__plot[role="img"]')).toHaveAttribute('aria-label', /Heart rate over/);
    await timeline.getByRole('button', { name: 'View as table' }).click();
    await expect(timeline.getByRole('table').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Phases' })).toBeVisible();

    // Participant feedback view (from the breadcrumb).
    const code = (await page.locator('.page-header__eyebrow a').nth(1).textContent())!.trim();
    await page.locator('.page-header__eyebrow a').nth(1).click();
    await expect(page).toHaveURL(new RegExp(`#/participants/${code}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Feedback for ${code}`);
    await expect(page.getByTestId('learning-curve').locator('svg.recharts-surface').first()).toBeVisible();
    await expect(page.getByTestId('phase-profile')).toContainText('Cohort median');
    await page.getByLabel('Metric').selectOption('workload');
    await expect(page.getByTestId('learning-curve')).toContainText('Workload');
    const bodyText = await page.locator('main').innerText();
    for (let i = 1; i <= 8; i++) {
      const other = `SIM-00${i}`;
      if (other !== code) expect(bodyText).not.toContain(other);
    }

    // Analysis: change the group-by.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Analysis' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Analysis' })).toBeVisible();
    const groupTable = page.getByTestId('group-table');
    await expect(groupTable.locator('thead')).toContainText('Training level');
    await page.getByLabel('Group by').selectOption('procedure');
    await expect(groupTable.locator('thead')).toContainText('Procedure');
    expect(await groupTable.locator('tbody tr').count()).toBeGreaterThan(5);
    await expect(page.getByTestId('group-chart').locator('svg.recharts-surface').first()).toBeVisible();
    await expect(page.getByTestId('analysis-scatter')).toContainText('Pearson r');
    await expect(page.locator('textarea.summary-text')).toHaveValue(/by procedure/);

    // Export: summaries CSV download.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Export' }).click();
    await expect(page.getByTestId('column-dictionary')).toContainText('mean_hr_delta');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-summaries').click()]);
    expect(download.suggestedFilename()).toMatch(/^surgeonpulse-summaries-\d{8}-\d{4}\.csv$/);
    const csv = await readFile((await download.path())!, 'utf8');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]!.startsWith('session_id,participant_code,')).toBe(true);
    expect(lines).toHaveLength(97);

    // Import the small cohort via the file input (replaces the simulated demo).
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Data' }).click();
    await page.getByTestId('file-input').setInputFiles(await cohortFile());
    await expect(page).toHaveURL(/#\/overview$/);
    await waitForSummaries(page);
    await expect(kpi(page, 'Sessions')).toHaveText('12');
    await expect(kpi(page, 'Participants')).toHaveText('3');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Data' }).click();
    await expect(page.getByText('cohort-small.json')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('first run shows empty states that point to the Data page', async ({ page }) => {
    for (const path of ['sessions', 'participants', 'analysis', 'export']) {
      await page.goto(`./#/${path}`);
      await expect(page.getByText('No data loaded yet')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to Data' })).toHaveAttribute('href', '#/data');
    }
    await page.goto('./#/overview');
    await expect(page.getByRole('heading', { name: 'Welcome to the SurgeonPulse dashboard' })).toBeVisible();
    await page.goto('./#/nowhere');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });

  test('research server: bearer token, token kept in memory only', async ({ page }) => {
    const bundle = await readFile(await cohortFile(), 'utf8');
    let authorization = '';
    await page.route('https://study.example.edu/api/v1/export', async (route) => {
      authorization = route.request().headers().authorization ?? '';
      await route.fulfill({ status: 200, contentType: 'application/json', body: bundle, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto('./#/data');
    await page.getByLabel('Server URL').fill('https://study.example.edu/');
    await page.getByLabel('Admin token').fill('test-admin-token-with-at-least-32-chars');
    await page.getByRole('button', { name: /Connect/ }).click();
    await expect(page).toHaveURL(/#\/overview$/);
    await waitForSummaries(page);
    await expect(kpi(page, 'Sessions')).toHaveText('12');
    expect(authorization).toBe('Bearer test-admin-token-with-at-least-32-chars');
    const stored = await page.evaluate(() => ({ ...localStorage }));
    expect(stored['surgeonpulse.dashboard.serverUrl']).toBe('https://study.example.edu/');
    expect(JSON.stringify(stored)).not.toContain('test-admin-token');

    // A rejected token shows a friendly error.
    await page.route('https://study.example.edu/api/v1/export', (route) => route.fulfill({ status: 401, body: '{"error":"unauthorized"}' }));
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Data' }).click();
    await page.getByRole('button', { name: /Connect/ }).click();
    await expect(page.getByRole('alert')).toContainText('rejected the token');
  });

  test('tablet layout: sidebar becomes a top bar under 900 px with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await loadDemo(page);
    const direction = await page.locator('.nav__list').evaluate((el) => getComputedStyle(el).flexDirection);
    expect(direction).toBe('row');
    const sidebarBox = await page.locator('.sidebar').boundingBox();
    expect(sidebarBox!.width).toBeGreaterThan(800);
    expect(sidebarBox!.height).toBeLessThan(160);
    for (const path of ['overview', 'sessions', 'analysis', 'export', 'data']) {
      await page.goto(`./#/${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
  });

  test('theme toggle switches to dark mode and keyboard users can skip to content', async ({ page }) => {
    await page.goto('./#/overview');
    await page.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(15, 20, 25)');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Tab');
    const skip = page.getByRole('button', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });
});
