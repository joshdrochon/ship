/**
 * `pnpm openapi:public` — writes `docs/openapi.json` (PF-368).
 *
 * The entry point, and deliberately thin: the logic is in
 * `platform/openapi/staticCopy.ts` so `staticCopy.test.ts` can import it without
 * also running it.
 *
 * Every operation is registered by the `declareV1Route()` call at the top of its
 * route module, so a module nobody imports contributes nothing to the document.
 * That import list used to live here, and in two test files, and the three
 * disagreed — which is not a loud failure but a quiet one: the short list wins
 * and the spec comes out smaller than the API.
 *
 * The list now lives once, in `platform/api/v1/allRoutes.ts`, checked against
 * the directory listing by `allRoutes.test.ts`.
 */
import '../platform/api/v1/allRoutes.js';
// Not a resource module — `GET /api/v1/openapi.json` is served by the openapi
// lane itself, so it registers here rather than in the resource manifest.
import '../platform/openapi/route.js';
import { writePublicSpec } from '../platform/openapi/staticCopy.js';

const file = writePublicSpec();
console.log(`Wrote the public OpenAPI 3.1 spec to ${file}`);
