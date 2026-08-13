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
 * Serialises the generated document to `docs/openapi.json`.
 *
 * Two-space indent and a trailing newline. The file is committed and diffed by
 * CI (PF-369), so it has to be stable under `git diff` and readable in a review
 * — and it has to be byte-identical on a re-run, or the freshness job flaps and
 * gets turned off within a week.
 */
export function writePublicSpec(): string {
  const document = generatePublicOpenAPIDocumentOrDie();
  const json = `${JSON.stringify(document, null, 2)}\n`;
  mkdirSync(dirname(PUBLIC_SPEC_FILE), { recursive: true });
  writeFileSync(PUBLIC_SPEC_FILE, json, 'utf8');
  return PUBLIC_SPEC_FILE;
}
