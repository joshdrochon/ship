#!/usr/bin/env python3
"""
Category 2 — initial-load bundle size (p.3-4, Target B).

`measure-bundle.py` reports the size of everything in `web/dist`. Code splitting
does not change that number: a lazy chunk still ships to the CDN, it just is not
downloaded on first paint. Target B is about what the browser must fetch *before
it can render the first route*, so it needs its own measurement.

The initial-load set is read off the built `dist/index.html` exactly as a browser
would resolve it:

  * the entry `<script type="module" src=...>`
  * every `<link rel="modulepreload" href=...>` — Vite emits one per statically
    imported chunk reachable from the entry, i.e. the transitive static closure
  * every `<link rel="stylesheet" href=...>`

Chunks reached only through `import()` are not listed in index.html, which is the
whole point: they are the deferred part.

Run verbatim on both sides of a change (Implementation Rule 1, p.9):

    docs/audit/scripts/measure-initial-load.py            # rebuild, then measure
    docs/audit/scripts/measure-initial-load.py --no-build # measure existing web/dist
    docs/audit/scripts/measure-initial-load.py --json     # machine-readable
"""

import argparse
import gzip
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DIST = REPO / 'web' / 'dist'
INDEX = DIST / 'index.html'

SCRIPT_SRC = re.compile(r'<script[^>]*\btype=["\']module["\'][^>]*\bsrc=["\']([^"\']+)["\']')
MODULEPRELOAD = re.compile(r'<link[^>]*\brel=["\']modulepreload["\'][^>]*\bhref=["\']([^"\']+)["\']')
STYLESHEET = re.compile(r'<link[^>]*\brel=["\']stylesheet["\'][^>]*\bhref=["\']([^"\']+)["\']')


def build():
    r = subprocess.run(['pnpm', 'build:web'], cwd=REPO, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout[-3000:], file=sys.stderr)
        sys.exit('build failed')


def resolve(href: str) -> Path:
    """Map an index.html href onto a file inside dist."""
    return DIST / href.lstrip('/').split('?')[0]


def measure(paths):
    total = 0
    gz = 0
    rows = []
    for p in paths:
        if not p.is_file():
            sys.exit(f'referenced by index.html but not in dist: {p}')
        b = p.read_bytes()
        total += len(b)
        gz += len(gzip.compress(b))
        rows.append((p.name, len(b)))
    return total, gz, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    if not a.no_build:
        build()
    if not INDEX.is_file():
        sys.exit(f'{INDEX} does not exist — run without --no-build')

    html = INDEX.read_text()
    entry = [resolve(h) for h in SCRIPT_SRC.findall(html)]
    preload = [resolve(h) for h in MODULEPRELOAD.findall(html)]
    css = [resolve(h) for h in STYLESHEET.findall(html)]
    if not entry:
        sys.exit('no module entry script found in index.html')

    js_paths = entry + preload
    js_bytes, js_gz, js_rows = measure(js_paths)
    css_bytes, css_gz, _ = measure(css)
    html_bytes = INDEX.stat().st_size

    all_js = [p for p in DIST.rglob('*.js') if p.is_file()]
    deferred = [p for p in all_js if p not in set(js_paths)]

    out = {
        'initial_bytes': js_bytes + css_bytes + html_bytes,
        'initial_gzip_bytes': js_gz + css_gz + len(gzip.compress(INDEX.read_bytes())),
        'initial_js_bytes': js_bytes,
        'initial_js_files': len(js_paths),
        'initial_css_bytes': css_bytes,
        'html_bytes': html_bytes,
        'entry_chunk': entry[0].name,
        'entry_chunk_bytes': entry[0].stat().st_size,
        'deferred_js_bytes': sum(p.stat().st_size for p in deferred),
        'deferred_js_files': len(deferred),
        'initial_js_breakdown': sorted(js_rows, key=lambda r: -r[1]),
    }

    if a.json:
        print(json.dumps(out, indent=2))
        return

    kb = lambda n: f'{n:,} B ({n/1024:.1f} kB)'
    print(f"initial load (total)  {kb(out['initial_bytes'])}")
    print(f"  gzip                {kb(out['initial_gzip_bytes'])}")
    print(f"  JS                  {kb(out['initial_js_bytes'])} across {out['initial_js_files']} files")
    print(f"  CSS                 {kb(out['initial_css_bytes'])}")
    print(f"  index.html          {kb(out['html_bytes'])}")
    print(f"\nentry chunk           {out['entry_chunk']}")
    print(f"                      {kb(out['entry_chunk_bytes'])}")
    print(f"\ndeferred JS           {kb(out['deferred_js_bytes'])} across {out['deferred_js_files']} files")
    print('\ninitial JS breakdown (top 15)')
    for name, size in out['initial_js_breakdown'][:15]:
        print(f"  {name:<48}{kb(size)}")


if __name__ == '__main__':
    main()
