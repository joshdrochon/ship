#!/usr/bin/env python3
"""
Category 1 — type safety violation counts (p.3).

Canonical measurement. Re-run verbatim for the Phase 2 after-measurement so the
before/after numbers are comparable (Implementation Rule 1, p.9).

    docs/audit/scripts/count-type-violations.py             # totals by package
    docs/audit/scripts/count-type-violations.py --by-file    # ranked per file
    docs/audit/scripts/count-type-violations.py --by-file -n 5

Counts LINES containing a violation, not occurrences — a line with two casts counts
once. Lines inside block comments and lines that are pure `//` comments are skipped,
so commented-out code and prose containing the word "any" do not inflate the count.

Buckets are mutually exclusive by design:
  any   explicit `any` in type position, including `as any`
  as    type assertion to a concrete type, EXCLUDING `as any` (already in `any`)
        and `as const` (a widening guard, not a safety escape)
  !     non-null assertion (`x!.y`, `x!)`, `x!,`) — not `!=`, `!==`, or logical not
  @ts   @ts-ignore / @ts-expect-error / @ts-nocheck
"""

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PACKAGES = ['api/src', 'web/src', 'shared/src']

ANY = re.compile(r':\s*any\b|<any>|<any,|,\s*any>|\bas\s+any\b|\bany\[\]')
AS = re.compile(r'\bas\s+(?!any\b|const\b)([A-Z_{(]|string\b|number\b|boolean\b|unknown\b)')
BANG = re.compile(r'[A-Za-z0-9_)\]]!(?:[.,;)\]}\s]|$)')
TS = re.compile(r'@ts-(?:ignore|expect-error|nocheck)\b')
IMPORT_LINE = re.compile(r'^\s*(?:import|export)\b')


def scan(path: Path):
    """Return (any, as, bang, ts, loc) line-hit counts for one file."""
    counts = [0, 0, 0, 0]
    loc = 0
    in_block = False
    try:
        lines = path.read_text(errors='replace').splitlines()
    except OSError:
        return (*counts, 0)

    for raw in lines:
        loc += 1
        line = raw

        # Strip block comments; @ts- directives inside them still count as present
        # in source, but code patterns should not.
        if in_block:
            if '*/' in line:
                in_block = False
                line = line.split('*/', 1)[1]
            else:
                if TS.search(raw):
                    counts[3] += 1
                continue
        if '/*' in line:
            before, _, rest = line.partition('/*')
            if '*/' in rest:
                line = before + rest.split('*/', 1)[1]
            else:
                in_block = True
                line = before

        stripped = line.strip()
        if stripped.startswith('//'):
            if TS.search(stripped):
                counts[3] += 1
            continue

        if TS.search(line):
            counts[3] += 1
        if ANY.search(line):
            counts[0] += 1
        if not IMPORT_LINE.match(line) and AS.search(line):
            counts[1] += 1
        if BANG.search(line):
            counts[2] += 1

    return (*counts, loc)


def files():
    out = []
    for pkg in PACKAGES:
        base = REPO / pkg
        if not base.is_dir():
            continue
        for ext in ('*.ts', '*.tsx'):
            out += sorted(base.rglob(ext))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--by-file', action='store_true')
    ap.add_argument('-n', type=int, default=0, help='limit rows in --by-file')
    args = ap.parse_args()

    rows = []
    for f in files():
        a, s, b, t, loc = scan(f)
        total = a + s + b + t
        if total:
            rows.append((str(f.relative_to(REPO)), a, s, b, t, total, loc))

    if args.by_file:
        rows.sort(key=lambda r: (-r[5], r[0]))
        if args.n:
            rows = rows[:args.n]
        print(f"{'FILE':<52}{'any':>5}{'as':>5}{'!':>5}{'@ts':>5}{'TOTAL':>7}{'LOC':>7}{'/100':>7}")
        print('-' * 93)
        for name, a, s, b, t, tot, loc in rows:
            print(f'{name:<52}{a:>5}{s:>5}{b:>5}{t:>5}{tot:>7}{loc:>7}{100*tot/loc:>7.1f}')
        return

    print(f"{'PACKAGE':<12}{'any':>7}{'as':>7}{'!':>7}{'@ts':>7}{'TOTAL':>9}{'FILES':>7}")
    print('-' * 56)
    grand = [0, 0, 0, 0, 0, 0]
    for pkg in PACKAGES:
        sub = [r for r in rows if r[0].startswith(pkg)]
        agg = [sum(r[i] for r in sub) for i in (1, 2, 3, 4, 5)]
        name = pkg.rsplit('/', 1)[0]
        print(f'{name:<12}{agg[0]:>7}{agg[1]:>7}{agg[2]:>7}{agg[3]:>7}{agg[4]:>9}{len(sub):>7}')
        for i in range(5):
            grand[i] += agg[i]
        grand[5] += len(sub)
    print('-' * 56)
    print(f"{'TOTAL':<12}{grand[0]:>7}{grand[1]:>7}{grand[2]:>7}{grand[3]:>7}{grand[4]:>9}{grand[5]:>7}")


if __name__ == '__main__':
    sys.exit(main())
