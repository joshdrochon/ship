/**
 * Filesystem locations for the regression-budget artifacts.
 *
 * Deliberately its own module, importing nothing: `perf-measure.ts` pulls in
 * `createApp()` — which starts timers and other handles that outlive an import —
 * so anything that only needs a *path* must not reach for it.
 *
 * That is not hypothetical. `perf-compare.test.ts` originally read
 * `BASELINE_PATH` via a dynamic import of `perf-measure.js`, and importing
 * `app.js` into a vitest worker that runs files sequentially (`fileParallelism:
 * false`) made three unrelated assertions in `src/routes/iterations.test.ts`
 * fail — a file that passes alone and passed in a 145-file run with this one
 * excluded. Splitting the constants out removes the import and the interference
 * with it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `api/src/scripts/lib` -> repo root. */
export const REPO = join(HERE, '..', '..', '..', '..');

/** The +10% budget's denominator. Schema: `docs/baseline-schema.md`. */
export const BASELINE_PATH = join(REPO, 'docs', 'baseline-part1.json');

/** Built web assets the bundle-size figure is measured from. */
export const WEB_DIST = join(REPO, 'web', 'dist', 'assets');
