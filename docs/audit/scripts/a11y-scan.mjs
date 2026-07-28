/**
 * Category 7 driver — axe-core scan + programmatic keyboard traversal.
 *
 * Invoked by measure-a11y.py. Not meant to be run directly (it writes a JSON
 * blob to stdout that the Python wrapper parses).
 *
 *   node docs/audit/scripts/a11y-scan.mjs --base http://localhost:5173 \
 *        --api http://localhost:3000 --out /tmp/a11y-raw.json
 *
 * Uses @playwright/test's bundled chromium (playwright-core) and the
 * @axe-core/playwright already declared in the root package.json, so nothing
 * new is installed.
 */
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:5173');
const OUT = arg('out', '/tmp/a11y-raw.json');
const EMAIL = arg('email', 'dev@ship.local');
const PASSWORD = arg('password', 'admin123');

// WCAG 2.1 AA + Section 508 — exactly the conformance claim under test.
const CLAIM_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'section508'];

// Elements a sighted keyboard user would expect to reach.
const FOCUSABLE_SEL = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
  '[tabindex]', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
  '[role="switch"]', '[role="combobox"]', '[role="option"]', '[role="slider"]',
  '[role="textbox"]', '[role="searchbox"]', '[role="treeitem"]',
].join(',');

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (page.url().includes('/setup')) {
    await page.locator('#name').fill('Dev User');
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#confirmPassword').fill(PASSWORD);
    await page.getByRole('button', { name: /create admin account/i }).click();
  } else {
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await page.waitForURL((u) => !/\/login|\/setup/.test(u.pathname), { timeout: 15000 });
  await page.waitForTimeout(1500);
}

/** Discover a real document id per document_type so routes are not hard-coded. */
async function discoverIds(page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/documents?limit=600', { credentials: 'include' });
    if (!res.ok) return {};
    const docs = await res.json();
    const byType = {};
    for (const d of Array.isArray(docs) ? docs : []) {
      if (!byType[d.document_type]) byType[d.document_type] = d.id;
    }
    return byType;
  });
}

/**
 * Programmatic keyboard traversal.
 *
 * Presses Tab repeatedly from document.body and records what actually receives
 * focus, then diffs that against every element a keyboard user would expect to
 * be able to reach. This substitutes for *part* of a manual keyboard pass — it
 * proves reachability, it does NOT prove operability (Enter/Space/arrow-key
 * behaviour) or that focus is visible.
 */
