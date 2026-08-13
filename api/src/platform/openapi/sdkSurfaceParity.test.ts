/**
 * TESTING SCENARIO 5, SECOND HALF — PF-528 – PF-532.
 *
 * PRD p.5: *"Validate the generated /api/v1/openapi.json against the OpenAPI 3.1
 * JSON schema. Then walk every spec method and assert the SDK exposes a typed
 * call for it."*
 *
 * The first sentence is L13's (`schemaValidation.test.ts`). The second sentence
 * is this file, and it is what makes the SDK provably complete rather than
 * plausibly complete.
 *
 * ── Why this file lives in `api/` ───────────────────────────────────────────
 * ESLint fence 4 (L99 F24) forbids `sdk/**` from importing anything in this
 * repository, so the SDK cannot read the spec and cannot import
 * `listSpecOperations`. The dependency runs the only direction that is allowed:
 * `@ship/api` takes `@ship/sdk` as a devDependency and exercises it as an
 * external consumer would — through the published entry point. Same arrangement
 * as `sdkGate.test.ts`.
 *
 * ── ONE parser, and it is L13's (PF-528's ⚑ clause) ─────────────────────────
 * `listSpecOperations` (PF-378) is the only implementation of "every spec
 * operation" in this repository. There is no second walk here, none under
 * `sdk/`, and §5 below greps for one — because Scenario 5 comparing two parsers
 * would be measuring their agreement with each other rather than the spec's
 * agreement with the SDK, and the wrong one is always the one that passes.
 *
 * ── What each section proves ────────────────────────────────────────────────
 *   §1  PF-532  neither side is empty — 0 of 0 operations bound is 100%
 *   §2  PF-528  forward: every spec operation resolves to a CALLABLE SDK method
 *   §3  PF-530  signature: parameters and return shape, not just existence
 *   §4  PF-531  reverse: every public SDK method resolves to a spec operation
 *   §5  PF-528  the no-second-parser grep, and the binding is not a heuristic
 *   §6  PF-532  the guards really fire — proven against fixtures, not asserted
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OpenAPIObject, OperationObject, ParameterObject } from 'openapi3-ts/oas31';
import {
  ShipClient,
  OPERATION_BINDINGS,
  BINDING_BY_OPERATION_ID,
  resolveBoundMethod,
  listPublicMethodPaths,
  type OperationBinding,
} from '@ship/sdk';
import { generatePublicOpenAPIDocumentOrDie } from './registry.js';
import { listSpecOperations, type SpecOperation } from './specOperations.js';

// Side-effect imports: an operation exists in the registry because its module
// was loaded. Same list as `staticCopy.test.ts` (L99 F52's checklist item 2) —
// a resource missing here is a resource this test would silently not check.
import '../api/v1/documents/routes.js';
import '../api/v1/issues/routes.js';
import '../api/v1/sprints/routes.js';
import '../api/v1/me/routes.js';
import '../api/v1/webhooks/routes.js';
import './route.js';

const SPEC: OpenAPIObject = generatePublicOpenAPIDocumentOrDie();
const OPERATIONS: SpecOperation[] = listSpecOperations(SPEC);

/** A client with a static token — nothing here makes a request. */
const CLIENT = new ShipClient({ token: 'parity', baseUrl: 'https://ship.invalid' });

/** The raw operation object behind a `SpecOperation`. */
function operationObject(operation: SpecOperation): OperationObject {
  const pathItem = SPEC.paths?.[operation.path] as Record<string, OperationObject> | undefined;
  const found = pathItem?.[operation.method];
  if (!found) throw new Error(`no operation object for ${operation.method} ${operation.path}`);
  return found;
}

function parametersIn(operation: SpecOperation, location: 'query' | 'path'): ParameterObject[] {
  return ((operationObject(operation).parameters ?? []) as ParameterObject[]).filter(
    (parameter) => parameter.in === location,
  );
}

