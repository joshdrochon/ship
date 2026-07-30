#!/usr/bin/env node
/**
 * Summarise `pnpm audit --json` into something readable in a CI log.
 *
 * The gate itself is `pnpm audit --audit-level critical` in .gitlab-ci.yml — this script
 * does not gate, it reports. Raw `pnpm audit` output is thousands of lines and repeats
 * the same advisory once per dependency path, which makes a real regression easy to miss.
 *
 * It also compares against a committed baseline so a NEW high-severity advisory is
 * visible even though high is not gated. Without that, "51 high" stays 51 forever and
 * nobody notices when it becomes 52 for a new reason.
 *
 * Usage:
 *   pnpm audit --json > pnpm-audit.json || true
 *   node scripts/audit-summary.mjs
 *
 * Refresh the baseline deliberately, never automatically:
 *   node scripts/audit-summary.mjs --write-baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const AUDIT_FILE = 'pnpm-audit.json';
const BASELINE_FILE = 'audit-baseline.json';
const writeBaseline = process.argv.includes('--write-baseline');

if (!existsSync(AUDIT_FILE)) {
  console.error(`${AUDIT_FILE} not found. Run: pnpm audit --json > ${AUDIT_FILE} || true`);
  process.exit(1);
}

let audit;
try {
  audit = JSON.parse(readFileSync(AUDIT_FILE, 'utf8'));
} catch {
  // pnpm writes nothing when there are zero advisories, which is not a failure.
  console.log('No parseable audit output — treating as zero advisories.');
  audit = { metadata: { vulnerabilities: {} }, advisories: {} };
}

const counts = audit.metadata?.vulnerabilities ?? {};
const advisories = audit.advisories ?? {};

// Collapse to one entry per (module, advisory); pnpm repeats them per dependency path.
const unique = new Map();
for (const adv of Object.values(advisories)) {
  const key = `${adv.module_name}::${adv.github_advisory_id ?? adv.title}`;
  if (!unique.has(key)) {
    unique.set(key, {
      module: adv.module_name,
      severity: adv.severity,
      title: adv.title,
      id: adv.github_advisory_id ?? '',
      patched: adv.patched_versions ?? '',
      vulnerable: adv.vulnerable_versions ?? '',
    });
  }
}

const ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
const rows = [...unique.values()].sort(
  (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.module.localeCompare(b.module)
);

if (writeBaseline) {
  const baseline = { generated: new Date().toISOString(), keys: [...unique.keys()].sort() };
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline written: ${baseline.keys.length} known advisories.`);
  process.exit(0);
}

console.log('Dependency audit summary');
for (const sev of ORDER) {
  if (counts[sev]) console.log(`  ${String(counts[sev]).padStart(4)}  ${sev}`);
}
console.log(`  ${String(rows.length).padStart(4)}  distinct advisories (paths collapsed)`);

// New-since-baseline detection.
let newOnes = [];
if (existsSync(BASELINE_FILE)) {
  try {
    const known = new Set(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).keys ?? []);
    newOnes = [...unique.entries()].filter(([k]) => !known.has(k)).map(([, v]) => v);
    if (newOnes.length === 0) {
      console.log('\nNo advisories that are not already in audit-baseline.json.');
    } else {
      console.log(`\n${newOnes.length} advisory/advisories NOT in the baseline:`);
      for (const n of newOnes) console.log(`  ${n.severity.padEnd(8)} ${n.module} — ${n.title}`);
      console.log('\nReview these. If accepted, refresh with: node scripts/audit-summary.mjs --write-baseline');
    }
  } catch {
    console.log('\naudit-baseline.json is unreadable — skipping new-advisory comparison.');
  }
} else {
  console.log(`\nNo ${BASELINE_FILE} yet. Create it with: node scripts/audit-summary.mjs --write-baseline`);
}

const md = [
  '# Dependency Audit Summary',
  '',
  `Generated ${new Date().toISOString()}. Gate: zero **critical** (see .gitlab-ci.yml).`,
  '',
  '| Severity | Count |',
  '|---|---:|',
  ...ORDER.filter((s) => counts[s]).map((s) => `| ${s} | ${counts[s]} |`),
  '',
  `${rows.length} distinct advisories after collapsing duplicate dependency paths.`,
  '',
  ...(newOnes.length
    ? ['## New since baseline', '', '| Severity | Package | Advisory |', '|---|---|---|',
       ...newOnes.map((n) => `| ${n.severity} | \`${n.module}\` | ${n.title} |`), '']
    : []),
  '## All advisories',
  '',
  '| Severity | Package | Vulnerable | Patched | Advisory |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.severity} | \`${r.module}\` | ${r.vulnerable} | ${r.patched} | ${r.title} |`),
  '',
].join('\n');

writeFileSync('audit-summary.md', md);
console.log('\nWrote audit-summary.md');
