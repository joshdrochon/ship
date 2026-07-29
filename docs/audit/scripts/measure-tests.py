#!/usr/bin/env python3
"""
Category 5 — test counts, runtime and coverage (p.5-6).

Canonical measurement. Re-run verbatim for the Phase 2 after-measurement so the
before/after run under identical conditions (Implementation Rule 1, p.9).

    docs/audit/scripts/measure-tests.py              # unit suites + coverage
    docs/audit/scripts/measure-tests.py --e2e        # also run E2E (~10 min)
    docs/audit/scripts/measure-tests.py --e2e-runs 3 # flake sampling

WARNING: the api suite TRUNCATES the dev database (api/src/test/setup.ts, F22).
This script reseeds afterwards unless --no-reseed is passed.

Notes baked in so the numbers reproduce:
  * web coverage needs --coverage.reportOnFailure; vitest defaults it false and
    the 13 failing web tests would otherwise suppress the whole report.
  * E2E needs PLAYWRIGHT_WORKERS=4; the config sizes its pool from os.freemem(),
    which is meaningless on macOS and clamps to 1 worker (F24).
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


def run(cmd, env=None, timeout=2400):
    import os
    e = {**os.environ, **(env or {})}
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, env=e, timeout=timeout)
    return ANSI.sub('', r.stdout + r.stderr)


def parse_vitest(out):
    d = {}
    m = re.search(r'Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)', out)
    if m:
        d['failed'], d['passed'], d['total'] = int(m.group(1) or 0), int(m.group(2)), int(m.group(4))
    m = re.search(r'Duration\s+([\d.]+)(m?s)', out)
    if m:
        d['duration_s'] = float(m.group(1)) / (1000 if m.group(2) == 'ms' else 1)
    m = re.search(r'All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)', out)
    if m:
        d['coverage'] = {'stmts': float(m.group(1)), 'branch': float(m.group(2)),
                         'funcs': float(m.group(3)), 'lines': float(m.group(4))}
    return d


def parse_playwright(out):
    d = {}
    for key, pat in [('passed', r'(\d+) passed'), ('failed', r'(\d+) failed'),
                     ('flaky', r'(\d+) flaky')]:
        m = re.search(rf'^\s*{pat}', out, re.M)
        d[key] = int(m.group(1)) if m else 0
    m = re.search(r'\((\d+(?:\.\d+)?)m\)', out)
    if m:
        d['duration_min'] = float(m.group(1))
    d['flaky_tests'] = re.findall(r'^\s+\d+\) \[chromium\] › (\S+)', out, re.M)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--e2e', action='store_true')
    ap.add_argument('--e2e-runs', type=int, default=1)
    ap.add_argument('--no-reseed', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    res = {}

    print('api unit + coverage ...', file=sys.stderr)
    res['api'] = parse_vitest(run(['pnpm', '--filter', '@ship/api', 'test:coverage', '--run']))

    print('web unit + coverage ...', file=sys.stderr)
    res['web'] = parse_vitest(run(
        ['pnpm', '--filter', '@ship/web', 'exec', 'vitest', 'run', '--coverage',
         '--coverage.reportOnFailure', '--coverage.reporter=text']))

    if not a.no_reseed:
        print('reseeding (api suite truncated the DB) ...', file=sys.stderr)
        run(['pnpm', 'db:seed'])
        run(['node', 'docs/audit/scripts/augment-seed.mjs'])

    if a.e2e:
        res['e2e'] = []
        for i in range(a.e2e_runs):
            print(f'e2e run {i+1}/{a.e2e_runs} (~10 min) ...', file=sys.stderr)
            res['e2e'].append(parse_playwright(
                run(['pnpm', 'test:e2e'], env={'PLAYWRIGHT_WORKERS': '4'})))

    specs = sorted((REPO / 'e2e').glob('*.spec.ts'))
    res['e2e_spec_files'] = len(specs)
    res['e2e_declared_tests'] = sum(
        len(re.findall(r'^\s*test\(', p.read_text(errors='replace'), re.M)) for p in specs)

    if a.json:
        print(json.dumps(res, indent=2))
        return

    for pkg in ('api', 'web'):
        d = res[pkg]
        c = d.get('coverage', {})
        print(f"{pkg:<5} {d.get('passed',0):>4} passed  {d.get('failed',0):>3} failed  "
              f"{d.get('duration_s',0):>7.2f}s   "
              f"cov {c.get('stmts',0):>6.2f}% stmts / {c.get('branch',0):>6.2f}% branch")
    print(f"e2e   {res['e2e_declared_tests']} declared tests across {res['e2e_spec_files']} spec files")
    for i, r in enumerate(res.get('e2e', []), 1):
        print(f"  run {i}: {r['passed']} passed  {r['failed']} failed  "
              f"{r['flaky']} flaky  {r.get('duration_min','?')}m")


if __name__ == '__main__':
    main()