/** Request-body property names, or `[]` for a bodyless verb. */
function requestBodyFields(operation: SpecOperation): string[] {
  const body = operationObject(operation).requestBody as
    | { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
    | undefined;
  const schema = body?.content?.['application/json']?.schema;
  return Object.keys(schema?.properties ?? {});
}

interface SuccessResponse {
  status: string;
  schema: { type?: string; properties?: Record<string, unknown> } | undefined;
}

/** The 2xx response and its JSON schema. */
function successResponse(operation: SpecOperation): SuccessResponse {
  const responses = operationObject(operation).responses as Record<
    string,
    { content?: Record<string, { schema?: SuccessResponse['schema'] }> }
  >;
  const status = Object.keys(responses).find((code) => code.startsWith('2'));
  if (status === undefined) {
    throw new Error(`${operation.operationId} declares no 2xx response`);
  }
  return { status, schema: responses[status]?.content?.['application/json']?.schema };
}

function describeOperation(operation: SpecOperation): string {
  return `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path})`;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('§1 · PF-532 — neither side can be empty, and the two failures are told apart', () => {
  it('the spec walk found operations', () => {
    expect(
      OPERATIONS.length,
      'listSpecOperations() returned ZERO operations, so every assertion below would pass ' +
        'without checking anything — 0 of 0 spec methods covered is 100%. Either no route ' +
        'module was imported before generation (registration happens at module load), or the ' +
        'routes were declared into a different registry instance.',
    ).toBeGreaterThan(0);
  });

  it('the SDK binding table is non-empty', () => {
    expect(
      OPERATION_BINDINGS.length,
      'OPERATION_BINDINGS is EMPTY, so the forward walk has nothing to match against and ' +
        'the reverse walk has nothing to check. This is the other way Scenario 5 passes ' +
        'vacuously, and it has a different cause from an empty spec: the table is data in ' +
        'sdk/src/operations.ts, not something generation produces.',
    ).toBeGreaterThan(0);
  });

  it('and the two sets are the SAME SIZE — a fact worth stating on its own', () => {
    // p.6 sets spec parity at 100%. This is that number, and it is only
    // meaningful because of the two guards above.
    expect(OPERATION_BINDINGS.length).toBe(OPERATIONS.length);
  });
});

describe('§2 · PF-528 — every spec operation has a typed SDK call', () => {
  it('names every unbound operationId and its METHOD /path', () => {
    const unbound = OPERATIONS.filter(
      (operation) => !BINDING_BY_OPERATION_ID.has(operation.operationId),
    );

    expect(
      unbound.map(describeOperation),
      `${unbound.length} spec operation(s) have no entry in the SDK's OPERATION_BINDINGS ` +
        `table. PRD p.5 requires that every spec method has a typed SDK call; a published ` +
        `operation the SDK cannot reach is a documented endpoint a consumer has to hand-roll ` +
        `a fetch for. Add the binding in sdk/src/operations.ts — the method it names is ` +
        `checked against the real classes at compile time, so the entry cannot be a promise.`,
    ).toEqual([]);
  });

  // One case per operation, so a failure report names the operation rather than
  // reporting "1 test failed".
  for (const operation of OPERATIONS) {
    it(`${describeOperation(operation)} → a callable SDK method`, () => {
      const binding = BINDING_BY_OPERATION_ID.get(operation.operationId);
      expect(binding, `no binding for ${operation.operationId}`).toBeDefined();

      const method = resolveBoundMethod(CLIENT, (binding as OperationBinding).call);
      expect(
        method,
        `the binding names \`${binding?.call}\` but that resolves to nothing callable on a ` +
          `constructed ShipClient. The type checker accepts the string because the method ` +
          `exists on the CLASS; this asserts it exists on the INSTANCE, which is what a ` +
          `consumer actually holds.`,
      ).toBeTypeOf('function');
    });
  }

  it('the binding agrees with the spec about METHOD and PATH, not just the id', () => {
    // An operationId is a name someone chose. If the table said `getDocuments`
    // pointed at `POST /issues`, the walk above would still be green.
    const mismatched = OPERATIONS.filter((operation) => {
      const binding = BINDING_BY_OPERATION_ID.get(operation.operationId);
      return (
        binding !== undefined &&
        (binding.method !== operation.method || binding.path !== operation.path)
      );
    }).map(
      (operation) =>
        `${operation.operationId}: spec says ${operation.method.toUpperCase()} ${operation.path}, ` +
        `binding says ${BINDING_BY_OPERATION_ID.get(operation.operationId)?.method.toUpperCase()} ` +
        `${BINDING_BY_OPERATION_ID.get(operation.operationId)?.path}`,
    );

    expect(mismatched).toEqual([]);
  });
});

describe('§3 · PF-530 — parity checks the SIGNATURE, not just that a method exists', () => {
  // p.4: *"Method signatures match OpenAPI spec; drift fails CI via a fitness
  // test."* Existence-only parity passes for a method taking `any` and returning
  // `any`, which is precisely the SDK a drift test is supposed to catch.

  for (const operation of OPERATIONS) {
    const binding = BINDING_BY_OPERATION_ID.get(operation.operationId);
    if (binding === undefined) continue;

    describe(describeOperation(operation), () => {
      it('covers every REQUIRED spec parameter', () => {
        const required = [...parametersIn(operation, 'path'), ...parametersIn(operation, 'query')]
          .filter((parameter) => parameter.required === true)
          .map((parameter) => parameter.name);
        const covered = new Set([...binding.pathParams, ...binding.queryParams]);
        const missing = required.filter((name) => !covered.has(name));

        expect(
          missing,
          `the SDK method \`${binding.call}\` cannot supply required parameter(s) ` +
            `${missing.join(', ')}. Every call it makes would be rejected.`,
        ).toEqual([]);
      });

      it('declares NO parameter the spec does not have', () => {
        const specNames = new Set(
          [...parametersIn(operation, 'path'), ...parametersIn(operation, 'query')].map(
            (parameter) => parameter.name,
          ),
        );
        const invented = [...binding.pathParams, ...binding.queryParams].filter(
          (name) => !specNames.has(name),
        );

        expect(
          invented,
          `the SDK method \`${binding.call}\` accepts ${invented.join(', ')}, which the spec ` +
            `does not declare. A consumer who sets one gets a silently ignored argument, ` +
            `which reads as "the API ignored my filter".`,
        ).toEqual([]);
      });

      it('its request-body fields are exactly the spec’s', () => {
        const specFields = requestBodyFields(operation).sort();
        expect(
          [...binding.bodyFields].sort(),
          `the SDK's input type for \`${binding.call}\` and the spec's request schema ` +
            `disagree. The spec's schema is .strict(), so an SDK field the spec does not ` +
            `have is a 422 naming a field the SDK's own types told the consumer to send — ` +
            `which is exactly how CreateDocumentInput.content shipped.`,
        ).toEqual(specFields);
      });

      it('its declared return matches the operation’s success response schema', () => {
        const response = successResponse(operation);
        const schema = response.schema;
        expect(schema, `${operation.operationId} has no JSON schema on ${response.status}`).toBeDefined();

        if (binding.returns.shape === 'opaque') {
          // The spec document itself. There is no closed field list to compare
          // and pretending otherwise would be a fake assertion.
          expect(schema?.type).toBe('object');
          return;
        }

        if (binding.returns.shape === 'page') {
          const properties = schema?.properties as
            | { data?: { items?: { properties?: Record<string, unknown> } } }
            | undefined;
          expect(
            Object.keys(schema?.properties ?? {}).sort(),
            `${operation.operationId} is bound as a page but its 200 body is not a page envelope`,
          ).toEqual(['data', 'next_cursor']);
          expect([...binding.returns.fields].sort()).toEqual(
            Object.keys(properties?.data?.items?.properties ?? {}).sort(),
          );
          return;
        }

        expect(
          [...binding.returns.fields].sort(),
          `the SDK's return type for \`${binding.call}\` and the spec's ${response.status} ` +
            `schema disagree field-for-field. A field the server returns and the SDK's type ` +
            `omits is invisible to every consumer; a field the type claims and the server ` +
            `does not send is \`undefined\` at runtime with no type error.`,
        ).toEqual(Object.keys(schema?.properties ?? {}).sort());
      });
    });
  }
});

describe('§4 · PF-531 — reverse parity: an SDK method with no spec operation fails, by name', () => {
  it('every public SDK method resolves to a bound spec operation', () => {
    // The forward walk structurally cannot catch this: a
    // `client.documents.archive()` calling a route that does not exist ships
    // happily and only a consumer finds out. Mirrors L13's PF-375 on the
    // spec↔route axis; this is the same direction one layer out.
    const bound = new Set<string>();
    for (const binding of OPERATION_BINDINGS) {
      bound.add(binding.call);
      for (const alias of binding.aliasCalls ?? []) bound.add(alias);
    }

    const invented = listPublicMethodPaths(CLIENT).filter((path) => !bound.has(path));

    expect(
      invented,
      `${invented.length} public SDK method(s) appear in no binding: ${invented.join(', ')}. ` +
        `Each one either calls a route that does not exist — which ships happily and only a ` +
        `consumer finds out — or is a real capability nobody wrote a binding for, which means ` +
        `Scenario 5 is not walking it. Add it to OPERATION_BINDINGS (as \`call\`, or as an ` +
        `\`aliasCalls\` entry if it is a second spelling of an existing operation).`,
    ).toEqual([]);
  });

  it('the reverse walk really found methods — it cannot pass by finding none', () => {
    const paths = listPublicMethodPaths(CLIENT);
    expect(paths.length).toBeGreaterThanOrEqual(OPERATION_BINDINGS.length);
    // Spot-check the shape, so a `listPublicMethodPaths` that returned garbage
    // strings would not pass by having none of them collide.
    expect(paths).toContain('documents.list');
    expect(paths).toContain('webhooks.rotate');
    expect(paths).toContain('me');
  });

  it('every binding’s `call` and aliases resolve — no binding points at a phantom', () => {
    const unresolved: string[] = [];
    for (const binding of OPERATION_BINDINGS) {
      for (const path of [binding.call, ...(binding.aliasCalls ?? [])]) {
        if (resolveBoundMethod(CLIENT, path) === null) {
          unresolved.push(`${binding.operationId} → ${path}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe('§5 · PF-528 ⚑ — exactly ONE implementation of "every spec method" exists', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SDK_SRC = resolve(HERE, '../../../../sdk/src');

  function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else if (full.endsWith('.ts')) found.push(full);
    }
    return found;
  }

  const sdkSources = walk(SDK_SRC);

  it('the SDK reads no OpenAPI document, in any module', () => {
    expect(sdkSources.length, 'the SDK source walk found nothing').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of sdkSources) {
      const source = readFileSync(file, 'utf8')
        // Comments are prose about the design and are not a second parser. The
        // header of `operations.ts` says the words "openapi.json" on purpose.
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      // What a SECOND PARSER looks like, and what it does not.
      //
      // The string `'/openapi.json'` is a URL — `ShipClient.openapi()` calls the
      // spec route, which is one of the 19 operations Scenario 5 walks, and
      // banning the literal would ban the SDK from exposing an operation the
      // spec declares. The first version of this assertion did exactly that and
      // flagged `client.ts` for reaching an endpoint. What is actually banned is
      // the machinery for READING an OpenAPI document: a spec library, the
      // spec's own type names, or a walk of `paths` / a path item.
      const bannedImport = /from ['"](openapi3-ts|swagger-parser|@apidevtools\/|@readme\/openapi|js-yaml|yaml)/;
      const specTypeNames = /\b(OpenAPIObject|PathItemObject|OperationObject|OpenAPIV3)\b/;
      // Anchored on the RECEIVER, not on `.paths` alone: `transport.paths` in a
      // pagination test is a list of request URLs, and an unanchored `.paths`
      // flagged it. What a parser looks like is `spec.paths` / `document.paths`
      // / `openApiDoc.paths`.
      const walksSpecPaths = /\b(spec|document|openapi|oas)\w*\.paths\b/i;

      if (
        bannedImport.test(source) ||
        specTypeNames.test(source) ||
        walksSpecPaths.test(source)
      ) {
        offenders.push(relative(SDK_SRC, file));
      }
    }

    expect(
      offenders,
      `these SDK modules parse an OpenAPI document: ${offenders.join(', ')}. L13's ` +
        `listSpecOperations (PF-378) is the ONE implementation of "every spec operation" in ` +
        `this repository, and Scenario 5 exists to compare a spec with an SDK — not to ` +
        `compare two parsers, where the wrong one is always the one that passes.`,
    ).toEqual([]);
  });

  it('and that grep is not vacuous — it catches a parser when one is present', () => {
    // Without this, a regex that matches nothing passes forever and the ⚑
    // clause is decoration.
    const bannedImport = /from ['"](openapi3-ts|swagger-parser|@apidevtools\/|@readme\/openapi|js-yaml|yaml)/;
    const specTypeNames = /\b(OpenAPIObject|PathItemObject|OperationObject|OpenAPIV3)\b/;
    const walksSpecPaths = /\b(spec|document|openapi|oas)\w*\.paths\b/i;

    expect(bannedImport.test(`import type { X } from 'openapi3-ts/oas31';`)).toBe(true);
    expect(specTypeNames.test('function f(spec: OpenAPIObject) {}')).toBe(true);
    expect(walksSpecPaths.test('for (const [p, item] of Object.entries(spec.paths)) {}')).toBe(true);
    // and a URL literal is NOT a parser, which is the distinction that matters.
    expect(bannedImport.test(`request('GET', '/openapi.json')`)).toBe(false);
    expect(specTypeNames.test(`request('GET', '/openapi.json')`)).toBe(false);
    expect(walksSpecPaths.test(`request('GET', '/openapi.json')`)).toBe(false);
    // and a request-URL log named `paths` is not a spec walk — the false
    // positive this regex was narrowed to exclude.
    expect(walksSpecPaths.test('expect(transport.paths).toHaveLength(3);')).toBe(false);
  });

  it('this file uses L13’s exporter and defines no walk of its own', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(self).toContain('listSpecOperations');
    // The read helpers above index `SPEC.paths` for ONE known operation the
    // exporter already reported. That is a lookup, not an enumeration — and the
    // difference is that they cannot discover an operation, only describe one.
    expect(self).not.toMatch(/for\s*\(\s*const\s*\[\s*path\s*,/);
  });

  it('the binding is data, not a path-string heuristic (PF-529)', () => {
    // A heuristic deriving `documents.list` from `/documents` also "matches" a
    // route the SDK never implemented. Proven by counter-example: two bindings
    // whose method names a heuristic could not have produced from the path.
    const rotate = OPERATION_BINDINGS.find((b) => b.operationId === 'postWebhooksByIdRotate');
    expect(rotate?.call).toBe('webhooks.rotate');
    const patchIssue = OPERATION_BINDINGS.find((b) => b.operationId === 'patchIssuesById');
    // `PATCH /issues/{id}` → `update`, a name that appears nowhere in the path.
    expect(patchIssue?.call).toBe('issues.update');
    const spec = OPERATION_BINDINGS.find((b) => b.operationId === 'getOpenapiJson');
    expect(spec?.call).toBe('openapi');
  });
});

describe('§6 · PF-532 — the guards FIRE, proven against fixtures rather than asserted', () => {
  // A guard nobody has seen fail is a guard nobody knows works.

  it('an added spec operation with no SDK binding is caught, and named', () => {
    // The fixture PR the ticket describes, as a fixture rather than a PR.
    const withPhantom: OpenAPIObject = {
      ...SPEC,
      paths: {
        ...SPEC.paths,
        '/widgets': {
          get: {
            operationId: 'getWidgets',
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    };

    const unbound = listSpecOperations(withPhantom).filter(
      (operation) => !BINDING_BY_OPERATION_ID.has(operation.operationId),
    );

    expect(unbound.map((o) => o.operationId)).toEqual(['getWidgets']);
    expect(unbound.map(describeOperation)[0]).toBe('getWidgets (GET /widgets)');
  });

  it('an invented SDK method is caught by the reverse walk, and named', () => {
    const bound = new Set<string>();
    for (const binding of OPERATION_BINDINGS) {
      bound.add(binding.call);
      for (const alias of binding.aliasCalls ?? []) bound.add(alias);
    }

    // `client.documents.archive()` — the ticket's own example.
    const withInvented = [...listPublicMethodPaths(CLIENT), 'documents.archive'];
    const invented = withInvented.filter((path) => !bound.has(path));

    expect(invented).toEqual(['documents.archive']);
  });

  it('an empty operation list is caught rather than passing as 100%', () => {
    const empty: OpenAPIObject = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} };
    expect(listSpecOperations(empty)).toEqual([]);
    // Which is what §1's first assertion refuses.
  });

  it('a signature drift is caught — a spec field the SDK type does not have', () => {
    const binding = BINDING_BY_OPERATION_ID.get('postIssues') as OperationBinding;
    const drifted = [...requestBodyFields(
      OPERATIONS.find((o) => o.operationId === 'postIssues') as SpecOperation,
    ), 'estimate'].sort();

    expect([...binding.bodyFields].sort()).not.toEqual(drifted);
  });
});
