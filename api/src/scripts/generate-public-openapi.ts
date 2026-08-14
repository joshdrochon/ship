/**
 * `pnpm openapi:public` — writes `docs/openapi.json` (PF-368).
 *
 * The entry point, and deliberately thin: the logic is in
 * `platform/openapi/staticCopy.ts` so `staticCopy.test.ts` can import it without
 * also running it.
 *
 * What this file owns is the IMPORT LIST below. Every operation is registered by
 * the `declareV1Route()` call at the top of its route module, so a module nobody
 * imports contributes nothing to the document. This is the one place that list
 * repeats, and PF-369's freshness job is what makes forgetting an entry show up
 * as a `git diff` rather than as a silently smaller spec.
 */
import '../platform/api/v1/documents/routes.js';
import '../platform/api/v1/issues/routes.js';
import '../platform/api/v1/sprints/routes.js';
import '../platform/api/v1/me/routes.js';
import '../platform/api/v1/webhooks/routes.js';
import '../platform/openapi/route.js';
import { writePublicSpec } from '../platform/openapi/staticCopy.js';

const file = writePublicSpec();
console.log(`Wrote the public OpenAPI 3.1 spec to ${file}`);
