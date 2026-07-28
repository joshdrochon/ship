#!/usr/bin/env python3
"""
Category 7 — accessibility compliance (p.7).

Canonical measurement. Re-run verbatim for the Phase 2 after-measurement so the
before/after run under identical conditions (Implementation Rule 1, p.9).

    docs/audit/scripts/measure-a11y.py              # axe + keyboard + Lighthouse
    docs/audit/scripts/measure-a11y.py --no-lighthouse
    docs/audit/scripts/measure-a11y.py --json

PREREQUISITE: the dev servers must already be running (`pnpm dev`) at
:5173 / :3000 with the database seeded. The script does not start them.

What it measures, mapped to p.7's five "How to Measure" bullets:

  1. Lighthouse accessibility score per major page  -> --lighthouse (default on).
     Authenticated pages are scored by replaying the session cookie captured
     from a real Playwright login into Lighthouse via --extra-headers.
  2. axe-core violations by severity                -> a11y-scan.mjs, two passes:
     the WCAG 2.1 AA + Section 508 tag set (the claim under test) and the full
     default rule set (adds axe "best-practice" rules).
  3. Keyboard navigation                            -> PARTIAL, by design. The
     driver Tabs through each page and diffs what receives focus against every
     element a keyboard user should reach. That proves *reachability* only.
     Operability (Enter/Escape/arrow keys), focus visibility and modal focus
     traps are NOT covered here and need a human.
  4. Screen reader                                  -> NOT AUTOMATED. No script
     can substitute for VoiceOver/NVDA. Nothing here should be read as a
     screen-reader result.
  5. Colour contrast vs 4.5:1                       -> axe color-contrast rule,
     with the measured ratio and the expected ratio per node.

Tooling: @axe-core/playwright 4.11.0 and @playwright/test are already declared
in the repo's root package.json, so no dependency was added. Lighthouse is run
through `npx lighthouse` (13.4.1) against the system Google Chrome; it is not
added to package.json.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DRIVER = Path(__file__).resolve().parent / 'a11y-scan.mjs'
IMPACTS = ('critical', 'serious', 'moderate', 'minor')

CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    shutil.which('google-chrome') or '',
    shutil.which('chromium') or '',
]


def alive(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status < 500
    except (urllib.error.URLError, OSError):
        return False


def run_axe(base, out_path):
    print('axe-core + keyboard traversal (Playwright) ...', file=sys.stderr)
    r = subprocess.run(
        ['node', str(DRIVER), '--base', base, '--out', str(out_path)],
        cwd=REPO, text=True, capture_output=True, timeout=1800)
    sys.stderr.write(r.stderr)
    if r.returncode != 0:
        sys.exit(f'axe driver failed (exit {r.returncode})')
    return json.loads(out_path.read_text())


def run_lighthouse(base, routes, cookies, workdir, form_factor='desktop'):
    chrome = next((c for c in CHROME_CANDIDATES if c and Path(c).exists()), None)
    if not chrome:
        print('  Chrome not found — skipping Lighthouse', file=sys.stderr)
        return {}
    cookie_hdr = '; '.join(f"{c['name']}={c['value']}" for c in cookies)
    hdr_file = workdir / 'lh-headers.json'
    hdr_file.write_text(json.dumps({'Cookie': cookie_hdr}))

    env = {**os.environ, 'CHROME_PATH': chrome}
    scores = {}
    for name, path in routes:
        outf = workdir / f"lh-{form_factor}-{name.replace('/', '_').replace(' ', '_')}.json"
        cmd = ['npx', '--yes', 'lighthouse@13', f'{base}{path}',
               '--only-categories=accessibility', '--output=json',
               f'--output-path={outf}', '--quiet',
               '--chrome-flags=--headless=new --no-sandbox --disable-gpu']
        if form_factor == 'desktop':
            # Lighthouse defaults to a 412x823 mobile viewport. Ship's 4-panel
            # layout does not render most of its controls at that width, so
            # dozens of audits come back notApplicable and the score is
            # flattered. Desktop matches the 1440x900 axe run.
            cmd.append('--preset=desktop')
        # The login page must be scored logged-OUT, so no cookie there.
        if path != '/login':
            cmd.append(f'--extra-headers={hdr_file}')
        print(f'  lighthouse {path} ...', file=sys.stderr)
        r = subprocess.run(cmd, cwd=REPO, env=env, text=True,
                           capture_output=True, timeout=300)
        if not outf.exists():
            scores[path] = {'name': name, 'score': None,
                            'error': (r.stderr or r.stdout)[-300:]}
            continue
        lh = json.loads(outf.read_text())
        cat = lh['categories']['accessibility']
        failed = [a for a in (lh['audits'][ref['id']] for ref in cat['auditRefs'])
                  if a.get('score') == 0 and a.get('scoreDisplayMode') == 'binary']
        scores[path] = {
            'name': name,
            'score': round((cat['score'] or 0) * 100),
            'failed_audits': sorted(a['id'] for a in failed),
            'n_a': sum(1 for ref in cat['auditRefs']
                       if lh['audits'][ref['id']].get('scoreDisplayMode') == 'notApplicable'),
            'report': str(outf),
        }
    return scores


def aggregate(data):
    rules = Counter()
    rule_impact = {}
    nodes_by_impact = Counter()
    rules_by_impact = Counter()
    contrast_nodes = 0
    contrast_worst = []
    aria_rules = Counter()
    ARIA_IDS = {
        'button-name', 'link-name', 'image-alt', 'input-image-alt', 'label',
        'aria-input-field-name', 'aria-toggle-field-name', 'aria-command-name',
        'aria-tooltip-name', 'aria-meter-name', 'aria-progressbar-name',
        'aria-required-attr', 'aria-required-children', 'aria-required-parent',
        'aria-roles', 'aria-valid-attr', 'aria-valid-attr-value',
        'aria-allowed-attr', 'aria-allowed-role', 'aria-hidden-focus',
        'aria-hidden-body', 'select-name', 'frame-title', 'empty-table-header',
        'form-field-multiple-labels', 'aria-dialog-name',
    }
    per_route = []
    for r in data['routes']:
        if not r.get('ok'):
            per_route.append({'name': r['name'], 'path': r['path'], 'error': r.get('error')})
            continue
        a = r['axe_wcag_508']
        for k in IMPACTS:
            rules_by_impact[k] += a['by_impact_rules'].get(k, 0)
            nodes_by_impact[k] += a['by_impact_nodes'].get(k, 0)
        for v in a['violations']:
            rules[v['id']] += v['nodes']
            rule_impact[v['id']] = v['impact']
            if v['id'] in ARIA_IDS:
                aria_rules[v['id']] += v['nodes']
        contrast_nodes += len(r['contrast'])
        for c in r['contrast']:
            if c.get('contrastRatio') is not None:
                contrast_worst.append((c['contrastRatio'], c.get('expectedContrastRatio'),
                                       r['name'], c['html'][:110]))
        k = r['keyboard']
        per_route.append({
            'name': r['name'], 'path': r['path'],
            'crit_serious_rules': a['by_impact_rules'].get('critical', 0) + a['by_impact_rules'].get('serious', 0),
            'crit_serious_nodes': a['by_impact_nodes'].get('critical', 0) + a['by_impact_nodes'].get('serious', 0),
            'total_rules': a['rule_violations'], 'total_nodes': a['node_violations'],
            'all_rules_nodes': r['axe_all_rules']['node_violations'],
            'contrast_nodes': len(r['contrast']),
            'expected_focusable': k['expected_focusable'], 'reached': k['reached'],
            'unreachable': k['unreachable_count'],
            'main': r['structure']['main'], 'h1': r['structure']['h1'],
            'nav': r['structure']['nav'], 'skip_link': r['structure']['skip_link'],
        })
    contrast_worst.sort(key=lambda t: t[0])
    return {
        'per_route': per_route,
        'rules_by_impact': dict(rules_by_impact),
        'nodes_by_impact': dict(nodes_by_impact),
        'top_rules': [(rid, rule_impact[rid], n) for rid, n in rules.most_common()],
        'contrast_nodes': contrast_nodes,
        'contrast_worst': contrast_worst[:15],
        'aria_rules': dict(aria_rules),
    }


def static_scan():
    """
    Source-level counts for the structural findings axe cannot see, because they
    are patterns rather than single-page defects. Regex heuristics — the window
    sizes are stated so the numbers can be argued with.
    """
    import re
    src = REPO / 'web' / 'src'
    files = [p for p in src.rglob('*') if p.suffix in ('.ts', '.tsx')]

    out = {'files_scanned': len(files)}
    outline_bare, outline_ok = [], 0
    opacity = Counter()
    aria_controls, ids_declared = [], set()
    tree_roles = Counter()
    for p in files:
        t = p.read_text(errors='replace')
        # focus:outline-none with no visible-focus replacement within +/-250 chars.
        for m in re.finditer(r'focus:outline-none', t):
            w = t[max(0, m.start() - 250):m.end() + 250]
            if re.search(r'focus:ring|focus-visible:|focus:border|focus:shadow', w):
                outline_ok += 1
            else:
                outline_bare.append(f"{p.relative_to(REPO)}:{t[:m.start()].count(chr(10)) + 1}")
        # Tailwind opacity modifiers on text colours: they divide the token's
        # contrast ratio without any check that the result still clears 4.5:1.
        for m in re.finditer(r'\btext-(muted|foreground|accent|border)/(\d+)\b', t):
            opacity[m.group(0)] += 1
        for m in re.finditer(r'aria-controls=\{?[`\'"]([^`\'"$}]*)', t):
            aria_controls.append((str(p.relative_to(REPO)), m.group(1)))
        for m in re.finditer(r'\bid=\{?[`\'"]([^`\'"$}]*)', t):
            ids_declared.add(m.group(1))
        for r in ('tree', 'treeitem', 'tab', 'tablist', 'tabpanel'):
            tree_roles[r] += len(re.findall(rf'role="{r}"', t))

    out['focus_outline_none_total'] = outline_ok + len(outline_bare)
    out['focus_outline_none_with_replacement'] = outline_ok
    out['focus_outline_none_bare'] = len(outline_bare)
    out['focus_outline_none_bare_locations'] = outline_bare
    out['opacity_modified_text_colors'] = dict(opacity)
    out['opacity_modified_total'] = sum(opacity.values())
    out['aria_controls_refs'] = aria_controls
    out['role_counts'] = dict(tree_roles)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://localhost:5173')
    ap.add_argument('--api', default='http://localhost:3000')
    ap.add_argument('--no-lighthouse', action='store_true')
    ap.add_argument('--form-factor', choices=['desktop', 'mobile', 'both'], default='both')
    ap.add_argument('--workdir', default='/tmp/ship-a11y')
    ap.add_argument('--reuse', action='store_true',
                    help='reuse an existing raw.json instead of re-scanning')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    work = Path(a.workdir)
    work.mkdir(parents=True, exist_ok=True)
    raw_path = work / 'raw.json'

    if not a.reuse:
        if not alive(a.base):
            sys.exit(f'web not reachable at {a.base} — start it with `pnpm dev`')
        if not alive(f'{a.api}/health'):
            sys.exit(f'api not reachable at {a.api}/health — start it with `pnpm dev`')

    data = json.loads(raw_path.read_text()) if a.reuse else run_axe(a.base, raw_path)

    lh = {}
    if not a.no_lighthouse:
        seen_paths = set()
        routes = []
        for r in data['routes']:
            if not r.get('ok') or r['path'] in seen_paths:
                continue
            seen_paths.add(r['path'])
            routes.append((r['name'], r['path']))
        lh = {ff: run_lighthouse(a.base, routes, data.get('cookies', []), work, ff)
              for ff in (['desktop', 'mobile'] if a.form_factor == 'both' else [a.form_factor])}
        (work / 'lighthouse.json').write_text(json.dumps(lh, indent=2))
    elif (work / 'lighthouse.json').exists():
        lh = json.loads((work / 'lighthouse.json').read_text())

    agg = aggregate(data)
    agg['lighthouse'] = lh
    agg['static'] = static_scan()

    if a.json:
        print(json.dumps(agg, indent=2))
        return

    print(f"\nraw scan: {raw_path}\n")
    print('Lighthouse accessibility score per page')
    print(f"{'page':<28} {'path':<34} {'desktop':>7} {'mobile':>7}  failed audits (desktop)")
    seen = set()
    for r in data['routes']:
        if r['path'] in seen:
            continue
        seen.add(r['path'])
        dv = lh.get('desktop', {}).get(r['path'], {})
        mv = lh.get('mobile', {}).get(r['path'], {})
        f = ','.join(dv.get('failed_audits', []) or []) or '—'
        print(f"{r['name'][:27]:<28} {r['path'][:33]:<34} "
              f"{str(dv.get('score', '—')):>7} {str(mv.get('score', '—')):>7}  {f}")

    print('\naxe-core violations. "wcag" columns = the WCAG 2.1 A/AA + Section 508 tag')
    print('set (the conformance claim under test); "all" = axe default rule set,')
    print('which adds axe best-practice rules on top.')
    print(f"{'page':<28} {'C+S rules':>9} {'C+S nodes':>9} {'wcag rules':>10} "
          f"{'wcag nodes':>10} {'all nodes':>9} {'contrast':>8}")
    for p in agg['per_route']:
        if 'error' in p:
            print(f"{p['name'][:27]:<28}  ERROR {p['error'][:60]}")
            continue
        print(f"{p['name'][:27]:<28} {p['crit_serious_rules']:>9} {p['crit_serious_nodes']:>9} "
              f"{p['total_rules']:>10} {p['total_nodes']:>10} {p['all_rules_nodes']:>9} "
              f"{p['contrast_nodes']:>8}")

    print('\nTotals across all scanned pages (WCAG/508 tag set)')
    for k in IMPACTS:
        print(f"  {k:<9} rules={agg['rules_by_impact'].get(k,0):>4}  "
              f"nodes={agg['nodes_by_impact'].get(k,0):>5}")
    cs_r = agg['rules_by_impact'].get('critical', 0) + agg['rules_by_impact'].get('serious', 0)
    cs_n = agg['nodes_by_impact'].get('critical', 0) + agg['nodes_by_impact'].get('serious', 0)
    print(f"  CRITICAL+SERIOUS  rules={cs_r}  nodes={cs_n}")

    print('\nViolated rules, ranked by node count')
    for rid, impact, n in agg['top_rules']:
        print(f"  {impact:<9} {rid:<34} {n:>5} nodes")

    print(f"\nColour-contrast failures (<4.5:1 text / <3:1 UI): {agg['contrast_nodes']} nodes")
    for ratio, expected, page, html in agg['contrast_worst']:
        print(f"  {ratio:>5}:1 (needs {expected})  {page[:22]:<22} {html[:70]}")

    print('\nKeyboard reachability (Tab traversal only — see caveat in docstring)')
    print(f"{'page':<28} {'expected':>8} {'reached':>8} {'unreachable':>11} "
          f"{'main':>5} {'h1':>3} {'skip':>5}")
    for p in agg['per_route']:
        if 'error' in p:
            continue
        print(f"{p['name'][:27]:<28} {p['expected_focusable']:>8} {p['reached']:>8} "
              f"{p['unreachable']:>11} {p['main']:>5} {p['h1']:>3} {p['skip_link']:>5}")

    print('\nARIA-name / role rule failures (node counts)')
    for rid, n in sorted(agg['aria_rules'].items(), key=lambda kv: -kv[1]):
        print(f"  {rid:<34} {n:>5}")
    if not agg['aria_rules']:
        print('  none')

    s = agg['static']
    print(f"\nSource-level patterns ({s['files_scanned']} .ts/.tsx files in web/src)")
    print(f"  focus:outline-none                 {s['focus_outline_none_total']:>4} "
          f"({s['focus_outline_none_with_replacement']} keep a visible indicator, "
          f"{s['focus_outline_none_bare']} do not)")
    print(f"  opacity-modified text colours      {s['opacity_modified_total']:>4}  "
          f"{s['opacity_modified_text_colors']}")
    print(f"  role= counts                            {s['role_counts']}")
    ac = {r for _, r in s['aria_controls_refs']}
    print(f"  aria-controls targets referenced        {sorted(ac)}")


if __name__ == '__main__':
    main()
