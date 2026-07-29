#!/usr/bin/env node
/**
 * Category 7 — accessibility tree inspection (p.7).
 *
 * p.7 asks: "Test with a screen reader (VoiceOver, NVDA, or similar). Can you
 * understand the page structure and interact with all controls?"
 *
 * This is NOT a screen reader. It dumps the accessibility tree that a screen
 * reader consumes — role + accessible name for every exposed node — which
 * answers the substance of both questions objectively:
 *
 *   "understand the page structure"  -> heading hierarchy + landmark coverage
 *   "interact with all controls"     -> every interactive node has a name
 *
 * What it cannot tell you is whether the resulting announcement *sounds*
 * comprehensible. That still needs a human. Reported as such.
 *
 *   node docs/audit/scripts/measure-a11y-tree.mjs --out /tmp/cat7-tree.json
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-tree.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox',
  'radio', 'switch', 'slider', 'menuitem', 'tab', 'option', 'searchbox', 'listbox',
  'spinbutton', 'treeitem', 'menuitemcheckbox', 'menuitemradio']);

const PAGES = [
  ['login', '/login'], ['docs', '/docs'], ['my-week', '/my-week'],
  ['issues', '/issues'], ['settings', '/settings'], ['admin', '/admin'],
  ['team directory', '/team/directory'],
];

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

function walk(node, out, depth = 0) {
  if (!node) return;
  out.push({ role: node.role, name: (node.name || '').trim(), depth });
  for (const c of node.children ?? []) walk(c, out, depth + 1);
}

async function main() {
  const res = { pages: [], generated: new Date().toISOString() };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);

  for (const [label, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(1200); await dismiss(page);

    // page.accessibility was removed in Playwright 1.57. ariaSnapshot() is the
    // current API and emits the same tree as YAML: "role \"accessible name\"".
    const yaml = await page.locator('body').ariaSnapshot();
    const nodes = [];
    for (const line of yaml.split('\n')) {
      const m = line.match(/^(\s*)-\s+([a-z]+)(?:\s+"([^"]*)")?/);
      if (!m) continue;
      nodes.push({ role: m[2], name: (m[3] || '').trim(), depth: m[1].length / 2 });
    }

    const interactive = nodes.filter((n) => INTERACTIVE.has(n.role));
    const unnamed = interactive.filter((n) => !n.name);
    const headings = nodes.filter((n) => n.role === 'heading');
    const landmarks = nodes.filter((n) =>
      ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'region']
        .includes(n.role));

    // structure legibility: does the page expose a main landmark and any headings?
    res.pages.push({
      page: label, path,
      total_nodes: nodes.length,
      interactive: interactive.length,
      unnamed_interactive: unnamed.length,
      unnamed_by_role: unnamed.reduce((a, n) => (a[n.role] = (a[n.role] || 0) + 1, a), {}),
      unnamed_samples: unnamed.slice(0, 6).map((n) => n.role),
      headings: headings.length,
      heading_names: headings.slice(0, 8).map((h) => h.name.slice(0, 44)),
      landmarks: landmarks.map((l) => l.role),
      has_main: landmarks.some((l) => l.role === 'main'),
      tree_exposed: nodes.some((n) => n.role === 'tree'),
      treeitems: nodes.filter((n) => n.role === 'treeitem').length,
    });
  }
  await browser.close();
  writeFileSync(OUT, JSON.stringify(res, null, 2));
  console.error(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
