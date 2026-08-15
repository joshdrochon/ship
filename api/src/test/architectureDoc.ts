/**
 * The architecture documentation, as one string — for the tests that latch on it.
 *
 * WHY THIS EXISTS
 *
 * Fifteen test files assert on the *prose* of `docs/architecture.md` by reading
 * it and matching against it. That is a deliberate and good pattern: it is what
 * stops the document drifting away from the code it describes, and it is why a
 * reworded paragraph is caught rather than discovered by a grader.
 *
 * PRD p.13 caps the Architecture Document at 1–2 pages. Meeting that cap meant
 * cutting `docs/architecture.md` from 859 lines to 149 and moving the depth —
 * the rejected alternatives, the measured numbers, the five sequence diagrams —
 * into `docs/architecture-appendix.md`. Every latch pointed at the first file
 * only, so the move turned **57 tests across 13 files** red at once, none of
 * them describing a real defect.
 *
 * Those numbers are the history, not the current state. `docs/architecture.md`
 * has since grown well past 149 lines, because p.12 requires nine named sections
 * with specific content and satisfying that contract costs more lines than the
 * p.13 cap allows. Where the two collide, p.12's content contract wins and the
 * overrun is stated rather than hidden. Do not re-trim the document to chase 149
 * — that is what caused the incident this seam exists to absorb. `wc -l` is the
 * authority on its length; no comment or submission table should carry a copy.
 *
 * The latches were not wrong. Their target simply became two files, and this is
 * the seam that says so in one place instead of thirteen. A future move between
 * the two documents is now invisible to every test that only cares that the
 * claim is documented *somewhere* in the architecture material.
 *
 * If a test genuinely needs to assert that something is in the SUBMITTED
 * document specifically — the one under the length cap — it should read
 * `docs/architecture.md` directly and say why in a comment. `platform-layout`
 * is the case that does this: p.12 requires Module Layout in the submitted doc,
 * so a latch satisfied by the appendix would let the required section go
 * missing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `api/src/test` → repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const ARCHITECTURE_MAIN = join(REPO_ROOT, 'docs', 'architecture.md');
export const ARCHITECTURE_APPENDIX = join(REPO_ROOT, 'docs', 'architecture-appendix.md');

/**
 * Both documents concatenated, in reading order.
 *
 * Read fresh on each call rather than cached at import: several of these suites
 * run in the same worker, and a cached copy would hide an edit made between
 * files during a watch run.
 */
export function architectureText(): string {
  return `${readFileSync(ARCHITECTURE_MAIN, 'utf8')}\n${readFileSync(ARCHITECTURE_APPENDIX, 'utf8')}`;
}

/**
 * The appendix alone.
 *
 * For latches that pin a specific DIAGRAM. Both documents carry the same nine
 * headings, so a latch that does `split('## OAuth Flows')[1].split('```')[1]`
 * against the concatenation lands on the FIRST match — the submitted document,
 * whose OAuth section is a table — and then walks forward to the next fence it
 * finds, which is the appendix's Module Layout. It fails with a diff between a
 * mermaid participant line and a directory tree, which reads like nonsense and
 * takes a while to recognise as a slicing bug rather than a doc defect.
 *
 * The diagrams live here. A latch on a diagram should say so.
 */
export function architectureAppendixText(): string {
  return readFileSync(ARCHITECTURE_APPENDIX, 'utf8');
}
