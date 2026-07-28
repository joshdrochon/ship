#!/usr/bin/env python3
"""
Category 2 — production bundle size (p.3-4).

Canonical measurement. Re-run verbatim for the Phase 2 after-measurement so the
before/after run under identical conditions (Implementation Rule 1, p.9).

    docs/audit/scripts/measure-bundle.py            # rebuild, then measure
    docs/audit/scripts/measure-bundle.py --no-build # measure existing web/dist
    docs/audit/scripts/measure-bundle.py --json     # machine-readable

Reports total output size, per-extension breakdown, gzipped JS+CSS, the largest
chunk, chunk count, and unused production dependencies.
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
SRC = REPO / 'web' / 'src'
SEARCH_EXTRA = ['web/index.html', 'web/vite.config.ts',
                'web/tailwind.config.js', 'web/postcss.config.js']


def build():
    r = subprocess.run(['pnpm', 'build:web'], cwd=REPO,
                       capture_output=True, text=True)
    if r.returncode:
        print(r.stdout[-3000:], file=sys.stderr)
        sys.exit('build failed')


def unused_deps():
    pkg = json.loads((REPO / 'web' / 'package.json').read_text())
    deps = [d for d in pkg.get('dependencies', {}) if d != '@ship/shared']
    hay = []
    for p in SRC.rglob('*'):
        if p.suffix in ('.ts', '.tsx', '.css', '.js'):
            hay.append(p.read_text(errors='replace'))
    for extra in SEARCH_EXTRA:
        f = REPO / extra
        if f.exists():
            hay.append(f.read_text(errors='replace'))
    blob = '\n'.join(hay)
    return [d for d in deps if not re.search(rf'''['"]{re.escape(d)}(/|['"])''', blob)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    if not a.no_build:
        build()
    if not DIST.is_dir():
        sys.exit(f'{DIST} does not exist — run without --no-build')

    files = [p for p in DIST.rglob('*') if p.is_file()]
    by_ext = {}
    for p in files:
        by_ext.setdefault(p.suffix.lstrip('.') or 'none', []).append(p)

    js = by_ext.get('js', [])
    css = by_ext.get('css', [])
    gz = sum(len(gzip.compress(p.read_bytes())) for p in js + css)
    largest = max(js, key=lambda p: p.stat().st_size) if js else None

    out = {
        'total_bytes': sum(p.stat().st_size for p in files),
        'total_files': len(files),
        'js_bytes': sum(p.stat().st_size for p in js),
        'js_files': len(js),
        'css_bytes': sum(p.stat().st_size for p in css),
        'gzip_js_css_bytes': gz,
        'largest_chunk': largest.name if largest else None,
        'largest_chunk_bytes': largest.stat().st_size if largest else 0,
        'largest_chunk_gzip': len(gzip.compress(largest.read_bytes())) if largest else 0,
        'unused_dependencies': unused_deps(),
    }

    if a.json:
        print(json.dumps(out, indent=2))
        return

    kb = lambda n: f'{n:,} B ({n/1024:.1f} kB)'
    print(f"total dist            {kb(out['total_bytes'])} across {out['total_files']} files")
    for ext, ps in sorted(by_ext.items(), key=lambda kv: -sum(p.stat().st_size for p in kv[1]))[:5]:
        print(f"  .{ext:<18}{kb(sum(p.stat().st_size for p in ps)):<28}{len(ps)} files")
    print(f"\ngzip (JS+CSS)         {kb(out['gzip_js_css_bytes'])}")
    print(f"chunk count (JS)      {out['js_files']}")
    print(f"largest chunk         {out['largest_chunk']}")
    print(f"                      {kb(out['largest_chunk_bytes'])} raw / "
          f"{kb(out['largest_chunk_gzip'])} gzip")
    share = 100 * out['largest_chunk_bytes'] / out['js_bytes'] if out['js_bytes'] else 0
    print(f"                      {share:.1f}% of all JS")
    print(f"\nunused dependencies   {out['unused_dependencies'] or 'none'}")


if __name__ == '__main__':
    main()
