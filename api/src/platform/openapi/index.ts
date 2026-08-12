/**
 * openapi/ — the public OpenAPI 3.1 registry, generated from route metadata and
 * served at `/api/v1/openapi.json`.
 *
 * Deliberately separate from `api/src/openapi/` (the internal Swagger setup):
 * sharing that registry would publish ~130 internal paths as public contract.
 */
export { publicRegistry, generatePublicOpenAPIDocument } from './registry.js';
