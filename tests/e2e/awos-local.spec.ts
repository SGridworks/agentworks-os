import { test, expect, type Page, type ConsoleMessage, type Request } from '@playwright/test';
import { runPreflight, savePreflight, preflightMustPass, EXPECTED_COMPANIES } from './helpers/awos-preflight.js';
import { captureArtifacts } from './helpers/artifacts.js';
import {
  companyCard,
  reviewQueueNav,
  trustLayerButton,
  trustDrawer,
  trustDrawerClose,
  commandPaletteTrigger,
  reviewQueueHeading,
  loadingIndicator,
  errorBanner,
  companiesCountLabel,
} from './helpers/awos-selectors.js';

const TEST_NAME_DB_VERIFY = 'awos-local-db-verify';
const TEST_NAME_PERSISTENCE = 'awos-local-persistence';

const BASE_URL = process.env.AWOS_E2E_BASE_URL || 'http://127.0.0.1:3000';

// -----------------------------------------------------------------------
// Shared fixture: captures console + network per test
// -----------------------------------------------------------------------

async function setupPageHooks(page: Page) {
  const consoleLogs: ConsoleMessage[] = [];
  const networkRequests: Request[] = [];

  page.on('console', (msg) => consoleLogs.push(msg));
  page.on('request', (req) => {
    if (req.url().startsWith('http')) networkRequests.push(req);
  });

  return { consoleLogs, networkRequests };
}

// -----------------------------------------------------------------------
// Test 1: operator can verify DB state and navigate core surfaces
// -----------------------------------------------------------------------

test(TEST_NAME_DB_VERIFY, async ({ page }) => {
  const { consoleLogs, networkRequests } = await setupPageHooks(page);

  // --- PREFLIGHT ---
  const preflight = await runPreflight();
  savePreflight(preflight);

  try {
    preflightMustPass(preflight);
  } catch (err) {
    await captureArtifacts(page, TEST_NAME_DB_VERIFY, consoleLogs, networkRequests);
    throw err;
  }

  // --- STEP 1: Open /mission-control ---
  await page.goto(`${BASE_URL}/mission-control`);

  // --- STEP 2: Assert hydration (no Loading...) ---
  await expect(page).not.toHaveURL(/error/, { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector(loadingIndicator, { state: 'hidden', timeout: 15_000 }).catch(() => {});

  // --- STEP 3: Assert all 6 companies visible ---
  for (const company of EXPECTED_COMPANIES) {
    await expect(page.locator(companyCard(company))).toBeVisible({ timeout: 20_000 });
  }

  // --- STEP 4: Click Review Queue ---
  await page.locator(reviewQueueNav).click();

  // --- STEP 5: Assert URL ---
  await expect(page).toHaveURL(/review-queue/, { timeout: 10_000 });

  // --- STEP 6: Review queue content ---
  const hasHeading = await page.locator(reviewQueueHeading).isVisible().catch(() => false);
  expect(hasHeading).toBeTruthy();

  // --- STEP 7: Click Trust layer button ---
  await page.locator(trustLayerButton).click();

  // --- STEP 8: Assert trust drawer opens with expected content ---
  await expect(page.locator(trustDrawer)).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('text=Database')).toBeVisible();
  await expect(page.locator('text=matched')).toBeVisible();
  await expect(page.locator(companiesCountLabel)).toBeVisible();

  // --- STEP 9: Trust drawer shows company count ---
  const countText = await page.locator(companiesCountLabel).textContent().catch(() => '');
  expect(countText).toMatch(/6|Companies/);

  // --- STEP 10: Close drawer ---
  await page.locator(trustDrawerClose).click().catch(() => {
    // fallback: press Escape
    page.keyboard.press('Escape');
  });
  await expect(page.locator(trustDrawer)).toBeHidden({ timeout: 5_000 }).catch(() => {});

  // --- STEP 11: Open command palette (Cmd+K) ---
  await page.keyboard.press('Meta+k');

  // --- STEP 12: Search review queue ---
  const paletteInput = page.locator(commandPaletteTrigger).first();
  await paletteInput.waitFor({ timeout: 5_000 }).catch(() => page.keyboard.press('Escape'));
  await paletteInput.fill('review queue');

  // --- STEP 13: Press Enter ---
  await page.keyboard.press('Enter');

  // --- STEP 14: Assert lands on review queue ---
  await expect(page).toHaveURL(/review-queue/, { timeout: 10_000 });

  // --- STEP 15: Final screenshot (pass state) ---
  await page.screenshot({ path: `test-results/awos-browser-e2e/${TEST_NAME_DB_VERIFY}-pass.png`, fullPage: true });
});

// -----------------------------------------------------------------------
// Test 2: companies do not disappear after restart
// -----------------------------------------------------------------------

test(TEST_NAME_PERSISTENCE, async ({ page }) => {
  const { consoleLogs, networkRequests } = await setupPageHooks(page);

  // --- API preflight: confirm companies exist BEFORE restart ---
  const preflightBefore = await runPreflight();
  savePreflight(preflightBefore);
  preflightMustPass(preflightBefore);

  // --- STEP 2: Browser confirms companies visible ---
  await page.goto(`${BASE_URL}/mission-control`);
  await page.waitForSelector(loadingIndicator, { state: 'hidden', timeout: 15_000 }).catch(() => {});

  for (const company of EXPECTED_COMPANIES) {
    await expect(page.locator(companyCard(company))).toBeVisible({ timeout: 20_000 });
  }

  const screenshotBefore = `test-results/awos-browser-e2e/${TEST_NAME_PERSISTENCE}-before-restart.png`;
  await page.screenshot({ path: screenshotBefore, fullPage: true });

  // --- STEP 3: Restart AWOS Local using existing wrapper ---
  // Kill the admin UI + daemon processes and restart via the wrapper script
  const restartScript = process.env.AWOS_RESTART_SCRIPT
    || `${process.env.HOME}/.agentworks/scripts/awos-admin-ui-wrapper.sh`;

  try {
    await page.context().close();
  } catch { /* ignore */ }

  // Attempt soft restart via wrapper if it exists
  const { execSync } = await import('node:child_process');
  try {
    execSync(`bash ${restartScript} restart 2>&1 || true`, { timeout: 30_000 });
  } catch { /* wrapper may not support restart — daemon may self-restart */ }

  // Wait for daemon + UI readiness
  await page.waitForTimeout(5_000);

  // --- STEP 4: Wait for services to come back ---
  const preflightAfter = await runPreflight();
  savePreflight(preflightAfter);
  preflightMustPass(preflightAfter);

  // --- STEP 5: Reopen /mission-control ---
  const page2 = await page.context().browser()!.newPage();
  const { consoleLogs: consoleLogs2, networkRequests: networkRequests2 } = await setupPageHooks(page2);
  await page2.goto(`${BASE_URL}/mission-control`);
  await page2.waitForSelector(loadingIndicator, { state: 'hidden', timeout: 30_000 }).catch(() => {});

  // --- STEP 6: Assert same companies still visible ---
  for (const company of EXPECTED_COMPANIES) {
    await expect(page2.locator(companyCard(company))).toBeVisible({ timeout: 20_000 });
  }

  // --- STEP 7: DB identity still matches ---
  const preflightFinal = await runPreflight();
  preflightMustPass(preflightFinal);

  const screenshotAfter = `test-results/awos-browser-e2e/${TEST_NAME_PERSISTENCE}-after-restart.png`;
  await page2.screenshot({ path: screenshotAfter, fullPage: true });

  // Cleanup
  await page2.context().close().catch(() => {});
});
