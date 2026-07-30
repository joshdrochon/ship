#!/usr/bin/env node
/**
 * W6-5 evidence — "reconnect leaves the UI in a stale error state", re-measured.
 *
 * The audit measured this with one boolean sampled once (`measure-runtime-errors.mjs`
 * -> offline.ui_recovered_after_reconnect). This script re-measures it two ways,
 * because the two do not agree and the disagreement is itself the finding:
 *
 *   PHASE 1 — replicate the audit. Go offline, type into the title, come back
 *     online, then evaluate BOTH probes:
 *       (a) the audit's page-wide locator  text=/offline|disconnected/i
 *       (b) the editor's own sync badge    [data-testid="sync-status"]
 *     The audit typed the marker "OFFLINE-EDIT-<ts>" into the title, and the title
 *     is rendered in the h1, the textarea and the sidebar tree — so probe (a)
 *     matches the marker the harness itself typed. Running the same phase with a
 *     neutral marker separates the product's behaviour from the harness's.
 *
 *   PHASE 2 — the defect that is actually there. Leave the browser online and
 *     sever the collaboration WebSocket (and keep it severed), which is what a
 *     server restart, a deploy, or an idle load-balancer timeout does. Then type
 *     and read the badge. The badge is derived from navigator.onLine plus a
 *     one-shot y-websocket status event, so it keeps claiming "Saved" while
 *     nothing is reaching the server.
 *
 * Run it before and after the fix with the same arguments.
 *
 *   BASE=http://localhost:5174 API=http://localhost:3001 DOC_ID=<uuid> \
 *   node docs/audit/scripts/measure-reconnect-ui.mjs --label before \
 *     --outdir docs/audit/evidence/w6-5
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:3000';
const DOC_ID = process.env.DOC_ID ?? '02109d7f-d3ba-46ea-b7cc-c73119536e36';
const TITLE_SEL = 'textarea[placeholder="Untitled"]';
const STATUS_SEL = '[data-testid="sync-status"]';
const OFFLINE_MS = Number(process.env.OFFLINE_MS ?? 5000);
const RECOVER_BUDGET_MS = Number(process.env.RECOVER_BUDGET_MS ?? 30000);
const SEVERED_MS = Number(process.env.SEVERED_MS ?? 12000);
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const LABEL = arg('--label', 'run');
const OUTDIR = arg('--outdir', '/tmp/w6-5');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STALE_RE = /offline|disconnected/i;

async function dismissModal(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
}

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

const badge = (page) =>
  page.locator(STATUS_SEL).innerText().then((t) => t.trim()).catch(() => null);

// The audit's probe, verbatim in spirit: any visible text on the page.
const pageWideStale = (page) =>
  page.locator('text=/offline|disconnected/i').first()
    .isVisible({ timeout: 1500 }).catch(() => false);

async function openDoc(page) {
  await page.goto(`${BASE}/docs/${DOC_ID}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await sleep(1500);
  await dismissModal(page);
  await sleep(1500);
}

async function resetTitle(page, title) {
  return page.evaluate(async ({ api, id, title }) => {
    const t = await (await fetch(`${api}/api/csrf-token`, { credentials: 'include' })).json();
    const r = await fetch(`${api}/api/documents/${id}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t.token },
      body: JSON.stringify({ title }),
    });
    return r.status;
  }, { api: API, id: DOC_ID, title });
}

async function serverBody(page) {
  return page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/api/documents/${id}`, { credentials: 'include' });
    const d = (await r.json()).data ?? {};
    return (function walk(n) {
      if (!n) return '';
      if (n.type === 'text') return n.text ?? '';
      return (n.content ?? []).map(walk).join('');
    })(d.content);
  }, { api: API, id: DOC_ID });
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
const unCaption = (page) => page.evaluate(() => document.getElementById('__cap')?.remove());

/** Phase 1: offline -> online, with a configurable marker. */
async function phase1(ctx, page, marker, shotPrefix) {
  await resetTitle(page, 'Reconnect Test');
  await openDoc(page);
  const before = await badge(page);

  await ctx.setOffline(true);
  await page.locator(TITLE_SEL).click({ timeout: 5000 }).catch(() => {});
  await page.locator(TITLE_SEL).fill(marker).catch(() => {});
  await sleep(OFFLINE_MS);
  const whileOffline = { badge: await badge(page), pageWide: await pageWideStale(page) };
  if (shotPrefix) {
    await caption(page, [
      `W6-5 · ${LABEL} · phase 1 step 1 — network OFF, ${OFFLINE_MS} ms after typing`,
      `sync badge: "${whileOffline.badge}"   page-wide /offline|disconnected/ match: ${whileOffline.pageWide}`,
      `title typed while offline: "${marker}"`,
    ], 'bad');
    await page.screenshot({ path: join(OUTDIR, `${shotPrefix}-1-offline.png`) });
    await unCaption(page);
  }

  const onlineAt = Date.now();
  await ctx.setOffline(false);
  const samples = [];
  let badgeRecoveredMs = null;
  let pageWideRecoveredMs = null;
  while (Date.now() - onlineAt < RECOVER_BUDGET_MS) {
    const b = await badge(page);
    const p = await pageWideStale(page);
    const ms = Date.now() - onlineAt;
    samples.push({ ms, badge: b, pageWide: p });
    if (badgeRecoveredMs === null && b && !STALE_RE.test(b)) badgeRecoveredMs = ms;
    if (pageWideRecoveredMs === null && !p) pageWideRecoveredMs = ms;
    if (badgeRecoveredMs !== null && pageWideRecoveredMs !== null) break;
    await sleep(500);
  }
  const after = { badge: await badge(page), pageWide: await pageWideStale(page) };
  if (shotPrefix) {
    await caption(page, [
      `W6-5 · ${LABEL} · phase 1 step 2 — network BACK for ${Date.now() - onlineAt} ms`,
      `sync badge: "${after.badge}" (recovered after ${badgeRecoveredMs} ms)`,
      `page-wide /offline|disconnected/ match: ${after.pageWide}` +
        (pageWideRecoveredMs === null
          ? ` — STILL MATCHING: the marker "${marker}" is itself the match`
          : ` (cleared after ${pageWideRecoveredMs} ms)`),
    ], after.pageWide ? 'bad' : 'good');
    await page.screenshot({ path: join(OUTDIR, `${shotPrefix}-2-reconnected.png`) });
    await unCaption(page);
  }

  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await sleep(1500);
  await dismissModal(page);
  const survived = (await page.locator(TITLE_SEL).inputValue().catch(() => '')).includes(marker);

  return {
    marker,
    status_before_offline: before,
    while_offline: whileOffline,
    after_reconnect: after,
    badge_recovered_after_ms: badgeRecoveredMs,
    page_wide_probe_recovered_after_ms: pageWideRecoveredMs,
    audit_probe_says_recovered: pageWideRecoveredMs !== null,
    badge_says_recovered: badgeRecoveredMs !== null,
    offline_edit_survived: survived,
  };
}