async function keyboardTraversal(page) {
  await page.evaluate(() => {
    // Stable identity for every element, so DOM nodes can be diffed across
    // the two passes without serialising the node itself.
    let n = 0;
    document.querySelectorAll('*').forEach((el) => {
      el.setAttribute('data-a11y-uid', String(n++));
    });
  });

  const expected = await page.evaluate((sel) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' &&
        s.display !== 'none' && Number(s.opacity) > 0.01;
    };
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (el.hasAttribute('disabled')) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (el.closest('[aria-hidden="true"]')) return;
      if (el.getAttribute('tabindex') === '-1') return;
      if (!vis(el)) return;
      out.push({
        uid: el.getAttribute('data-a11y-uid'),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        tabindex: el.getAttribute('tabindex') || '',
        name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
        html: el.outerHTML.slice(0, 160),
      });
    });
    return out;
  }, FOCUSABLE_SEL);

  const positiveTabindex = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[tabindex]').forEach((el) => {
      const t = Number(el.getAttribute('tabindex'));
      if (t > 0) out.push({ tabindex: t, html: el.outerHTML.slice(0, 160) });
    });
    return out;
  });

  // Start from the very top of the document.
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    document.body.focus();
  });

  // Enough headroom to walk the whole page and wrap, even on the 250+ stop pages.
  const maxTabs = Math.min(1400, Math.max(150, expected.length * 3 + 80));

  const order = [];
  const seen = new Set();
  let wrapped = false;
  let escapedToBody = 0;
  let truncated = true;
  let i = 0;
  for (; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const cur = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { uid: null, tag: 'body' };
      return {
        uid: el.getAttribute('data-a11y-uid'),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
      };
    });
    if (cur.tag === 'body') { escapedToBody++; if (escapedToBody > 2) { truncated = false; break; } continue; }
    if (cur.uid === null) { order.push({ ...cur, uid: `dynamic-${i}` }); continue; }
    if (seen.has(cur.uid)) {
      // Focus has cycled back to something already visited.
      if (order.length && cur.uid === order[0].uid) { wrapped = true; truncated = false; break; }
      // else: a component re-focused an earlier element; keep going a bit.
      if (order.length > expected.length * 1.5) { truncated = false; break; }
    }
    seen.add(cur.uid);
    order.push(cur);
  }

  const expectedUids = new Set(expected.map((e) => e.uid));
  const unreachable = expected.filter((e) => !seen.has(e.uid));
  const reachedNotExpected = order.filter((o) => o.uid && !expectedUids.has(o.uid) &&
    !String(o.uid).startsWith('dynamic-')).length;

  return {
    expected_focusable: expected.length,
    reached: seen.size,
    tab_stops_recorded: order.length,
    tabs_pressed: i,
    truncated_at_max_tabs: truncated,
    wrapped_to_start: wrapped,
    max_tabs: maxTabs,
    unreachable_count: unreachable.length,
    unreachable_by_kind: unreachable.reduce((acc, e) => {
      const k = e.role ? `${e.tag}[role=${e.role}]` : e.tag;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    unreachable: unreachable.slice(0, 40),
    positive_tabindex: positiveTabindex,
    reached_but_not_in_expected_set: reachedNotExpected,
    first_10_tab_stops: order.slice(0, 10),
  };
}

/**
 * Ship auto-opens ActionItemsModal on every authenticated page load when the
 * signed-in user has a pending accountability item. Radix marks the rest of the
 * app aria-hidden while it is open, so leaving it open would make every page
 * measure as "4 focusable elements". Dismiss it first, and record on the way out
 * whether Escape actually closes it (a keyboard-operability fact worth having).
 */
async function dismissDialogs(page) {
  const info = { dialog_seen: false, closed_by_escape: null, focusable_in_dialog: 0 };
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.count() === 0) return info;
  info.dialog_seen = true;
  info.focusable_in_dialog = await page.evaluate((sel) =>
    document.querySelectorAll(`[role="dialog"] ${sel.split(',').join(', [role="dialog"] ')}`).length,
    FOCUSABLE_SEL);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  info.closed_by_escape = await dialog.count() === 0;
  if (!info.closed_by_escape) {
    for (const sel of ['button:has-text("Got it")', '[aria-label="Close"]']) {
      const b = page.locator(sel).first();
      if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); }
      if (await dialog.count() === 0) break;
    }
  }
  await page.waitForTimeout(400);
  return info;
}

/** Landmark / heading structure — WCAG 1.3.1 + 2.4.1 context axe reports on. */
async function structure(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 50) }));
    return {
      main: q('main, [role="main"]'),
      nav: q('nav, [role="navigation"]'),
      banner: q('header, [role="banner"]'),
      contentinfo: q('footer, [role="contentinfo"]'),
      h1: q('h1'),
      headings,
      skip_link: [...document.querySelectorAll('a[href^="#"]')]
        .filter((a) => /skip/i.test(a.textContent || '')).length,
      lang: document.documentElement.getAttribute('lang') || null,
      title: document.title,
      aria_label_count: q('[aria-label]'),
      aria_labelledby_count: q('[aria-labelledby]'),
      role_count: q('[role]'),
      live_regions: q('[aria-live], [role="status"], [role="alert"]'),
    };
  });
}

