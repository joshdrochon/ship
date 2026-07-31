/**
 * Corroboration for F16: prove the /my-week future-day rows actually render at scan
 * time, and report the *composited* colour axe would sample for each label inside them.
 * A "0 contrast nodes" result is only meaningful if the offending rows were on screen.
 *
 *   node docs/audit/scripts/verify-myweek-contrast.mjs > docs/audit/raw/cat7-f16-myweek-composited.json
 *
 * Why this exists as well as the axe run: how many "Upcoming" rows /my-week renders
 * depends on what day it is (a scan on a Monday sees five, a Sunday none), so a raw node
 * count is not stable across days. `ancestorOpacityProduct` and the painted colour are.
 * The failing state produced 0.4 and 2.09:1; the fixed state produces 1 and 7.25:1
 * whatever the calendar is doing.
 *
 * PREREQUISITE: dev servers already running and seeded on :5173 / :3000.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';

const page = await (await (await chromium.launch()).newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.locator('#email').fill('dev@ship.local');
await page.locator('#password').fill('admin123');
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForURL((u) => !/\/login|\/setup/.test(u.pathname), { timeout: 15000 });
await page.goto(`${BASE}/my-week`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return +((x + 0.05) / (y + 0.05)).toFixed(2);
  };
  // Effective alpha at an element = product of every ancestor's `opacity`.
  const chainOpacity = (el) => {
    let a = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      a *= parseFloat(getComputedStyle(n).opacity || '1');
    }
    return +a.toFixed(3);
  };
  const composite = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));

  const rows = [...document.querySelectorAll('div,a,button')].filter((el) =>
    [...el.children].some((c) => c.textContent?.trim() === 'Upcoming' || c.querySelector?.('span')?.textContent?.trim() === 'Upcoming'),
  );
  const upcoming = [...document.querySelectorAll('span')].filter((s) => s.textContent?.trim() === 'Upcoming');
  const pageBg = parse(getComputedStyle(document.body).backgroundColor);

  const labels = [];
  for (const span of upcoming) {
    const row = span.closest('div.flex.items-center');
    for (const el of row ? row.querySelectorAll('span') : [span]) {
      const cs = getComputedStyle(el);
      const alpha = chainOpacity(el);
      const fg = parse(cs.color);
      const painted = composite(fg, pageBg, alpha);
      labels.push({
        text: el.textContent.trim(),
        declaredColor: cs.color,
        ancestorOpacityProduct: alpha,
        paintedColor: `rgb(${painted.join(', ')})`,
        contrastVsPageBg: contrast(painted, pageBg),
      });
    }
  }
  return {
    futureRowsRendered: upcoming.length,
    rowClassName: rows[0] ? rows[0].className : null,
    pageBackground: `rgb(${pageBg.join(', ')})`,
    labels,
  };
});

console.log(JSON.stringify({ generated_at: new Date().toISOString(), base: BASE, route: '/my-week', ...result }, null, 2));
process.exit(0);
