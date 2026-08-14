#!/usr/bin/env node
/**
 * PF-547 — `verifyWebhook` measured at < 1 ms per call.
 *
 * p.8's Signature Challenge performance table sets the target. The ticket's
 * guard rail is that the number must be MEASURED, not asserted: this script is
 * satisfied by a recorded figure, and a figure over budget is a failure with a
 * name rather than a rounding conversation.
 *
 * Mirrors `measure-install-size.mjs` exactly — same `--check` convention, same
 * "write a report a human can read, and refuse when over budget" shape. Both
 * numbers are uploaded under one CI artifact so the submission has one place to
 * look.
 *
 *   node scripts/measure-verify-latency.mjs           report
 *   node scripts/measure-verify-latency.mjs --check    report, and exit 1 over budget
 *
 * Needs `pnpm --filter @ship/sdk build` first: it measures the PUBLISHED
 * `dist/`, not the source, because `dist` is what a consumer runs.
 */
import { createHmac } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_FILE = resolve(PACKAGE_ROOT, 'perf-report.json');

/** p.8's Signature Challenge target. */
const BUDGET_MS = 1;

/** The ticket's floor. More iterations, less noise. */
const ITERATIONS = 5000;

/**
 * A REALISTIC payload — the shape a `document.created` delivery actually
 * carries, matching L15's `ordinary-envelope` vector. Benchmarking an empty body
 * would measure the function-call overhead and nothing else, and HMAC cost is
 * proportional to body length.
 */
const SECRET = 'whsec_TFhwadwxlAqBGjbHUeS9zvBTPRnQBs7RCTn6RGHmVQE';
const BODY = JSON.stringify({
  id: '3f1b0c2a-0000-4000-8000-000000000001',
  type: 'document.created',
  created_at: '2024-05-17T22:40:00.000Z',
  workspace_id: '11111111-1111-4111-8111-111111111111',
  data: {
    id: '66666666-6666-4666-8666-666666666666',
    document_type: 'wiki',
    title: 'Release notes',
    parent_id: null,
    created_at: '2024-05-17T22:39:59.000Z',
    updated_at: '2024-05-17T22:39:59.000Z',
    created_by: '44444444-4444-4444-8444-444444444444',
    visibility: 'workspace',
  },
});

export async function measure() {
  const entry = resolve(PACKAGE_ROOT, 'dist/index.js');
  if (!existsSync(entry)) {
    // Loud, not zero. A script that silently measures nothing reports a
    // wonderful number and proves nothing — the same failure mode
    // `measure-install-size.mjs` refuses.
    throw new Error(
      `${entry} does not exist. Run \`pnpm --filter @ship/sdk build\` first — this measures ` +
        `the PUBLISHED dist, not the source, because dist is what a consumer runs.`,
    );
  }

  const { verifyWebhook } = await import(entry);

  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
  const headers = { 'ship-signature': `t=${timestamp},v1=${v1}` };

  // Warm up, so the figure is steady-state rather than first-call JIT.
  for (let i = 0; i < 500; i += 1) verifyWebhook(headers, BODY, SECRET);

  const samples = new Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = process.hrtime.bigint();
    const ok = verifyWebhook(headers, BODY, SECRET);
    samples[i] = Number(process.hrtime.bigint() - started) / 1e6;
    // Measuring a call that returns `false` would measure the early-return path.
    if (ok !== true) throw new Error('the benchmark payload did not verify — the figure is void');
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];

  const report = {
    measuredAt: new Date().toISOString(),
    subject: 'verifyWebhook',
    iterations: ITERATIONS,
    bodyBytes: Buffer.byteLength(BODY, 'utf8'),
    meanMs: Number(mean.toFixed(6)),
    p50Ms: Number(percentile(0.5).toFixed(6)),
    p95Ms: Number(percentile(0.95).toFixed(6)),
    p99Ms: Number(percentile(0.99).toFixed(6)),
    maxMs: Number(samples[samples.length - 1].toFixed(6)),
    budgetMs: BUDGET_MS,
    // The BUDGETED figure is p95, not the max: one sample interrupted by a GC
    // pause is not a property of the verifier, and a max-based budget on a
    // shared CI runner is a flaky test wearing a performance hat.
    withinBudget: percentile(0.95) < BUDGET_MS,
    source: 'PRD p.8, Signature Challenge performance table',
  };

  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = await measure();
  const rows = [
    ['subject', report.subject],
    ['iterations', String(report.iterations)],
    ['payload', `${report.bodyBytes} bytes (a real document.created envelope)`],
    ['mean', `${report.meanMs.toFixed(4)} ms`],
    ['p50', `${report.p50Ms.toFixed(4)} ms`],
    ['p95', `${report.p95Ms.toFixed(4)} ms  ← the budgeted figure`],
    ['p99', `${report.p99Ms.toFixed(4)} ms`],
    ['budget', `${report.budgetMs} ms  (PRD p.8)`],
    ['report', 'perf-report.json'],
  ];
  for (const [label, value] of rows) console.log(`  ${label.padEnd(16)}${value}`);

  if (process.argv.includes('--check') && !report.withinBudget) {
    console.error(
      `\nOVER BUDGET: verifyWebhook p95 is ${report.p95Ms.toFixed(4)} ms against a ` +
        `${BUDGET_MS} ms target (PRD p.8).`,
    );
    process.exit(1);
  }
  console.log(`\nOK: p95 ${report.p95Ms.toFixed(4)} ms, budget ${BUDGET_MS} ms.`);
}
