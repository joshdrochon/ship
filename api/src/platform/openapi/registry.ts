/**
 * The PUBLIC OpenAPI 3.1 registry — deliberately NOT the internal one.
 *
 * Tickets: PF-351 (a distinct registry), PF-352 (double `extendZodWithOpenApi`),
 * PF-353 (`OpenApiGeneratorV31`, typed document), PF-355 (`info` + `servers`),
 * PF-356 (the security scheme carries the scope list), PF-357 (generation
 * failure refuses the boot).
 *
 * PRD Critical Guidance (p.11): *"Generate the OpenAPI spec; do not write it.
 * Hand-written specs lie within a week. Every public route's request/response
 * schema lives in Zod adjacent to the handler; the generator walks them."*
 *
 * ## Why this is a second registry and not a shared one (F12)
 *
 * `api/src/openapi/registry.ts` already builds an `OpenAPIRegistry`. It is not
 * reusable here, and the reason is not aesthetic:
 *
 *   - It emits `openapi: '3.0.0'` through `OpenApiGeneratorV3`, typed against
 *     `openapi3-ts/oas30`. MVP gate item 7 (p.2) asks for **3.1**, so sharing it
 *     fails the gate on the version alone.
 *   - It holds ~130 `registerPath()` calls for internal `/api/*` routes, declared
 *     in `api/src/openapi/schemas/*.ts` — a directory detached from every
 *     handler, with no test binding a registration to a real route. Sharing one
 *     instance would publish the entire internal surface as public contract and
 *     break the p.3 boundary.
 *
 * So: **same npm dependency, separate everything else.** Separate registry,
 * separate generator, separate route, separate static output, separate tests.
 * `registry.test.ts` asserts the two documents' `paths` share zero keys and that
 * nothing under `platform/openapi/` imports `api/src/openapi/`.
 *
 * ## PF-352 — `extendZodWithOpenApi(z)` is called twice in this process
 *
 * Once here, once in the internal registry, against the same `zod` singleton.
 * The ticket offered two resolutions: hoist to one shared module both import, or
 * keep both calls and prove double-extension is idempotent. **Kept both**, and
 * the test is `registry.test.ts`'s "double extension" case: hoisting would mean
 * either `platform/openapi/` importing `api/src/openapi/` (which PF-351's grep
 * assertion forbids) or the internal module importing platform code (the
 * boundary backwards). Two calls plus a test that imports both registries in one
 * process is the option that does not weaken a fence to remove a duplicate line.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';
import { scopeRegistry } from '../scopes/scopes.js';
import { apiErrorBodySchema } from '../api/v1/errors.js';

extendZodWithOpenApi(z);

/** The public registry. One instance, and it is not the internal one. */
export const publicRegistry = new OpenAPIRegistry();

export { z };

/**
 * PF-355 — the version, declared once.
 *
 * `info.version` is read from here by the generator and by the static-copy
 * script. A literal repeated in two places is two versions the day one of them
 * is bumped.
 */
export const PUBLIC_API_VERSION = '1.0.0';

/** The base URL an SDK concatenates a `paths` key onto. See PF-355. */
export const PUBLIC_API_SERVER_URL = '/api/v1';

/** The name of the security scheme every scoped operation references. */
export const PUBLIC_SECURITY_SCHEME = 'shipOAuth2';

/**
 * PF-361 — the shared error component's name in `components.schemas`.
 *
 * The shape itself is `apiErrorBodySchema` (L07's PF-199) and is registered, not
 * restated. There is exactly one definition of the envelope in the repo.
 */
export const API_ERROR_COMPONENT = 'ApiError';

/**
 * PF-356 — OAuth2, not http-bearer, and the scopes come from `ScopeRegistry`.
 *
 * **This is a decision, and it contradicts the sketch this module replaced**,
 * which registered `{ type: 'http', scheme: 'bearer' }`. An http-bearer scheme
 * has no `scopes` object at all, so a spec using one cannot say which scope any
 * route requires — and PRD p.3 makes scope-per-route the contract. Every
 * operation's `security` requirement then carries its declared scope, so a
 * reader of the spec alone can answer "what do I need to call this".
 *
 * The scope list is built from `scopeRegistry.list()` rather than typed out, so
 * adding a scope without regenerating fails `registry.test.ts` rather than
 * silently shipping a spec that under-reports the API's own permissions.
 *
 * `authorizationCode` and `clientCredentials` are both declared because both are
 * live: L04/L05 issue authorization-code tokens for user-present apps, and D5a
 * settled the agent on client credentials.
 */
function scopesObject(): Record<string, string> {
  return Object.fromEntries(scopeRegistry.list().map((def) => [def.scope, def.description]));
}

function registerSecurityScheme(registry: OpenAPIRegistry): void {
  registry.registerComponent('securitySchemes', PUBLIC_SECURITY_SCHEME, {
    type: 'oauth2',
    description:
      'OAuth 2.0 access token, presented as `Authorization: Bearer <token>`. ' +
      'Every operation lists the scopes it requires.',
    flows: {
      authorizationCode: {
        authorizationUrl: '/oauth/authorize',
        tokenUrl: '/oauth/token',
        refreshUrl: '/oauth/token',
        scopes: scopesObject(),
      },
      clientCredentials: {
        tokenUrl: '/oauth/token',
        scopes: scopesObject(),
      },
    },
  });
}

function registerErrorComponent(registry: OpenAPIRegistry): void {
  // PF-361 — generated from L07's schema. `grep -rn "apiErrorBodySchema"` is the
  // proof there is one definition of the envelope; this module adds no second one.
  registry.register(API_ERROR_COMPONENT, apiErrorBodySchema);
}

