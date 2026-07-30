#!/usr/bin/env node
/**
 * Source-code inventory: every package, its version, its licence.
 *
 * Rule 4 (brief p.8) requires this as part of the CI run — "a list of all packages,
 * their versions, and their license". `pnpm licenses list` produces the data but groups
 * it by licence and emits JSON that is awkward to read in a CI log, so this flattens it
 * into a sorted table plus a summary, and writes both a Markdown and a CSV artifact.
 *
 * Also fails the build on a licence that is missing or explicitly disallowed. A licence
 * inventory nobody acts on is a log line, not a control — the point of producing it in
 * CI is to notice when a new dependency arrives under terms the project cannot accept.
 *
 * Usage:
 *   pnpm licenses list --json > licenses.json && node scripts/license-inventory.mjs
 *
 * Outputs:
 *   licenses.md   human-readable table, committed as a CI artifact
 *   licenses.csv  same data for spreadsheet review
 *
 * Exit codes:
 *   0  inventory produced, no disallowed licences
 *   1  a disallowed or unknown licence was found (details on stderr)
 */
import { readFileSync, writeFileSync } from 'node:fs';

// Copyleft terms that would oblige this project to publish derived source. Flagged
// rather than silently accepted; add to ALLOWED_EXCEPTIONS with a reason if reviewed.
const DISALLOWED = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-1.0', 'AGPL-3.0', 'SSPL-1.0']);

// Packages cleared individually despite matching above (e.g. a dual licence where we
// take the permissive option). Keep the reason attached.
const ALLOWED_EXCEPTIONS = new Map([
  // 'some-pkg': 'dual MIT/GPL — MIT elected',
]);

function loadInventory(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`Cannot read ${path}. Run: pnpm licenses list --json > ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`${path} is not valid JSON. pnpm may have written a warning into it.`);
    process.exit(1);
  }
}

const grouped = loadInventory('licenses.json');

// pnpm shape: { "MIT": [ { name, version, ... }, ... ], "ISC": [ ... ] }
const rows = [];
for (const [license, pkgs] of Object.entries(grouped)) {
  for (const pkg of pkgs) {
    // `versions` is an array when one package resolves to several versions.
    const versions = pkg.versions ?? (pkg.version ? [pkg.version] : ['unknown']);
    for (const version of versions) {
      rows.push({
        name: pkg.name,
        version,
        license,
        homepage: pkg.homepage ?? '',
      });
    }
  }
}

rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const byLicense = new Map();
for (const r of rows) byLicense.set(r.license, (byLicense.get(r.license) ?? 0) + 1);
const summary = [...byLicense.entries()].sort((a, b) => b[1] - a[1]);

const md = [
  '# Source-Code Inventory',
  '',
  `Generated ${new Date().toISOString()} by \`scripts/license-inventory.mjs\`.`,
  'Required by Implementation Rule 4 (brief p.8).',
  '',
  `**${rows.length} packages** across **${byLicense.size} distinct licences.**`,
  '',
  '## Licence summary',
  '',
  '| Licence | Packages |',
  '|---|---:|',
  ...summary.map(([l, n]) => `| ${l} | ${n} |`),
  '',
  '## All packages',
  '',
  '| Package | Version | Licence |',
  '|---|---|---|',
  ...rows.map((r) => `| \`${r.name}\` | ${r.version} | ${r.license} |`),
  '',
].join('\n');

writeFileSync('licenses.md', md);
writeFileSync(
  'licenses.csv',
  ['name,version,license,homepage', ...rows.map((r) => `"${r.name}","${r.version}","${r.license}","${r.homepage}"`)].join('\n') + '\n'
);

console.log(`Inventory: ${rows.length} packages, ${byLicense.size} licences`);
for (const [l, n] of summary) console.log(`  ${String(n).padStart(5)}  ${l}`);
console.log('Wrote licenses.md and licenses.csv');

const problems = rows.filter(
  (r) =>
    !ALLOWED_EXCEPTIONS.has(r.name) &&
    (DISALLOWED.has(r.license) || r.license === 'Unknown' || r.license === 'UNKNOWN')
);

if (problems.length > 0) {
  console.error(`\n${problems.length} package(s) need a licence decision:`);
  for (const p of problems) console.error(`  ${p.name}@${p.version} — ${p.license}`);
  console.error(
    '\nEither remove the dependency, or add it to ALLOWED_EXCEPTIONS in this script\n' +
      'with the reason it is acceptable.'
  );
  process.exit(1);
}

console.log('No disallowed licences.');
