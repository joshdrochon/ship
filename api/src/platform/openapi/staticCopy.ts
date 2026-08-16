/**
 * PF-368 — writing the committed static copy of the PUBLIC spec.
 *
 * The logic lives here rather than in `src/scripts/` so a test can import it
 * without also running it: a script whose module body writes a file cannot be
 * imported by the test that checks what it writes.
 *
 * **Not** the internal spec. `pnpm openapi:generate` calls `generateOpenApiFile()`
 * in `api/src/swagger.ts`, which writes the internal 3.0 document to
 * `api/openapi.json` and `api/openapi.yaml`. Different spec, different OpenAPI
 * version, different path, different audience. One script writing both would be
 * one command whose failure mode is publishing ~130 internal routes as public
 * contract.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePublicOpenAPIDocumentOrDie } from './registry.js';

/** Repo-root-relative destination. Exported so the test does not restate it. */
export const PUBLIC_SPEC_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/openapi.json',
);

/**
 * Serialises the generated document to `destination`, defaulting to
 * `docs/openapi.json`.
 *
 * Two-space indent and a trailing newline. The file is committed and diffed by
 * CI (PF-369), so it has to be stable under `git diff` and readable in a review
 * — and it has to be byte-identical on a re-run, or the freshness job flaps and
 * gets turned off within a week.
 *
 * ## Why `destination` is a parameter
 *
 * So a TEST never has to write to the committed artifact. `staticCopy.test.ts`
 * exercises this function for real, and while the default was the only option
 * that meant running the suite REWROTE `docs/openapi.json` — which is how the
 * audit trail disappeared from a graded deliverable as a side effect of `pnpm
 * test`, and, worse, how the failure hid: the test asserts on the file it
 * mutates, so the first run failed, rewrote the file to match its own smaller
 * output, and the second run passed. Alternating red/green on identical code.
 *
 * A test that can be made to pass by running it twice is not measuring
 * anything. Tests pass a temp path; only `pnpm openapi:public` takes the
 * default.
 */
export function writePublicSpec(destination: string = PUBLIC_SPEC_FILE): string {
  const document = generatePublicOpenAPIDocumentOrDie();
  const json = `${JSON.stringify(document, null, 2)}\n`;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, json, 'utf8');
  return destination;
}
