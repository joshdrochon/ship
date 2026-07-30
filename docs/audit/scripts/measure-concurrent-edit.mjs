#!/usr/bin/env node
/**
 * Category 6 — the concurrent-edit bullet (p.6):
 *   "Test concurrent edge cases: two users editing the same document field
 *    simultaneously"
 *
 * Two independent browser contexts means two independent cookie jars, so these
 * are two genuinely different logged-in users, not one user in two tabs. That
 * distinction matters: a single session would share the same Yjs client id and
 * the same auth row, and would not exercise the merge path at all.
 *
 * Ship's two editable fields are tested separately:
 *   - body  — TipTap bound to a Yjs doc over the collaboration WebSocket
 *   - title — a Y.Text in the same Y.Doc as of the W6-9 fix. It was plain React
 *             state (Editor.tsx:187) saved by a debounced PATCH, which is what
 *             W6-9 measured: the last PATCH to land overwrote the whole column.
 *
 * Requires the app running: web :5173, api :3000.
 *
 *   node docs/audit/scripts/measure-concurrent-edit.mjs --out /tmp/cat6-concurrent.json
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3000';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const TITLE_SEL = 'textarea[placeholder="Untitled"]';
const BODY_SEL = 'div.tiptap[contenteditable="true"]';

// Two different seeded users (api/src/db/seed.ts:90-91), same shared password.
const USER_A = { email: 'dev@ship.local', password: 'admin123', tag: 'A' };
const USER_B = { email: 'alice.chen@ship.local', password: 'admin123', tag: 'B' };

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat6-concurrent.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same auto-opening action-items modal the Cat 6 harness has to clear (W6-6).
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
  await page.goto(`${BASE}/docs/${DOC_ID}`, { waitUntil: 'networkidle', timeout: 30000 })
    .catch(() => {});
  await sleep(1500);
  await dismissModal(page);
  await sleep(500);
}

/**
 * Record the lifecycle of the collaboration WebSocket. Without this a failure to
 * sync is indistinguishable from a socket that closed and never came back, and
 * the finding cannot be characterised.
 */
function attachWs(page, tag, bucket) {
  page.on('websocket', (ws) => {
    const url = ws.url();
    if (!url.includes('/collaboration/')) return;
    bucket.push({ tag, event: 'open', url: url.slice(-60), t: Date.now() });
    ws.on('close', () => bucket.push({ tag, event: 'close', url: url.slice(-60), t: Date.now() }));
    ws.on('socketerror', (e) => bucket.push({ tag, event: 'error', err: String(e), t: Date.now() }));
  });
}

const readTitle = (page) => page.locator(TITLE_SEL).inputValue().catch(() => null);
const readBody = (page) => page.locator(BODY_SEL).innerText().catch(() => null);

/**
 * Put the document back to a known title before each field test. Without this the
 * doc still carries whatever the previous run (or the Cat 6 offline test) left in
 * it, and the result is not reproducible — Implementation Rule 1 requires the
 * before and after to run under identical conditions.
 */
async function resetDoc(page, title, bodyText) {
  return page.evaluate(async ({ api, id, title, bodyText }) => {
    const t = await (await fetch(`${api}/api/csrf-token`, { credentials: 'include' })).json();
    const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': t.token };
    const a = await fetch(`${api}/api/documents/${id}`, {
      method: 'PATCH', credentials: 'include', headers: h, body: JSON.stringify({ title }),
    });
    // The body is deliberately NOT reset. PATCH /:id/content writes the `content`
    // column directly and does not touch `yjs_state`, so the CRDT and the column
    // diverge: a client that reconnects re-applies the old Yjs state and the reset
    // vanishes. Resetting that way made every subsequent body measurement wrong.
    // Instead the body test measures the DELTA against whatever text is there.
    return { title: a.status };
  }, { api: API, id: DOC_ID, title });
}

