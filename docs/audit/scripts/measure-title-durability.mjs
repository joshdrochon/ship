#!/usr/bin/env node
/**
 * Lane 6b — how long is a typed title exposed before it is durable?
 *
 * W6-9 moved the title from a REST PATCH (throttled, so it fired repeatedly
 * *during* typing) to the collaboration server's `schedulePersist` debounce
 * (2s, and it RESETS on every update — api/src/collaboration/index.ts:189).
 * That raises a fair question: did a fix aimed at preventing data loss open a
 * durability gap in the other direction?
 *
 * This measures it instead of reasoning about it. Four scenarios:
 *
 *   A idle-flush     type, stop, measure last-keystroke -> column updated.
 *   B continuous     type without pausing for N seconds; sample the column
 *                    throughout. Does the debounce reset forever?
 *   C tab-close      type, then close the tab well inside the debounce window.
 *                    api/src/collaboration/index.ts:860-867 flushes immediately
 *                    when the last connection to a room drops, so the claim
 *                    "close the tab within 2s and you lose it" should be false.
 *   D process-kill   the residual risk: what is still only in server memory.
 *                    Reported as the measured exposure window, not simulated.
 *
 * The column is polled directly over pg, not through the API, so the number is
 * the durable-write time and not a cache.
 *
 *   BASE=http://localhost:5175 API=http://localhost:3002 \
 *   DB=postgresql://ship:ship_dev_password@localhost:5432/ship_lane_6b \
 *   DOC_ID=<wiki uuid> node docs/audit/scripts/measure-title-durability.mjs \
 *     --out docs/audit/raw/cat6-title-durability.json
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// `pg` is a dependency of the api workspace, not the repo root, so resolve it
// from there rather than adding a root dependency for a measurement script.
const require = createRequire(new URL('../../../api/package.json', import.meta.url));
const pg = require('pg');

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DB = process.env.DB ?? 'postgresql://ship:ship_dev_password@localhost:5432/ship_lane_6b';
const DOC_ID = process.env.DOC_ID;
const TITLE_SEL = 'textarea[placeholder="Untitled"]';
const USER = { email: 'dev@ship.local', password: 'admin123' };

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/cat6-title-durability.json';

if (!DOC_ID) {
  console.error('DOC_ID is required');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new pg.Pool({ connectionString: DB });

async function columnTitle() {
  const r = await pool.query('SELECT title FROM documents WHERE id = $1', [DOC_ID]);
  return r.rows[0]?.title ?? null;
}

async function setColumn(title) {
  await pool.query('UPDATE documents SET title = $2 WHERE id = $1', [DOC_ID, title]);
}

async function dismissModal(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

async function openDoc(browser) {
  const ctx = await browser.newContext();
  // Same switch the E2E fixture uses (e2e/fixtures/isolated-env.ts): the
  // action-items modal (W6-6) auto-opens over the title field and its overlay
  // swallows clicks.
  await ctx.addInitScript(() => {
    localStorage.setItem('ship:disableActionItemsModal', 'true');
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('#email').fill(USER.email);
  await page.locator('#password').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 });
  await page.goto(`${BASE}/documents/${DOC_ID}`);
  await page.locator('.ProseMirror').waitFor({ timeout: 15000 });
  await dismissModal(page);
  // Let the collaboration socket finish its initial sync, so we are measuring
  // the steady-state path and not the REST fallback in useCollaborativeTitle.
  await sleep(2500);
  return { ctx, page };
}

/** Poll the column until it equals `want`, or give up. Returns ms elapsed. */
async function waitForColumn(want, t0, budgetMs = 20000) {
  while (Date.now() - t0 < budgetMs) {
    if ((await columnTitle()) === want) return Date.now() - t0;
    await sleep(25);
  }
  return null;
}

const results = {};

const browser = await chromium.launch();

// ---------------------------------------------------------------- A: idle flush
{
  const marker = `DURA-A-${Date.now()}`;
  await setColumn('Durability Probe');
  const { ctx, page } = await openDoc(browser);

  const input = page.locator(TITLE_SEL);
  await input.click();
  await input.fill(marker);
  const t0 = Date.now(); // last keystroke
  const ms = await waitForColumn(marker, t0);

  results.idle_flush_ms = ms;
  results.idle_flush_note =
    ms === null ? 'never landed within 20s' : 'last keystroke -> durable column write';
  await ctx.close();
}

// ------------------------------------------------------- B: continuous typing
{
  const prefix = `DURA-B-${Date.now()}-`;
  await setColumn('Durability Probe');
  const { ctx, page } = await openDoc(browser);

  const input = page.locator(TITLE_SEL);
  await input.click();
  await input.fill(prefix);

  const TYPE_MS = 12000;
  const start = Date.now();
  const samples = [];
  let typed = 0;

  // Type one character every 150ms for TYPE_MS, sampling the column as we go.
  while (Date.now() - start < TYPE_MS) {
    await page.keyboard.type('x');
    typed++;
    if (typed % 4 === 0) {
      samples.push({ t: Date.now() - start, column: await columnTitle() });
    }
    await sleep(150);
  }
  const stoppedAt = Date.now();
  const during = samples.filter((s) => s.column && s.column.startsWith(prefix));

  const finalWant = prefix + 'x'.repeat(typed);
  const afterMs = await waitForColumn(finalWant, stoppedAt);

  results.continuous = {
    typed_for_ms: TYPE_MS,
    keystrokes: typed,
    samples_taken: samples.length,
    samples_showing_typed_text_during_typing: during.length,
    column_stale_for_entire_typing_session: during.length === 0,
    flush_after_typing_stopped_ms: afterMs,
    exposure_window_ms: afterMs === null ? null : TYPE_MS + afterMs,
  };
  await ctx.close();
}

// ------------------------------------------------------------- C: tab close
{
  const marker = `DURA-C-${Date.now()}`;
  await setColumn('Durability Probe');
  const { ctx, page } = await openDoc(browser);

  const input = page.locator(TITLE_SEL);
  await input.click();
  await input.fill(marker);

  // Close well inside the 2s debounce — the scenario "typed it and closed the
  // tab immediately".
  await sleep(300);
  const tClose = Date.now();
  await ctx.close();

  const ms = await waitForColumn(marker, tClose);
  results.tab_close = {
    closed_after_ms: 300,
    durable_after_close_ms: ms,
    survived: ms !== null,
  };
}

// ------------------------------------------------- D: residual exposure summary
results.residual_risk = {
  what_is_exposed: 'updates held only in the collaboration server\'s in-memory Y.Doc',
  lost_only_if: 'the API process dies before the debounced write',
  browser_tab_close: results.tab_close?.survived ? 'covered by immediate flush on last disconnect' : 'NOT covered',
};

results.meta = {
  base: BASE,
  doc_id: DOC_ID,
  debounce_ms_in_code: 2000,
  measured_at: new Date().toISOString(),
};

await browser.close();
await pool.end();

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`wrote ${OUT}`);
