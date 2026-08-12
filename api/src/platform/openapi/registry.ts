/**
 * PUBLIC OpenAPI 3.1 registry — separate from the internal one on purpose:
 * the public spec is a versioned contract; the internal swagger is a tool.
 *
 * Generated from route metadata (Zod schemas registered beside handlers),
 * never hand-written. Two tests guard it:
 *   1. unit: generated document validates against the OpenAPI 3.1 schema
 *   2. fitness: every /api/v1 route ↔ spec entry parity (drift fails CI)
 *
 * Generation failure at boot = process refuses to start (see architecture.md
 * Failure Modes — serving traffic without the contract is the drift we exist
 * to prevent).
 */
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const publicRegistry = new OpenAPIRegistry();
export { z };

publicRegistry.registerComponent('securitySchemes', 'oauth2Bearer', {
  type: 'http',
  scheme: 'bearer',
  description: 'OAuth 2.0 access token issued by /oauth/token.',
});

export function generatePublicOpenAPIDocument(): unknown {
  const generator = new OpenApiGeneratorV31(publicRegistry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Public API',
      version: '1.0.0',
      description: 'The public, versioned Ship platform API. Base path: /api/v1',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ oauth2Bearer: [] }],
  });
}
