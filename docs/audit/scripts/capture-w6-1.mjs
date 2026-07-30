#!/usr/bin/env node
/**
 * W6-1 evidence — "six top-level routes have no error boundary. A render error on
 * any of these unmounts to a blank white page with no recovery path."
 *
 * Run `inject-render-error.mjs --apply` first: it makes each of those six pages
 * throw when the URL carries `?__boom`. This script then visits each route with
 * `?__boom`, and for each one records
 *   - whether anything at all is left rendered (the white-page symptom),
 *   - whether a recovery affordance exists (a button/link the user can act on),
 * and screenshots the result.
 *
 *   BASE=http://localhost:5174 node docs/audit/scripts/capture-w6-1.mjs \
 *     --label before --outdir docs/audit/evidence/w6-1
 *
 * The two routes that matter most are `/feedback/:programId` and `/login`: both
 * are reachable by people who cannot be told to "try refreshing". Authenticated
 * admin routes are attempted too and recorded as `reached: false` when the app
 * redirects the test user away before the page renders.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const LABEL = arg('--label', 'run');
const OUTDIR = arg('--outdir', '/tmp/w6-1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// programId/token values only have to be well formed; the throw fires before use.
// `auth` routes need a session: SuperAdminRoute redirects an anonymous visitor to
// /login before the page renders, and PublicRoute redirects a signed-in visitor
// away from /login and /setup — so the two groups need separate contexts.
const ROUTES = [
  ['feedback', '/feedback/00000000-0000-0000-0000-000000000000', 'anon'],
  ['login', '/login', 'anon'],
  ['setup', '/setup', 'anon'],
  ['invite', '/invite/test-token', 'anon'],
  ['admin', '/admin', 'auth'],
  ['admin-workspace', '/admin/workspaces/00000000-0000-0000-0000-000000000000', 'auth'],
];

/** dev@ship.local is the seeded super admin (api/src/db/seed.ts). */
async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'dev@ship.local').catch(() => {});
  await page.fill('input[type="password"]', 'admin123').catch(() => {});
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"]').catch(() => {}),
  ]);
  await sleep(1500);
  return !page.url().includes('/login');
}

async function caption(page, lines, tone) {
  await page.evaluate(({ lines, tone }) => {
    document.getElementById('__cap')?.remove();
    const el = document.createElement('div');
    el.id = '__cap';
    el.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
      font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px 14px;white-space:pre;
      background:${tone === 'bad' ? 'rgba(127,29,29,.97)' : 'rgba(6,78,59,.97)'};
      color:#fff;border-top:2px solid ${tone === 'bad' ? '#ef4444' : '#22c55e'};`;
    el.textContent = lines.join('\n');
    document.body.appendChild(el);
  }, { lines, tone });
}

async function main() {
  mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const anonCtx = await browser.newContext({ viewport: { width: 1000, height: 620 } });
  const authCtx = await browser.newContext({ viewport: { width: 1000, height: 620 } });
  const anonPage = await anonCtx.newPage();
  const authPage = await authCtx.newPage();
  const loggedIn = await login(authPage);
  if (!loggedIn) console.error('warning: super-admin login failed; /admin rows will read reached=false');

  const results = [];
  for (const [name, path, who] of ROUTES) {
    const page = who === 'auth' ? authPage : anonPage;
    const errors = [];
    const onPageError = (e) => errors.push(String(e.message).slice(0, 120));
    page.on('pageerror', onPageError);

    await page.goto(`${BASE}${path}?__boom`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    await sleep(1800);

    const landedOn = new URL(page.url()).pathname;
    const reached = errors.some((e) => e.includes('W6-1 injected render error'));

    const probe = await page.evaluate(() => {
      const root = document.getElementById('root');
      const text = (root?.innerText ?? '').trim();
      const actionable = Array.from(
        root?.querySelectorAll('button, a[href], [role="button"]') ?? []
      ).filter((el) => (el.offsetParent !== null)).map((el) => el.textContent?.trim()).filter(Boolean);
      return { rootTextLength: text.length, textSample: text.slice(0, 160), actionable: actionable.slice(0, 6) };
    });

    const blank = probe.rootTextLength === 0;
    const row = {
      route: path, name, as: who, reached, landedOn,
      blank_screen: blank,
      root_text_length: probe.rootTextLength,
      text_sample: probe.textSample,
      recovery_affordances: probe.actionable,
      has_recovery_path: probe.actionable.length > 0,
      page_errors: errors.slice(0, 3),
    };
    results.push(row);

    await caption(page, [
      `W6-1 · ${LABEL} · ${path}?__boom  (render error injected)`,
      reached ? 'the page component threw during render' : 'the page component did not render (redirected before the throw)',
      `#root text length: ${probe.rootTextLength}${blank ? '  -> BLANK WHITE PAGE' : ''}`,
      `recovery affordances offered: ${probe.actionable.length ? probe.actionable.join(' | ') : 'none'}`,
    ], blank || (reached && !row.has_recovery_path) ? 'bad' : 'good');
    await page.screenshot({ path: join(OUTDIR, `w6-1-${LABEL}-${name}.png`) });

    page.off('pageerror', onPageError);
  }

  const considered = results.filter((r) => r.reached);
  const summary = {
    label: LABEL,
    routes_tested: results.length,
    routes_where_the_throw_rendered: considered.length,
    blank_white_pages: considered.filter((r) => r.blank_screen).length,
    with_recovery_path: considered.filter((r) => r.has_recovery_path).length,
  };
  writeFileSync(join(OUTDIR, `w6-1-${LABEL}.json`), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, results }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
