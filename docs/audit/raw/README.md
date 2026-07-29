# Raw measurement data

Tool output behind every number in [`../audit-report.md`](../audit-report.md), kept because
p.10 asks the audit report to *"Include methodology, tools used, and raw data."*

Methodology and tools live in the report and in [`../scripts/`](../scripts/). This directory
is the third thing — what the tools actually emitted.

Every file here was produced by a committed script, so each number is re-derivable rather
than taken on trust.

| File | Category | Produced by | Contains |
|---|---|---|---|
| `cat3-results.json` | 3 API Response Time | `scripts/bench-api.sh` | k6 output — P50/P95/P99/max, request counts and failure rate for 5 endpoints × 10/25/50 VUs (15 runs) |
| `cat4-raw.json` | 4 Query Efficiency | `scripts/measure-queries.mjs` | Per-flow query counts, slowest statement, and repeated-shape clusters for the 5 user flows p.5 names |
| `cat6-raw.json` | 6 Runtime Errors | `scripts/measure-runtime-errors.mjs` | Console/network entries, malformed-input results, offline/reconnect cycle, 3G throttle timings |
| `cat7-keys.json` | 7 Accessibility | `scripts/measure-keyboard.mjs` | Arrow-key focus movement per composite widget, Enter/Space activation, focus-visibility sampling |
| `cat7-tree.json` | 7 Accessibility | `scripts/measure-a11y-tree.mjs` | Accessibility tree per page — interactive node counts, unnamed nodes by role, headings, landmarks |
| `cat7-tree-2.json` | 7 Accessibility | same script, second run | Reproducibility check. Byte-identical to `cat7-tree.json` |
| `viz-data.json` | 2 Bundle Size | `vite-bundle-visualizer` | Per-module `renderedLength` / `gzipLength`, the source for the dependency attribution table |
| `coverage-api.txt` | 5 Test Coverage | `pnpm --filter @ship/api test:coverage` | v8 coverage report, per-file and per-directory |
| `coverage-web.txt` | 5 Test Coverage | `vitest run --coverage --coverage.reportOnFailure` | v8 coverage report. `reportOnFailure` is required — 13 web tests fail and vitest suppresses the table otherwise |
| `e2e-run{1,2,3}-summary.txt` | 5 Test Coverage | `PLAYWRIGHT_WORKERS=4 pnpm test:e2e` | Pass/fail/flaky and named flaky tests for the three runs p.5 requires for flake sampling |
| `bundle-build-output.txt` | 2 Bundle Size | `pnpm build:web` | Vite chunk listing with raw and gzip sizes, including its own >500 kB chunk warning |
| `../bundle-treemap.html` | 2 Bundle Size | `vite-bundle-visualizer` | Interactive treemap (p.3 asks for one) |

## Not included, and why

**Terraform plan output.** `terraform plan` against the AWS configuration could not be run —
no credentials exist on this machine and p.7 states none are required. The exact error is
quoted in Category 8. The local-provider drift demonstration, which needs no cloud account,
was run for real and its before/after output is reproduced inline in the report.

**Screen reader transcript.** No live screen reader was driven. `voiceOver.detect()` returns
true but `start()` fails because `SCREnableAppleScript` is unset, a system toggle. The
accessibility tree a screen reader consumes was captured instead — `cat7-tree.json` — and the
report is explicit that this proves controls are unnamed but not that the speech is
comprehensible.

**Two-user concurrent editing.** Not performed; it needs two authenticated browser contexts
driven simultaneously. Marked incomplete in Category 6 rather than inferred from the
single-context results.

## Reproducing

Each script is single-command and re-runnable. Prerequisites: the app on `:5173`/`:3000`,
PostgreSQL seeded to p.4's minimums via `scripts/augment-seed.mjs`, and for Category 4,
`log_statement='all'`.

```bash
docs/audit/scripts/count-type-violations.py          # Cat 1
docs/audit/scripts/measure-bundle.py                 # Cat 2
docs/audit/scripts/bench-api.sh                      # Cat 3
node docs/audit/scripts/measure-queries.mjs          # Cat 4
docs/audit/scripts/measure-tests.py                  # Cat 5
node docs/audit/scripts/measure-runtime-errors.mjs   # Cat 6
docs/audit/scripts/measure-a11y.py                   # Cat 7
node docs/audit/scripts/measure-keyboard.mjs         # Cat 7
node docs/audit/scripts/measure-a11y-tree.mjs        # Cat 7
docs/audit/scripts/measure-terraform.py              # Cat 8
```
