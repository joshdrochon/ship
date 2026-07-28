#!/usr/bin/env node
/**
 * Category 7 — keyboard navigation, the keys Tab-traversal could not cover (p.7).
 *
 * p.7 asks: "can you reach every interactive element using only Tab, Enter,
 * Escape, and arrow keys?" measure-a11y.py covers Tab reachability and Escape.
 * This covers ENTER, SPACE and ARROW keys, which can only reveal further
 * failures, never fewer.
 *
 *   node docs/audit/scripts/measure-keyboard.mjs --out /tmp/cat7-keys.json
 *
 * Requires the app running on :5173.
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-keys.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const active = (page) => page.evaluate(() => {
  const e = document.activeElement;
  if (!e) return null;
  return { tag: e.tagName, role: e.getAttribute('role'),
           text: (e.textContent || '').trim().slice(0, 40),
           id: e.id || null };
});

async function main() {
  const out = { arrow_keys: [], enter_space: [], focus_visible: [], notes: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);

  // --- ARROW KEYS on composite widgets -----------------------------------
  // ARIA authoring practices require roving focus via arrow keys for
  // tree / listbox / menu / tablist. Focus a member, press the arrow, see if
  // focus actually moves.
  for (const [label, path] of [['docs tree', '/docs'], ['issues list', '/issues'],
                               ['team', '/team/directory'], ['weeks', '/weeks']]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(1200); await dismiss(page);
    const widgets = await page.evaluate(() =>
      ['tree', 'listbox', 'menu', 'menubar', 'tablist', 'grid', 'radiogroup']
        .flatMap((r) => [...document.querySelectorAll(`[role="${r}"]`)].map(() => r)));
    for (const role of [...new Set(widgets)]) {
      const memberRole = { tree: 'treeitem', listbox: 'option', menu: 'menuitem',
        menubar: 'menuitem', tablist: 'tab', grid: 'gridcell', radiogroup: 'radio' }[role];
      const member = page.locator(`[role="${memberRole}"]`).first();
      if (!(await member.count())) continue;
      await member.evaluate((el) => el.focus?.()).catch(() => {});
      const before = await active(page);
      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
        await page.keyboard.press(key); await sleep(180);
      }
      const after = await active(page);
      out.arrow_keys.push({
        page: label, widget_role: role, member_role: memberRole,
        focus_before: before, focus_after: after,
        focus_moved: JSON.stringify(before) !== JSON.stringify(after),
      });
    }
  }

  // --- ENTER / SPACE activation ------------------------------------------
  for (const [label, path] of [['docs', '/docs'], ['issues', '/issues'], ['my-week', '/my-week']]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(1200); await dismiss(page);
    for (const key of ['Enter', 'Space']) {
      // Tab to the first genuinely interactive control, then activate it.
      await page.evaluate(() => document.body.focus());
      let target = null;
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab'); await sleep(70);
        const a = await active(page);
        if (a && (a.tag === 'BUTTON' || a.role === 'button')) { target = a; break; }
      }
      if (!target) { out.notes.push(`${label}/${key}: no button reached in 25 tabs`); continue; }
      const urlBefore = page.url();
      const domBefore = await page.evaluate(() => document.body.innerHTML.length);
      await page.keyboard.press(key === 'Space' ? ' ' : key).catch(() => {});
      await sleep(1000);
      const changed = page.url() !== urlBefore ||
        Math.abs(await page.evaluate(() => document.body.innerHTML.length) - domBefore) > 50;
      out.enter_space.push({ page: label, key, target: target.text || target.tag, activated: changed });
      await dismiss(page);
    }
  }

  // --- FOCUS VISIBILITY ---------------------------------------------------
  // W7-7 flagged the repo's own test as tautological. Measure it properly:
  // does the focused element differ visually from its unfocused state?
  for (const [label, path] of [['docs', '/docs'], ['issues', '/issues']]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(1000); await dismiss(page);
    const res = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
        .filter((e) => e.offsetParent).slice(0, 40);
      let noIndicator = 0, checked = 0;
      for (const el of els) {
        const base = getComputedStyle(el);
        const b = { o: base.outlineStyle, w: base.outlineWidth, s: base.boxShadow,
                    bg: base.backgroundColor, bc: base.borderColor };
        el.focus();
        const f = getComputedStyle(el);
        const changed = f.outlineStyle !== b.o || f.outlineWidth !== b.w ||
                        f.boxShadow !== b.s || f.backgroundColor !== b.bg ||
                        f.borderColor !== b.bc;
        checked++; if (!changed) noIndicator++;
        el.blur();
      }
      return { checked, noIndicator };
    });
    out.focus_visible.push({ page: label, ...res });
  }

  await browser.close();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
