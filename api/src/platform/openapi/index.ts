/**
 * openapi/ — the public OpenAPI 3.1 registry, generated from route metadata and
 * served at `/api/v1/openapi.json`.
 *
 * Deliberately separate from `api/src/openapi/` (the internal Swagger setup):
 * that registry emits 3.0 and holds ~130 `registerPath()` calls for internal
 * `/api/*` routes, so sharing one instance would publish the entire internal
 * surface as public contract (finding F12). Same npm dependency, separate
 * everything else. `registry.test.ts` asserts zero path-key overlap.
 */
export {
  publicRegistry,
  generatePublicOpenAPIDocument,
  generatePublicOpenAPIDocumentOrDie,
  registerPublicComponents,
  PUBLIC_API_VERSION,
  PUBLIC_API_SERVER_URL,
  PUBLIC_SECURITY_SCHEME,
  API_ERROR_COMPONENT,
} from './registry.js';
export { registerV1Operation, operationIdFor, toOpenApiPath } from './operations.js';
export { mountOpenApiSpec, OPENAPI_SPEC_PATH } from './route.js';
export { listSpecOperations, type SpecOperation } from './specOperations.js';
export { registerOpenApiParityAssertions } from './specParity.js';
