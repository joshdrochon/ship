/**
 * PF-558 — a deliberate violation, pointed at `integrations/cli` specifically.
 *
 * L01's PF-012 ships one generic fixture under `eslint-fixtures/integrations/`.
 * This one exists because the CLI is the must-ship reference integration and
 * "the rule fires somewhere" is not the same claim as "the rule fires on the
 * package whose whole value is that it has no privileged path".
 *
 * `pnpm lint` MUST reject this file with fence 3's
 * `BOUNDARY (integrations → server)` message. `scripts/check-boundary-lint.mjs`
 * asserts exactly that, matching on the rule id AND the marker, so a fixture
 * that merely failed to parse could not pass.
 *
 * NOTHING IMPORTS THIS FILE. It is excluded from every tsconfig and is not part
 * of any build.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { createDocumentsRouter } from '../../../api/src/routes/documents';

export const violation = createDocumentsRouter;
