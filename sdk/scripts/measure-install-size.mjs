#!/usr/bin/env node
/**
 * PF-514 / PF-515 — the SDK install footprint, MEASURED.
 *
 *     pnpm --filter @ship/sdk size          # measure and write the report
 *     pnpm --filter @ship/sdk size:check    # …and exit 1 if over budget
 *
 * PRD p.9 sets the target: *"SDK install size (production deps only)"* at
 * *"< 250 KB minified + gzipped"*, and p.15 asks how it is enforced. The answer
 * is this script, run as a blocking CI step — a bundle analyzer REPORTS and a
 * check REFUSES, and only one of those stops a 400 KB dependency landing.
 *
 * ── What is measured, and why it is not just `dist` ─────────────────────────
 * The PRODUCTION CLOSURE: the package's own emitted JavaScript PLUS every
 * transitive `dependencies` entry, gzipped and summed. Measuring `dist` alone
 * would pass forever — adding `axios` does not make `dist` bigger, it makes the
 * INSTALL bigger, and the install is what the budget is about.
 *
 * `dependencies` is empty today, so the closure is `dist` and the number is
 * small. The assertion that keeps it that way is the empty-deps check; the byte
 * count is the proof that the mechanism ran.
 *
 * ── About "minified" ───────────────────────────────────────────────────────
 * This repository has no minifier resolvable from `sdk/`, and adding one to
 * satisfy a measurement would be a devDependency added to prove a claim about
 * dependencies. So the script measures **gzipped, UNMINIFIED** bytes and treats
 * that as the number to check. That is a deliberately CONSERVATIVE bound:
 * minifying strictly reduces size, so `gzip(raw) < 250 KB` implies
 * `gzip(minified) < 250 KB`. The budget is proven, not approximated, and the
 * report says which number it is. If a minifier is later available in the
 * workspace, tighten this — do not loosen the check.
 *
 * Types (`.d.ts`, `.d.ts.map`) are counted: they are in `files`, so `npm pack`
 * ships them and a consumer downloads them. `.map` files for JS are counted for
 * the same reason.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The p.9 budget, in bytes. Exported as a constant so CI checks the same number. */
export const SIZE_BUDGET_BYTES = 250 * 1024;

const REPORT_PATH = join(PACKAGE_ROOT, 'size-report.json');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * The transitive `dependencies` closure of a manifest.
 *
 * Walks `dependencies` (never `devDependencies` — the budget is what a consumer
 * INSTALLS) and resolves each package's directory. A dependency that cannot be
 * resolved is reported rather than skipped: an unmeasurable dependency is a hole
 * in the number, and a hole in the number is worse than a number that is too big.
 */
function productionClosure(manifest, rootDir) {
  const found = new Map();
  const missing = [];
  const queue = Object.keys(manifest.dependencies ?? {});
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);

    const candidates = [
      join(rootDir, 'node_modules', name),
      join(rootDir, '..', 'node_modules', name),
    ];
    const dir = candidates.find((c) => existsSync(join(c, 'package.json')));
    if (!dir) {
      missing.push(name);
      continue;
    }
    found.set(name, dir);
    const nested = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    queue.push(...Object.keys(nested.dependencies ?? {}));
  }
  return { found, missing };
}

function gzippedBytes(files) {
  // Each file gzipped independently and summed. That is how a registry serves
  // them and how a lockfile-driven install fetches them; concatenating first
  // would let cross-file redundancy make the number optimistically small.
  return files.reduce((total, file) => total + gzipSync(readFileSync(file)).length, 0);
}

function measure() {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const dependencies = manifest.dependencies ?? {};

  const distDir = join(PACKAGE_ROOT, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(
      `No dist/ to measure at ${distDir}. Run \`pnpm --filter @ship/sdk build\` first — ` +
        `measuring source instead of output would report a number nobody installs.`,
    );
  }

  const distFiles = walk(distDir);
  const distRaw = distFiles.reduce((n, f) => n + statSync(f).size, 0);
  const distGzip = gzippedBytes(distFiles);

  const { found, missing } = productionClosure(manifest, PACKAGE_ROOT);
  const depEntries = [];
  let depGzip = 0;
  for (const [name, dir] of found) {
    const bytes = gzippedBytes(walk(dir).filter((f) => !f.includes(`${'node_modules'}/`)));
    depEntries.push({ name, gzippedBytes: bytes });
    depGzip += bytes;
  }

  const totalGzip = distGzip + depGzip;

  return {
    measuredAt: new Date().toISOString(),
    budgetBytes: SIZE_BUDGET_BYTES,
    // Named so nobody mistakes it for a minified figure. See the header: it is
    // a conservative UPPER BOUND on minified+gzipped.
    method: 'gzip of unminified published files (upper bound on min+gzip)',
    productionDependencyCount: Object.keys(dependencies).length,
    unresolvedDependencies: missing,
    dist: {
      fileCount: distFiles.length,
      rawBytes: distRaw,
      gzippedBytes: distGzip,
      files: distFiles
        .map((f) => ({ file: relative(PACKAGE_ROOT, f), gzippedBytes: gzippedBytes([f]) }))
        .sort((a, b) => b.gzippedBytes - a.gzippedBytes)
        .slice(0, 10),
    },
    dependencies: depEntries.sort((a, b) => b.gzippedBytes - a.gzippedBytes),
    totalGzippedBytes: totalGzip,
    withinBudget: totalGzip < SIZE_BUDGET_BYTES && missing.length === 0,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const report = measure();
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log('@ship/sdk install footprint (PF-514)\n');
  console.log(`  method            ${report.method}`);
  console.log(`  dist              ${kb(report.dist.gzippedBytes)} gzipped (${report.dist.fileCount} files, ${kb(report.dist.rawBytes)} raw)`);
  console.log(`  production deps   ${report.productionDependencyCount}`);
  for (const dep of report.dependencies) console.log(`    - ${dep.name.padEnd(28)} ${kb(dep.gzippedBytes)}`);
  console.log(`  TOTAL             ${kb(report.totalGzippedBytes)}`);
  console.log(`  budget            ${kb(report.budgetBytes)}  (PRD p.9)`);
  console.log(`  report            ${relative(PACKAGE_ROOT, REPORT_PATH)}`);

  if (report.unresolvedDependencies.length > 0) {
    console.error(
      `\nFAIL: could not resolve ${report.unresolvedDependencies.join(', ')}. ` +
        `An unmeasured dependency is a hole in the number.`,
    );
    if (check) process.exit(1);
    return;
  }

  if (!report.withinBudget) {
    console.error(
      `\nFAIL: ${kb(report.totalGzippedBytes)} exceeds the ${kb(report.budgetBytes)} budget ` +
        `(PRD p.9, "SDK install size (production deps only)"). The largest contributors are ` +
        `listed above — a dependency, not dist, is almost always the cause.`,
    );
    if (check) process.exit(1);
    return;
  }

  console.log(`\nOK: within budget by ${kb(report.budgetBytes - report.totalGzippedBytes)}.`);
}

// Only run when invoked directly; the test imports `measure`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { measure, REPORT_PATH };
