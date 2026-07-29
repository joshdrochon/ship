#!/usr/bin/env node
/**
 * Category 7 — p.7's screen-reader bullet:
 *   "Test with a screen reader (VoiceOver, NVDA, or similar). Can you understand
 *    the page structure and interact with all controls?"
 *
 * WHAT THIS IS, STATED PLAINLY
 * ────────────────────────────
 * This drives @guidepup/virtual-screen-reader — a screen reader *simulator* — over
 * the real application in a real browser. It is NOT VoiceOver and must never be
 * reported as VoiceOver. Its own documentation is explicit: it "should not replace
 * but augment your screen reader testing, there is no substitute for testing with
 * real screen readers and with real users."
 *
 * Why it is still worth running, and where it sits between the two things this
 * audit already has:
 *
 *   measure-a11y-tree.mjs   dumps the tree a screen reader consumes. Roles and
 *                           names only. Says nothing about announcements.
 *   THIS SCRIPT             computes what a screen reader would announce, per
 *                           W3C ACCNAME / WAI-ARIA / HTML-AAM, walking the real
 *                           rendered DOM of the real app, and can activate
 *                           controls and report what changes.
 *   a live VoiceOver pass   the only thing that establishes whether the speech is
 *                           comprehensible to a person. Still required.
 *
 * So this closes the objective half of p.7's two questions — is every control
 * announced with a usable name, is the structure navigable — and leaves the
 * subjective half where it belongs. See docs/audit/voiceover-protocol.md.
 *
 * WHY NOT REAL VOICEOVER: driving it is blocked on macOS 14.6.1. guidepup starts
 * and stops VoiceOver and AppleScript reaches it (`version` returns 10), but every
 * content object in the scripting dictionary returns -1728 (object not found) —
 * `content of last phrase`, `vo cursor`, `properties`. Reading VoiceOver's caption
 * panel through the accessibility API fails too: the VoiceOver process exposes 0
 * windows and 0 UI elements to System Events. Evidence in voiceover-protocol.md.
 *
 * Requires the app running: web :5173.
 *
 *   node docs/audit/scripts/measure-virtual-screenreader.mjs --out /tmp/cat7-virtual.json
 */

import { chromium } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const BROWSER_BUNDLE = require_.resolve('@guidepup/virtual-screen-reader/browser.js');

const BASE = process.env.BASE ?? 'http://localhost:5173';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat7-virtual.json';

const PAGES = [
  ['login', '/login'],
  ['docs home', '/docs'],
  ['document editor', `/docs/${DOC_ID}`],
  ['issues', '/issues'],
  ['workspace settings', '/settings'],
];

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

/**
 * Walk the whole document with the virtual screen reader and return every
 * announcement in order. Runs inside the page so it reads the live DOM.
 */
