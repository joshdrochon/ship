#!/usr/bin/env node
/**
 * Category 7 — builds the expected screen-reader traversal map for each page.
 *
 * This is preparation for measure-screenreader.mjs, not a measurement of its own.
 * It reads the accessibility tree headlessly (seconds, no VoiceOver, no focus
 * stealing) and emits the ordered sequence of role + accessible name a screen
 * reader cursor should encounter walking the page front to back.
 *
 * Why bother, when the VoiceOver pass could just step blindly:
 *
 *   1. Step count stops being a guess. The VoiceOver walk previously took a fixed
 *      45 steps per page — arbitrary, and either short of the end or wasting
 *      round-trips past it. The map gives the real number.
 *   2. A stall becomes attributable. "The cursor repeated 4 times" is weak on its
 *      own; "the cursor repeated 4 times where the map expected treeitem ->
 *      button -> link" names the element it is stuck on.
 *   3. It exposes SKIPPED nodes, which a blind walk cannot detect at all. If the
 *      tree contains a control and VoiceOver never announces it, that control is
 *      unreachable by screen reader — a finding, and invisible without a map to
 *      diff against.
 *
 * What it is NOT: evidence about VoiceOver. The tree is what a screen reader
 * consumes, not what it says. Nothing in this file may be reported as a
 * screen-reader result — that is measure-screenreader.mjs's job.
 *
 * Requires the app running: web :5173.
 *
 *   node docs/audit/scripts/map-a11y-traversal.mjs --out docs/audit/raw/cat7-traversal-map.json
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';

// Matches the surfaces measure-screenreader.mjs walks, in the same order.
const PAGES = [
  ['login', '/login'],
  ['docs home', '/docs'],
  ['document editor', `/docs/${DOC_ID}`],
  ['workspace settings', '/settings'],
];

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-traversal-map.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Roles a VoiceOver cursor stops on when walking with VO+Right. Structural
// wrappers (generic, none, paragraph containers) are not cursor stops and would
// inflate the expected step count if counted.
const CURSOR_STOPS = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
  'spinbutton', 'searchbox', 'treeitem', 'heading', 'img', 'image', 'cell',
  'columnheader', 'rowheader', 'text', 'paragraph', 'listitem', 'article',
]);

const LANDMARKS = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search',
]);

/**
 * ariaSnapshot() returns indented YAML like:
 *   - banner:
 *     - link "Ship"
 *     - button
 * Parse it into an ordered flat list, preserving document order — which is the
 * order a screen reader cursor traverses.
 */
function parseSnapshot(yaml) {
  const out = [];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\s*)-\s+([a-zA-Z]+)(?:\s+"([^"]*)")?/);
    if (!m) continue;
    const [, indent, role, name] = m;
    out.push({ role, name: (name ?? '').trim(), depth: Math.floor(indent.length / 2) });
  }
  return out;
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'dev@ship.local').catch(() => {});
  await page.fill('input[type="password"]', 'admin123').catch(() => {});
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {});
  await sleep(2000);
}

async function dismiss(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(350);
  }
}

async function mapPage(page, label, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await sleep(1200);
  await dismiss(page);
  await sleep(400);

  const yaml = await page.locator('body').ariaSnapshot();
  const nodes = parseSnapshot(yaml);
  const stops = nodes.filter((n) => CURSOR_STOPS.has(n.role));

  return {
    page: label, path,
    totalNodes: nodes.length,
    expectedCursorStops: stops.length,
    // What to hand measure-screenreader.mjs as its step budget. Slightly over the
    // expected stops so the walk can run past the end and confirm it reached it,
    // rather than stopping short and leaving the tail unmeasured.
    suggestedSteps: Math.ceil(stops.length * 1.15) + 5,
    landmarks: nodes.filter((n) => LANDMARKS.has(n.role)).map((n) => n.role),
    headings: nodes.filter((n) => n.role === 'heading').map((n) => n.name || '(unnamed)'),
    unnamedStops: stops.filter((n) => !n.name).length,
    unnamedByRole: stops.filter((n) => !n.name).reduce((a, n) => {
      a[n.role] = (a[n.role] ?? 0) + 1; return a;
    }, {}),
    // The map itself: what the cursor should meet, in order.
    expectedOrder: stops.map((n, i) => ({ step: i + 1, role: n.role, name: n.name })),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const out = { generated: new Date().toISOString(), base: BASE, pages: [] };
  let authed = false;
  for (const [label, path] of PAGES) {
    // /login has to be mapped before authenticating — PublicRoute redirects a
    // logged-in visitor to /docs (web/src/main.tsx:104), so mapping it after login
    // silently produces a second copy of /docs under the label "login".
    if (path !== '/login' && !authed) { await login(page); authed = true; }
    const r = await mapPage(page, label, path);
    if (path === '/login' && page.url && !String(r.path).includes('login')) {
      throw new Error('Redirected away from /login — map it before authenticating.');
    }
    out.pages.push(r);
    console.log(
      `${label.padEnd(20)} ${String(r.expectedCursorStops).padStart(4)} cursor stops · ` +
      `${r.headings.length} headings · ${r.landmarks.length} landmarks · ` +
      `${r.unnamedStops} unnamed · suggested steps: ${r.suggestedSteps}`
    );
  }

  out.totals = {
    expectedCursorStops: out.pages.reduce((n, p) => n + p.expectedCursorStops, 0),
    suggestedSteps: out.pages.reduce((n, p) => n + p.suggestedSteps, 0),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log(`Total VoiceOver steps needed: ${out.totals.suggestedSteps} ` +
              `(the blind walk used 180 for the same four pages).`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
