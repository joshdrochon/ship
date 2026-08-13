/**
 * PF-378 — the spec-side walk, exported for L18. And nothing more.
 *
 * Testing Scenario 5 has two halves:
 *
 *   1. the generated spec validates against the OpenAPI 3.1 schema  → **L13**
 *      (`schemaValidation.test.ts`)
 *   2. every spec method has a typed SDK call                        → **L18**
 *
 * This module is the seam between them. L13 owns the spec-side enumeration and
 * the stable `operationId` (PF-364); L18 imports `listSpecOperations` and
 * asserts the SDK side. L13 asserts **nothing** about the SDK, and this file
 * imports nothing from `sdk/` — `specOperations.test.ts` proves both.
 *
 * If L18's file, when written, contains its own spec parser, that is duplication
 * to flag rather than a second opinion: two walks of one document are two
 * definitions of "every operation", and the wrong one is always the one that
 * passes.
 */
import type { OpenAPIObject, OperationObject, PathItemObject } from 'openapi3-ts/oas31';

/** One operation in the generated document. */
export interface SpecOperation {
  /** Stable across generations — see `operationIdFor` (PF-364). */
  operationId: string;
  /** Lower-case HTTP method. */
  method: string;
  /** The `paths` key, e.g. `/documents/{id}` — no `/api/v1` prefix. */
  path: string;
  /** The scopes this operation's security requirement names. `[]` if none. */
  scopes: string[];
}

/**
 * The HTTP methods a `paths` entry may carry. Enumerated rather than read as
 * `Object.keys(pathItem)`, which would also yield `parameters`, `summary`,
 * `description`, `servers` and `$ref` and report them as operations.
 */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Every operation in `spec`, in document order. */
export function listSpecOperations(spec: OpenAPIObject): SpecOperation[] {
  const operations: SpecOperation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as PathItemObject)[method] as OperationObject | undefined;
      if (!operation) continue;

      operations.push({
        // Falls back to a derived id rather than throwing: this function's job is
        // to report what the document says, and a document missing an
        // operationId is a finding for PF-364's test, not an exception here.
        operationId: operation.operationId ?? `${method}${path}`,
        method,
        path,
        scopes: scopesOf(operation),
      });
    }
  }

  return operations;
}

/**
 * The scopes named by an operation's security requirement.
 *
 * Flattened across schemes because there is exactly one scheme
 * (`PUBLIC_SECURITY_SCHEME`) and a caller asking "what does this need" does not
 * want a nested map to answer it. An operation with `security: []` — the
 * unauthenticated spec route — yields `[]`, which is the truth.
 */
function scopesOf(operation: OperationObject): string[] {
  const requirements = operation.security ?? [];
  const scopes = new Set<string>();
  for (const requirement of requirements) {
    for (const names of Object.values(requirement)) {
      for (const name of names) scopes.add(name);
    }
  }
  return [...scopes];
}
