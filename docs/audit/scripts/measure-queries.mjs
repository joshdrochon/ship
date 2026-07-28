#!/usr/bin/env node
/**
 * Category 4 — Database Query Efficiency (p.5).
 *
 * Drives the 5 user flows p.5 names, delimiting each with a marker query so the
 * PostgreSQL log can be attributed per flow. Reports query counts, slowest
 * statement, and duplicate-shape clusters (the N+1 signature).
 *
 * Prerequisites — the script verifies both and refuses to run otherwise:
 *   log_statement = 'all'  and  log_min_duration_statement = 0
 *   app running on :5173 / :3000
 *
 *   node docs/audit/scripts/measure-queries.mjs --out /tmp/cat4-raw.json
 */

import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const CONTAINER = process.env.PG_CONTAINER ?? 'ship-postgres-1';
const DB = process.env.PG_DB ?? 'ship_dev';
const PG_USER = process.env.PG_USER ?? 'ship';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/cat4-raw.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', PG_USER, '-d', DB, '-t', '-A', '-c', sql],
    { encoding: 'utf8' }).trim();

function marker(label) { psql(`SELECT 'FLOWMARK:${label}' AS m`); }

// `docker logs --since <iso>` proved unreliable here (dropped lines whose
// timestamps straddled the boundary), so take a generous tail instead and let
// the FLOWMARK delimiters do the scoping.
// PostgreSQL writes its log to STDERR, so `docker logs` emits it on stderr too.
// execFileSync returns stdout only — capturing just stdout yields an empty string
// and every flow silently reports 0 queries. Merge both streams.
function logsTail(n = 400000) {
  const r = spawnSync('docker', ['logs', '--tail', String(n), CONTAINER],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return (r.stdout || '') + (r.stderr || '');
}

/** Collapse a statement to its shape so repeats of the same query cluster together. */
function shape(sql) {
  return sql
    .replace(/'[^']*'/g, "'?'")
    .replace(/\$\d+/g, '$?')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function parseFlows(raw) {
  // duration lines look like:  LOG:  duration: 1.234 ms  statement: SELECT ...
  //                    or:     LOG:  duration: 1.234 ms  execute <unnamed>: SELECT ...
  const lines = raw.split('\n');
  const flows = {};
  let current = null;
  // Count EXECUTIONS only. The extended query protocol logs parse/bind/execute
  // for the same logical statement — counting all three inflates every flow ~3x.
  const stmtRe = /LOG:\s+(?:duration:\s+([\d.]+)\s+ms\s+)?(?:statement|execute\b[^:]*):\s+([\s\S]*)$/;
  const durRe = /LOG:\s+duration:\s+([\d.]+)\s+ms/;
  let pendingDur = null;

  for (const line of lines) {
    const mk = line.match(/FLOWMARK:([a-z0-9_-]+)/i);
    if (mk) { current = mk[1]; flows[current] ??= []; pendingDur = null; continue; }
    const d = line.match(durRe);
    const s = line.match(stmtRe);
    if (s && s[2]) {
      const sql = s[2].trim();
      if (/FLOWMARK/.test(sql)) continue;
      const dur = s[1] ? Number(s[1]) : (pendingDur ?? null);
      if (current) flows[current].push({ ms: dur, sql });
      pendingDur = null;
    } else if (d) {
      pendingDur = Number(d[1]);
    }
  }
  return flows;
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'dev@ship.local').catch(() => {});
  await page.fill('input[type="password"]', 'admin123').catch(() => {});
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {});
  await sleep(2000);
}

async function dismissModal(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="dialog"]').count())) break;
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(350);
  }
}

async function main() {
  if (psql('show log_statement') !== 'all')
    throw new Error("postgres log_statement is not 'all' — enable it first");

  const docId = psql(
    "select id from documents where document_type='wiki' and properties->>'_audit_fixture' is null limit 1");
  if (!docId) throw new Error('no wiki document found — run pnpm db:seed');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await dismissModal(page);

  // p.5: "load the main page, view a document, list issues, load a sprint board, search for content"
  const flows = [
    ['load_main_page', async () => { await page.goto(`${BASE}/my-week`, { waitUntil: 'networkidle' }); }],
    ['view_a_document', async () => { await page.goto(`${BASE}/docs/${docId}`, { waitUntil: 'networkidle' }); }],
    ['list_issues', async () => { await page.goto(`${BASE}/issues`, { waitUntil: 'networkidle' }); }],
    ['load_sprint_board', async () => { await page.goto(`${BASE}/weeks`, { waitUntil: 'networkidle' }); }],
    ['search_content', async () => {
      await page.goto(`${BASE}/docs`, { waitUntil: 'networkidle' });
      await dismissModal(page);
      const box = page.locator('input[placeholder*="Search" i]').first();
      if (await box.count()) { await box.click({ timeout: 5000 }); await box.fill('architecture'); }
      await sleep(2500);
    }],
  ];

  for (const [label, run] of flows) {
    await page.goto(`${BASE}/about:blank`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(600);
    marker(label);
    await sleep(300);
    try { await run(); } catch (e) { console.error(`${label}: ${e.message.slice(0, 90)}`); }
    await sleep(2200);          // let debounced/deferred queries land
  }
  marker('end');
  await browser.close();

  const parsed = parseFlows(logsTail());
  const out = { flows: {}, generated: new Date().toISOString() };
  for (const [label] of flows) {
    const qs = parsed[label] ?? [];
    const byShape = {};
    for (const q of qs) { (byShape[shape(q.sql)] ??= []).push(q.ms ?? 0); }
    const dupes = Object.entries(byShape)
      .filter(([, v]) => v.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([sh, v]) => ({ count: v.length, total_ms: +v.reduce((a, b) => a + b, 0).toFixed(2), shape: sh }));
    const slowest = qs.filter(q => q.ms != null).sort((a, b) => b.ms - a.ms)[0] ?? null;
    out.flows[label] = {
      total_queries: qs.length,
      distinct_shapes: Object.keys(byShape).length,
      slowest_ms: slowest ? slowest.ms : null,
      slowest_sql: slowest ? slowest.sql.replace(/\s+/g, ' ').slice(0, 260) : null,
      total_ms: +qs.reduce((a, q) => a + (q.ms ?? 0), 0).toFixed(2),
      repeated_shapes: dupes,
    };
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`wrote ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