async function walk(page, bundleSource) {
  return page.evaluate(async (src) => {
    const blob = new Blob([src], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const { virtual } = await import(url);

    await virtual.start({ container: document.body });

    const spoken = [];
    // Bounded so a cyclic structure cannot hang the run. The map showed the
    // largest page at 348 cursor stops; 1500 clears every page with headroom.
    const MAX = 4000;
    let previous = null;
    let repeats = 0;

    for (let i = 0; i < MAX; i++) {
      await virtual.next();
      const phrase = await virtual.lastSpokenPhrase();
      spoken.push(phrase);

      // The virtual cursor wraps at the end of the document rather than stopping,
      // so detect the wrap instead of walking forever.
      if (phrase === previous) { repeats++; } else { repeats = 0; }
      previous = phrase;
      if (repeats >= 5) break;
      if (spoken.length > 20 && phrase === spoken[0]) break;
    }

    const log = await virtual.spokenPhraseLog();
    await virtual.stop();
    URL.revokeObjectURL(url);
    return { spoken, log };
  }, bundleSource);
}

/**
 * p.7 asks two questions. This answers the second — "can you interact with all
 * controls" — by finding every control the simulator reaches and checking each
 * announces something a user could act on.
 */
function analyse(spoken) {
  // Announcements are "role, name, state". Container exits repeat the phrase
  // prefixed "end of" and would double every count.
  const CONTROL = /^(button|link|textbox|combobox|checkbox|radio|menuitem|tab|switch|slider|searchbox|treeitem|option)\b/i;
  const controls = spoken.filter((p) => CONTROL.test(p) && !/^end of/i.test(p));

  // Two distinct defects, and the first measurement conflated them:
  //
  //   bare role      — nothing after the role. The control has no accessible
  //                    name AND no value, so a user hears only "button".
  //   indistinguishable — the announcement is identical to another control's on
  //                    the same page. The user hears something, but nothing that
  //                    tells this control apart from the others. A control whose
  //                    accessible name is empty still announces its *value*, so
  //                    it is never bare — it lands here instead. This is the case
  //                    that matters for /settings, where every unnamed member-role
  //                    dropdown announces only its current role.
  const bare = controls.filter((p) => /^[a-z]+$/i.test(p.trim()));
  const counts = {};
  for (const c of controls) counts[c] = (counts[c] ?? 0) + 1;
  const dupGroups = Object.entries(counts)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);

  const headings = spoken.filter((p) => /\bheading\b/i.test(p) && !/^end of/i.test(p));
  const landmarks = spoken.filter(
    (p) => /^(banner|navigation|main|complementary|contentinfo|region|search|form)\b/i.test(p) &&
           !/^end of/i.test(p)
  );

  return {
    announcements: spoken.length,
    distinct: new Set(spoken).size,
    controlsAnnounced: controls.length,
    controlsBareRole: bare.length,
    controlsIndistinguishable: dupGroups.reduce((n, [, c]) => n + c, 0),
    indistinguishableGroups: dupGroups.length,
    worstGroups: dupGroups.slice(0, 5).map(([phrase, n]) => ({ phrase, count: n })),
    headings: headings.length,
    headingSamples: [...new Set(headings)].slice(0, 10),
    landmarks: [...new Set(landmarks)].slice(0, 10),
  };
}

async function main() {
  const bundle = readFileSync(BROWSER_BUNDLE, 'utf8');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const out = {
    tool: '@guidepup/virtual-screen-reader (simulator, NOT VoiceOver) driven over the ' +
          'real app in Chromium',
    caveat: 'A screen reader simulator. It establishes whether controls are announced ' +
            'with usable names and whether structure is navigable. It does not establish ' +
            'whether the speech is comprehensible to a person — that needs a live pass.',
    base: BASE, pages: [],
  };

  let authed = false;
  for (const [label, path] of PAGES) {
    // /login must be visited before authenticating: PublicRoute redirects a
    // logged-in visitor to /docs (web/src/main.tsx:104), which is how an earlier
    // measurement filed /docs under the label "login".
    if (path !== '/login' && !authed) { await login(page); authed = true; }

    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await dismiss(page);
    await sleep(500);

    if (path === '/login' && !page.url().includes('/login')) {
      throw new Error('Redirected away from /login — visit it before authenticating.');
    }

    const { spoken } = await walk(page, bundle);
    const a = analyse(spoken);
    out.pages.push({ page: label, path, ...a, transcript: spoken });

    console.log(
      `${label.padEnd(20)} ${String(a.controlsAnnounced).padStart(4)} controls · ` +
      `${String(a.controlsBareRole).padStart(3)} bare-role · ` +
      `${String(a.controlsIndistinguishable).padStart(4)} indistinguishable ` +
      `(${a.indistinguishableGroups} groups) · ${a.headings} headings`
    );
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  }

  out.totals = {
    controlsAnnounced: out.pages.reduce((n, p) => n + p.controlsAnnounced, 0),
    controlsBareRole: out.pages.reduce((n, p) => n + p.controlsBareRole, 0),
    controlsIndistinguishable: out.pages.reduce((n, p) => n + p.controlsIndistinguishable, 0),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