/**
 * Components that must exist on any registry this module generates from.
 *
 * Registered lazily rather than at module load so a test can build a throwaway
 * registry and get the same components without importing a half-initialised
 * singleton. The singleton gets them immediately below.
 */
export function registerPublicComponents(registry: OpenAPIRegistry): void {
  registerSecurityScheme(registry);
  registerErrorComponent(registry);
}

registerPublicComponents(publicRegistry);

/**
 * Test-isolation escape hatch. **Not for production code.**
 *
 * Same species as `RouteMetadataRegistry.clear()` and `clearRouteAssertions()`,
 * and it exists for one reason: PF-357 has to prove that `createApp()` — which
 * generates from THIS singleton — refuses to boot when generation fails. An
 * injected fixture registry would exercise a seam the composition root does not
 * use, so the sabotage has to land on the real one and be undone afterwards.
 *
 * `registry.definitions` is a getter that returns a NEW array (it concatenates
 * parent registries), so truncating what it returns does nothing. This closure
 * captures the count and splices the private list back, which is the only way to
 * undo a `registerPath` — the library offers no removal API.
 */
export function snapshotPublicRegistry(): () => void {
  const internals = publicRegistry as unknown as { _definitions: unknown[] };
  const count = internals._definitions.length;
  return () => {
    internals._definitions.length = count;
  };
}

/**
 * PF-353 — generate the document. `OpenApiGeneratorV31`, `openapi3-ts/oas31`,
 * and a **typed** return.
 *
 * The sketch returned `unknown`, which makes every downstream assertion untyped:
 * the parity walk, the validator test and `listSpecOperations` would each cast,
 * and a cast is a place where a wrong assumption survives compilation.
 *
 * Copying the internal module instead would have given `OpenApiGeneratorV3` +
 * `oas30` + `'3.0.0'`, which fails MVP gate item 7 on the version string.
 */
export function generatePublicOpenAPIDocument(
  registry: OpenAPIRegistry = publicRegistry,
): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Public API',
      version: PUBLIC_API_VERSION,
      description:
        'The public, versioned Ship platform API.\n\n' +
        'Generated from route metadata — every operation below is produced by the same ' +
        '`declareV1Route()` call that mounts its Express handler, so an endpoint cannot ' +
        'exist without appearing here and cannot appear here without existing.',
    },
    servers: [{ url: PUBLIC_API_SERVER_URL, description: 'This deployment.' }],
  });
}

/**
 * PF-357 — generation at boot, and a generation failure that refuses the boot.
 *
 * **This is our decision, not the PRD's.** p.12 only requires the architecture
 * document to contain a Failure Modes paragraph about it; it prescribes no
 * behaviour. `docs/architecture.md:394` answers "the process refuses to start",
 * and this function is that answer. The defensible alternative is
 * boot-and-serve-503 on the spec route, so an unrelated schema bug cannot take
 * the whole API down during a graded demo. Fail-fast was kept because it matches
 * the committed architecture document, and because a server running without its
 * contract is precisely the drift this lane exists to prevent.
 *
 * The rethrow names the offending operation. `zod-to-openapi` throws
 * `UnknownZodTypeError` carrying `currentSchema`, but nothing in its message
 * says which route pulled the schema in — and "Unknown zod object type" with no
 * path is a message that costs an hour.
 */
export function generatePublicOpenAPIDocumentOrDie(
  registry: OpenAPIRegistry = publicRegistry,
): OpenAPIObject {
  try {
    return generatePublicOpenAPIDocument(registry);
  } catch (cause) {
    const detail = describeGenerationFailure(cause, registry);
    throw new Error(
      `The public OpenAPI document could not be generated, so the process is refusing ` +
        `to start.\n\n${detail}\n\n` +
        `Serving /api/v1 without its generated contract is the drift the spec↔route parity ` +
        `test exists to prevent (docs/architecture.md, Failure Modes). Fix the offending ` +
        `route's Zod schema — every public route's request/response schema lives in Zod ` +
        `adjacent to its handler (PRD p.11).`,
      { cause },
    );
  }
}

/**
 * Best-effort attribution of a generation failure to a `METHOD /path`.
 *
 * Generation is all-or-nothing, so the thrown error does not say which route
 * caused it. Re-running the generator one path at a time does say — and it only
 * runs on a boot that is already failing, so its cost is irrelevant.
 */
function describeGenerationFailure(cause: unknown, registry: OpenAPIRegistry): string {
  // `zod-to-openapi` throws structured objects, not always `Error`s —
  // `UnknownZodTypeError` is a plain object with `{ currentSchema, ... }`, and
  // `String(it)` is "[object Object]", which is worse than useless in a boot
  // failure. JSON is the readable form for the non-Error case.
  const message =
    cause instanceof Error
      ? cause.message
      : (() => {
          try {
            return JSON.stringify(cause);
          } catch {
            return String(cause);
          }
        })();

  for (const definition of registry.definitions) {
    if (definition.type !== 'route') continue;
    const route = definition.route;
    try {
      new OpenApiGeneratorV31([definition]).generateDocument({
        openapi: '3.1.0',
        info: { title: 'probe', version: '0' },
      });
    } catch {
      return (
        `Offending operation: ${route.method.toUpperCase()} ${route.path}\n` +
        `Generator error: ${message}`
      );
    }
  }

  return `Generator error: ${message}`;
}