async function scanRoute(context, route) {
  const page = await context.newPage();
  const rec = { name: route.name, path: route.path, url: `${BASE}${route.path}` };
  try {
    await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch { /* SPA polls */ }
    await page.waitForTimeout(2500);
    rec.final_url = page.url();

    if (route.keepDialog) {
      // Dedicated scan of the auto-opened modal itself.
      rec.modal = await page.evaluate((sel) => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return { present: false };
        return {
          present: true,
          accessible_name: d.getAttribute('aria-label') ||
            (d.getAttribute('aria-labelledby')
              ? (document.getElementById(d.getAttribute('aria-labelledby'))?.textContent || '').trim()
              : null),
          aria_modal: d.getAttribute('aria-modal'),
          focusable_inside: d.querySelectorAll(sel).length,
        };
      }, FOCUSABLE_SEL);
    } else {
      rec.dialog_dismissal = await dismissDialogs(page);
    }

    const claim = await new AxeBuilder({ page }).withTags(CLAIM_TAGS).analyze();
    const all = await new AxeBuilder({ page }).analyze();

    const summarize = (r) => {
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      const nodes = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of r.violations) {
        const k = v.impact || 'minor';
        counts[k] = (counts[k] || 0) + 1;
        nodes[k] = (nodes[k] || 0) + v.nodes.length;
      }
      return {
        rule_violations: r.violations.length,
        node_violations: r.violations.reduce((a, v) => a + v.nodes.length, 0),
        by_impact_rules: counts,
        by_impact_nodes: nodes,
        passes: r.passes.length,
        incomplete: r.incomplete.length,
        violations: r.violations.map((v) => ({
          id: v.id, impact: v.impact, help: v.help, tags: v.tags,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 8).map((n) => ({
            target: n.target, html: (n.html || '').slice(0, 220),
            data: n.any?.[0]?.data ?? null,
          })),
        })),
      };
    };

    rec.axe_wcag_508 = summarize(claim);
    rec.axe_all_rules = summarize(all);

    // Contrast detail — actual ratios vs the 4.5:1 AA threshold (p.7).
    const cc = all.violations.find((v) => v.id === 'color-contrast') ||
      claim.violations.find((v) => v.id === 'color-contrast');
    rec.contrast = cc
      ? cc.nodes.map((n) => ({
          target: n.target,
          html: (n.html || '').slice(0, 180),
          ...(n.any?.[0]?.data ?? {}),
        }))
      : [];
    rec.contrast_incomplete = (all.incomplete.find((v) => v.id === 'color-contrast')?.nodes ?? []).length;

    rec.structure = await structure(page);
    rec.keyboard = await keyboardTraversal(page);
    rec.ok = true;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e).slice(0, 400);
  } finally {
    await page.close();
  }
  return rec;
}

const main = async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const boot = await context.newPage();

  const result = { base: BASE, generated_at: new Date().toISOString(), routes: [] };

  // 1. Unauthenticated page first, on a clean context.
  result.routes.push(await scanRoute(context, { name: 'login', path: '/login' }));

  // 2. Authenticate, then everything behind ProtectedRoute.
  await login(boot);
  const ids = await discoverIds(boot);
  result.discovered_ids = ids;
  result.cookies = await context.cookies();
  await boot.close();

  const routes = [
    { name: 'docs (documents home)', path: '/docs' },
    { name: 'my-week', path: '/my-week' },
    { name: 'dashboard', path: '/dashboard' },
    { name: 'issues list', path: '/issues' },
    { name: 'projects list', path: '/projects' },
    { name: 'programs list', path: '/programs' },
    { name: 'team allocation', path: '/team/allocation' },
    { name: 'team directory', path: '/team/directory' },
    { name: 'team status', path: '/team/status' },
    { name: 'workspace settings', path: '/settings' },
    { name: 'admin (super admin)', path: '/admin' },
  ];
  for (const [type, label] of [
    ['issue', 'issue document'],
    ['project', 'project document'],
    ['sprint', 'sprint document'],
    ['weekly_plan', 'weekly plan document'],
    ['wiki', 'wiki document'],
  ]) {
    if (ids[type]) routes.push({ name: label, path: `/documents/${ids[type]}` });
  }

  // Modal measured on its own, with the dialog deliberately left open.
  routes.push({ name: 'action-items modal (auto-opens)', path: '/docs', keepDialog: true });

  for (const r of routes) {
    process.stderr.write(`  scanning ${r.name} ...\n`);
    result.routes.push(await scanRoute(context, r));
  }

  await browser.close();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  process.stdout.write(OUT + '\n');
};

main().catch((e) => { console.error(e); process.exit(1); });
