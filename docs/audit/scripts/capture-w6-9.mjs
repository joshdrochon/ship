#!/usr/bin/env node
/**
 * W6-9 evidence capture — "two users editing the same title, one edit is silently
 * destroyed" (Category 6, p.7 requires a screenshot or recording per fix).
 *
 * Same two-context setup as measure-concurrent-edit.mjs, but it stops after the
 * title test and writes a PNG of each user's screen plus a caption strip stating
 * what each user typed and what the server ended up with. Run it before and after
 * the fix with the same arguments.
 *
 *   BASE=http://localhost:5174 API=http://localhost:3001 DOC_ID=<uuid> \
 *   node docs/audit/scripts/capture-w6-9.mjs --label before \
 *     --outdir docs/audit/evidence/w6-9
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3000';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const TITLE_SEL = 'textarea[placeholder="Untitled"]';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const LABEL = arg('--label', 'run');
const OUTDIR = arg('--outdir', '/tmp/w6-9');

const USER_A = { email: 'dev@ship.local', password: 'admin123', tag: 'A' };
const USER_B = { email: 'alice.chen@ship.local', password: 'admin123', tag: 'B' };
const BASELINE = 'Concurrent Edit Test';
// Single repeated characters, and a baseline containing neither, so survival can be
// counted rather than matched as a substring. Once two writers merge correctly the
// two streams interleave ("…EdiTTiittlleeFFrroommBAt Test"), so a substring check
// reports data loss on correct behaviour — see the note in measure-concurrent-edit.mjs.
const MARK_A = 'AAAAAAAA';
const MARK_B = 'BBBBBBBB';
const countIn = (s, ch) => ((s ?? '').match(new RegExp(ch, 'g')) ?? []).length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissModal(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
}

async function login(page, user) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', user.email).catch(() => {});
  await page.fill('input[type="password"]', user.password).catch(() => {});
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"]').catch(() => {}),
  ]);
  await sleep(1500);
  return !page.url().includes('/login');
}

async function openDoc(page) {
  await page.goto(`${BASE}/docs/${DOC_ID}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await sleep(1500);
  await dismissModal(page);
  await sleep(500);
}

async function resetTitle(page) {
  return page.evaluate(async ({ api, id, title }) => {
    const t = await (await fetch(`${api}/api/csrf-token`, { credentials: 'include' })).json();
    const r = await fetch(`${api}/api/documents/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t.token },
      body: JSON.stringify({ title }),
    });
    return r.status;
  }, { api: API, id: DOC_ID, title: BASELINE });
}

async function serverTitle(page) {
  return page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/api/documents/${id}`, { credentials: 'include' });
    const j = await r.json();
    return (j.data ?? j).title;
  }, { api: API, id: DOC_ID });
}

/** Caption banner drawn into the page so the PNG is self-describing. */
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
  const ctxA = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const okA = await login(pageA, USER_A);
  const okB = await login(pageB, USER_B);
  if (!okA || !okB) throw new Error(`login failed A=${okA} B=${okB}`);

  await resetTitle(pageA);
  await Promise.all([openDoc(pageA), openDoc(pageB)]);

  await pageA.locator(TITLE_SEL).click().catch(() => {});
  await pageB.locator(TITLE_SEL).click().catch(() => {});
  await sleep(300);
  await Promise.all([
    pageA.locator(TITLE_SEL).pressSequentially(MARK_A, { delay: 60 }).catch(() => {}),
    pageB.locator(TITLE_SEL).pressSequentially(MARK_B, { delay: 60 }).catch(() => {}),
  ]);
  await sleep(4000);

  const seenA = await pageA.locator(TITLE_SEL).inputValue().catch(() => '');
  const seenB = await pageB.locator(TITLE_SEL).inputValue().catch(() => '');
  const server = await serverTitle(pageA);
  const gainedA = countIn(server, 'A');
  const gainedB = countIn(server, 'B');
  const hasA = gainedA >= MARK_A.length;
  const hasB = gainedB >= MARK_B.length;
  const both = hasA && hasB;
  const converged = seenA === seenB && seenA === String(server);

  const verdict = both
    ? 'BOTH EDITS SURVIVED — every character of both users is in the saved title'
    : `DATA LOSS — ${!hasA ? 'user A' : 'user B'} typing was destroyed with no warning`;

  for (const [tag, page, seen] of [['A', pageA, seenA], ['B', pageB, seenB]]) {
    await caption(page, [
      `W6-9 · ${LABEL} · user ${tag} (${tag === 'A' ? USER_A.email : USER_B.email})`,
      `baseline title: "${BASELINE}"   A typed ${MARK_A.length}x"A"   B typed ${MARK_B.length}x"B"`,
      `this screen shows: "${seen}"`,
      `server now has:    "${server}"`,
      `A characters kept: ${gainedA}/${MARK_A.length}   B characters kept: ${gainedB}/${MARK_B.length}` +
        `   all three views agree: ${converged}`,
      `-> ${verdict}`,
    ], both ? 'good' : 'bad');
    await page.screenshot({ path: join(OUTDIR, `w6-9-${LABEL}-user-${tag}.png`), fullPage: false });
  }

  const result = {
    label: LABEL, doc: DOC_ID, baseline: BASELINE, typedA: MARK_A, typedB: MARK_B,
    A_sees: seenA, B_sees: seenB, server,
    A_chars_typed: MARK_A.length, A_chars_kept: gainedA,
    B_chars_typed: MARK_B.length, B_chars_kept: gainedB,
    server_has_A: hasA, server_has_B: hasB,
    clients_and_server_agree: converged,
    baseline_text_intact: String(server).includes(BASELINE.slice(0, 10)),
    both_survived: both, verdict,
  };
  writeFileSync(join(OUTDIR, `w6-9-${LABEL}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