/** Server-side truth, independent of what either client is rendering. */
async function readServer(page) {
  return page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/api/documents/${id}`, { credentials: 'include' });
    if (!r.ok) return { error: `${r.status}` };
    const j = await r.json();
    const d = j.data ?? j;
    const text = (function walk(n) {
      if (!n) return '';
      if (n.type === 'text') return n.text ?? '';
      return (n.content ?? []).map(walk).join('');
    })(d.content);
    return { title: d.title, bodyText: text };
  }, { api: API, id: DOC_ID });
}

/**
 * Type into both clients at the same time. Playwright's per-keystroke delay makes
 * the two streams genuinely interleave rather than running back to back.
 */
async function typeTogether(pageA, pageB, selector, textA, textB) {
  await Promise.all([
    pageA.locator(selector).pressSequentially(textA, { delay: 60 }).catch((e) => ({ err: String(e) })),
    pageB.locator(selector).pressSequentially(textB, { delay: 60 }).catch((e) => ({ err: String(e) })),
  ]);
}

async function main() {
  const out = { doc: DOC_ID, users: [USER_A.email, USER_B.email], tests: [], notes: [] };
  const browser = await chromium.launch({ headless: true });

  // Separate contexts = separate cookie jars = two real sessions.
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  out.ws = [];
  attachWs(pageA, 'A', out.ws);
  attachWs(pageB, 'B', out.ws);

  const okA = await login(pageA, USER_A);
  const okB = await login(pageB, USER_B);
  out.loggedIn = { A: okA, B: okB };
  if (!okA || !okB) {
    out.notes.push('Login failed; aborting. Check the app is running and seeded.');
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.error('login failed', out.loggedIn);
    await browser.close();
    process.exit(1);
  }

  // Reset BEFORE either client opens the editor. Resetting while the doc is open
  // does not hold: the mounted Editor still has the previous title in React state
  // and flushes it back on the next debounce, undoing the reset. That is the same
  // stale-state path this script is here to measure, so it must not confound it.
  const BASELINE = 'Concurrent Edit Test';
  out.resetStatus = await resetDoc(pageA, BASELINE);

  await Promise.all([openDoc(pageA), openDoc(pageB)]);
  out.before = { server: await readServer(pageA) };
  out.resetHeld = out.before.server?.title === BASELINE;
  if (!out.resetHeld) {
    out.notes.push(`Title reset did not hold — expected "${BASELINE}", got "${out.before.server?.title}". Title results below are not reproducible; fix before citing.`);
  }

  // Does each client even see the other? Yjs awareness drives the avatar list
  // rendered under data-testid="collab-status" (Editor.tsx:894).
  const peers = (page) =>
    page.locator('[data-testid="collab-status"] [title]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('title'))
    ).catch(() => null);
  out.awareness = { A_sees: await peers(pageA), B_sees: await peers(pageB) };

  // ------------------------------------------------- title
  // Runs first, on a freshly reset title, so nothing earlier in this script can
  // have dirtied the field under test.
  //
  // > **Verdict corrected after the W6-9 fix landed, recorded because it changes
  // > how the number is read.** The first revision typed "TitleFromA"/"TitleFromB"
  // > and asked whether the server string *contained* each run. That is the same
  // > mistake the body test below already documents: once two writers merge
  // > properly the two streams INTERLEAVE, so the contiguous run is gone even
  // > though every character survived — the corrected title now reads
  // > "…EdiTTiittlleeFFrroommBAt Test", which fails a `contains` check while
  // > losing nothing. A contains-check therefore reports data loss on correct
  // > behaviour. The verdict is now the body test's criterion, applied to the
  // > title: count the characters each user contributed and require both counts
  // > to survive. The marks are single repeated characters so counting is exact,
  // > and the baseline "Concurrent Edit Test" contains no A or B.
  {
    const markA = 'AAAAAAAA';
    const markB = 'BBBBBBBB';
    const count = (s, ch) => ((s ?? '').match(new RegExp(ch, 'g')) ?? []).length;
    const preTitle = (await readServer(pageA)).title ?? '';
    const preA = count(preTitle, 'A');
    const preB = count(preTitle, 'B');

    await pageA.locator(TITLE_SEL).click().catch(() => {});
    await pageB.locator(TITLE_SEL).click().catch(() => {});
    await sleep(300);
    await typeTogether(pageA, pageB, TITLE_SEL, markA, markB);
    await sleep(4000); // debounced save + any refetch

    const seenA = (await readTitle(pageA)) ?? '';
    const seenB = (await readTitle(pageB)) ?? '';
    const server = await readServer(pageA);
    const st = server.title ?? '';
    const gainedA = count(st, 'A') - preA;
    const gainedB = count(st, 'B') - preB;
    out.tests.push({
      field: 'title', mechanism: 'Yjs Y.Text in the editor Y.Doc (useCollaborativeTitle)',
      typedA: markA, typedB: markB,
      baseline: BASELINE, baselineHeld: out.resetHeld,
      A_sees: seenA, B_sees: seenB, server: st,
      clients_converged: seenA === seenB,
      client_matches_server: seenA === st,
      A_chars_typed: markA.length, A_chars_gained_on_server: gainedA,
      B_chars_typed: markB.length, B_chars_gained_on_server: gainedB,
      server_has_A: gainedA >= markA.length, server_has_B: gainedB >= markB.length,
      both_survived: gainedA >= markA.length && gainedB >= markB.length,
      lost_edit_of: [gainedA < markA.length ? 'A' : null, gainedB < markB.length ? 'B' : null].filter(Boolean),
      interleaved: /(AB|BA){3,}/.test(st),
      baseline_text_intact: st.includes(BASELINE.slice(0, 10)),
      conflict_indicator_shown:
        (await pageA.getByText(/conflict|overwritten|out of date|someone else/i).count().catch(() => 0)) > 0,
    });
  }

  // ---------------------------------------------------------------- body (Yjs)
  {
    const markA = 'AAAAAAAA';
    const markB = 'BBBBBBBB';
    // Residue from earlier runs stays in the doc (see resetDoc), so the test is a
    // delta: how many of the characters typed in THIS run survive.
    const countIn = (s, ch) => ((s ?? '').match(new RegExp(ch, 'g')) ?? []).length;
    const preServer = await readServer(pageA);
    const preA = countIn(preServer.bodyText, 'A');
    const preB = countIn(preServer.bodyText, 'B');
    await pageA.locator(BODY_SEL).click().catch(() => {});
    await pageB.locator(BODY_SEL).click().catch(() => {});
    await sleep(300);
    await typeTogether(pageA, pageB, BODY_SEL, markA, markB);
    await sleep(3000); // let Yjs settle and the debounced persist fire

    // innerText also carries the remote-cursor label ("Dev User", "Alice Chen"),
    // which is presence UI, not document content — compare the paragraph only.
    const para = (s) => (s ?? '').split('\n')[0].trim();
    const seenA = para(await readBody(pageA));
    const seenB = para(await readBody(pageB));
    const server = await readServer(pageA);
    const st = server.bodyText ?? '';

    // A CRDT is expected to INTERLEAVE two simultaneous streams, so requiring the
    // typed run to survive contiguously is the wrong test — it fails on correct
    // behaviour. What convergence actually means: no character is lost, and both
    // clients plus the server agree on the same string.
    const count = (s, ch) => (s.match(new RegExp(ch, 'g')) ?? []).length;
    out.tests.push({
      field: 'body', mechanism: 'TipTap + Yjs over WebSocket',
      typedA: markA, typedB: markB,
      A_chars_typed: markA.length, A_chars_gained_on_server: count(st, 'A') - preA,
      B_chars_typed: markB.length, B_chars_gained_on_server: count(st, 'B') - preB,
      no_data_loss: (count(st, 'A') - preA) >= markA.length && (count(st, 'B') - preB) >= markB.length,
      clients_converged: seenA === seenB,
      client_matches_server: seenA === st.trim(),
      interleaved: /(AB|BA){3,}/.test(st),
      sampleA: seenA.slice(0, 300), sampleB: seenB.slice(0, 300), sampleServer: st.slice(0, 300),
      wsOpenA: out.ws.filter((w) => w.tag === 'A' && w.event === 'open').length,
      wsCloseA: out.ws.filter((w) => w.tag === 'A' && w.event === 'close').length,
      wsOpenB: out.ws.filter((w) => w.tag === 'B' && w.event === 'open').length,
      wsCloseB: out.ws.filter((w) => w.tag === 'B' && w.event === 'close').length,
      statusA: await pageA.locator('[data-testid="collab-status"]').locator('..').innerText().catch(() => null),
      statusB: await pageB.locator('[data-testid="collab-status"]').locator('..').innerText().catch(() => null),
    });
  }

  // A reload tells us what a user who walks away and comes back actually gets.
  await Promise.all([openDoc(pageA), openDoc(pageB)]);
  out.afterReload = {
    A: { title: await readTitle(pageA), body: (await readBody(pageA))?.slice(0, 200) },
    B: { title: await readTitle(pageB), body: (await readBody(pageB))?.slice(0, 200) },
    server: await readServer(pageA),
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