/**
 * Phase 2: browser stays online, the collaboration socket is severed and kept
 * severed. This is a server restart / deploy / idle-timeout, not a client outage.
 */
async function phase2(ctx, page) {
  let allow = true;
  const live = [];
  await page.routeWebSocket(/\/collaboration\//, (ws) => {
    if (!allow) { ws.close({ code: 1006, reason: 'severed' }); return; }
    ws.connectToServer();
    live.push(ws);
  });

  await resetTitle(page, 'Reconnect Test');
  await openDoc(page);
  const connected = await badge(page);

  const marker = `SEVERED-${Date.now()}`;
  allow = false;
  for (const ws of live) { try { ws.close({ code: 1006, reason: 'severed' }); } catch { /* already gone */ } }
  await sleep(1000);

  // Type into the BODY, which only the collaboration socket can persist.
  await page.locator('div.tiptap[contenteditable="true"]').click().catch(() => {});
  await page.keyboard.type(marker, { delay: 40 }).catch(() => {});
  await sleep(SEVERED_MS);

  const badgeWhileSevered = await badge(page);
  const reachedServer = (await serverBody(page)).includes(marker);
  const lying = !STALE_RE.test(badgeWhileSevered ?? '') && !reachedServer;

  await caption(page, [
    `W6-5 · ${LABEL} · phase 2 — browser ONLINE, collaboration socket severed ${SEVERED_MS} ms ago`,
    `typed into the body: "${marker}"`,
    `sync badge says: "${badgeWhileSevered}"   (was "${connected}" while connected)`,
    `did the text reach the server? ${reachedServer}`,
    lying
      ? '-> THE BADGE IS WRONG: it reports success while nothing is being saved'
      : '-> badge correctly signals that the document is not syncing',
  ], lying ? 'bad' : 'good');
  await page.screenshot({ path: join(OUTDIR, `w6-5-${LABEL}-phase2-severed.png`) });
  await unCaption(page);

  return {
    badge_while_connected: connected,
    badge_while_severed: badgeWhileSevered,
    edit_reached_server: reachedServer,
    badge_claims_saved_while_not_saving: lying,
    severed_for_ms: SEVERED_MS,
  };
}

async function main() {
  mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const out = { label: LABEL, doc: DOC_ID };

  // Phase 1a — the audit's marker, which contains the word OFFLINE.
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await ctx.newPage();
    if (!await login(page)) throw new Error('login failed');
    out.phase1_audit_marker = await phase1(ctx, page, `OFFLINE-EDIT-${Date.now()}`, `w6-5-${LABEL}-phase1`);
    await ctx.close();
  }
  // Phase 1b — same flow, neutral marker.
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await ctx.newPage();
    if (!await login(page)) throw new Error('login failed');
    out.phase1_neutral_marker = await phase1(ctx, page, `EDIT-${Date.now()}`, null);
    await ctx.close();
  }
  // Phase 2 — the real defect.
  {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await ctx.newPage();
    if (!await login(page)) throw new Error('login failed');
    out.phase2_severed_socket = await phase2(ctx, page);
    await ctx.close();
  }

  writeFileSync(join(OUTDIR, `w6-5-${LABEL}.json`), JSON.stringify(out, null, 2));
  const brief = JSON.parse(JSON.stringify(out));
  delete brief.phase1_audit_marker.after_reconnect;
  brief.phase1_audit_marker.samples = undefined;
  console.log(JSON.stringify(out, (k, v) => (k === 'samples' ? `${v.length} samples` : v), 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
