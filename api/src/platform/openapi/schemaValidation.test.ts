/**
 * S4 — MVP gate item 7's *"validating against the OpenAPI schema in a unit
 * test"* half, and Testing Scenario 5's first half.
 *
 * Tickets: PF-370 (a real 3.1 validator, proven to reject), PF-371 (the
 * generated document validates, printing every error path on failure), PF-372
 * (the SERVED BYTES validate, not only the in-process object).
 *
 * Runs in the `api` vitest suite that CI invokes (`.gitlab-ci.yml`'s `test` job,
 * `.github/workflows/ci.yml`'s `test` job), so it gates every PR rather than only
 * the E2E run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { createBearerTestApp } from '../oauth/bearerTestSupport.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { validateOpenApi31, OPENAPI_31_SCHEMA_URI } from './schemaValidation.js';
import { generatePublicOpenAPIDocument } from './registry.js';
import { mountOpenApiSpec, OPENAPI_SPEC_PATH } from './route.js';
// The WHOLE public surface, not one resource. This was
// `import '../api/v1/documents/routes.js'`, which meant MVP gate item 7's claim
// — "OpenAPI 3.1 validated in a unit test" — was true of 3 operations out of 23.
// A schema error anywhere in issues, sprints, me, webhooks or audit validated
// green here because those paths were not in the document being validated.
// `allRoutes.ts` is the single manifest; `allRoutes.test.ts` checks it against
// the directory listing.
import '../api/v1/allRoutes.js';
import { V1_ROUTE_MODULES } from '../api/v1/allRoutes.js';

const malformed = JSON.parse(
  readFileSync(new URL('./fixtures/malformed-spec.json', import.meta.url), 'utf8'),
);

describe('PF-370 — the validator is real and it rejects', () => {
  it('rejects the committed malformed fixture', async () => {
    const result = await validateOpenApi31(malformed);
    expect(
      result.valid,
      'A validator that accepts everything passes exactly as green as a correct one. ' +
        'This fixture is what makes the positive result below mean something.',
    ).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // Rejected for the reasons the fixture encodes, not incidentally. Without
    // this, deleting a violation from the fixture would leave the test green
    // and nobody would know the coverage had shrunk.
    const joined = result.errors.join('\n');
    expect(joined, 'info.version is required').toMatch(/\/info/);
    expect(joined, 'responses must be an object').toMatch(/\/paths\/~1things\/get\/responses/);
    expect(joined, 'a parameter needs schema or content').toMatch(
      /\/paths\/~1things~1\{id\}\/get\/parameters\/0/,
    );
  });

  it('rejects a Swagger 2.0 document — it is a 3.1 validator, not a generic one', async () => {
    const result = await validateOpenApi31({ swagger: '2.0', info: { title: 'x', version: '1' } });
    expect(result.valid).toBe(false);
  });

  it('rejects an OpenAPI 3.0 document — the version pattern is ^3\\.1\\.', async () => {
    // The failure a 3.0-era validator would NOT catch, and the one MVP gate
    // item 7 turns on: the gate says 3.1, and copying the internal module would
    // have produced 3.0.0 here.
    const result = await validateOpenApi31({
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: {},
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a minimal but valid 3.1 document — it is not rejecting everything', async () => {
    // The other half of "proven to reject": a validator that rejects everything
    // is equally useless and equally green if you only test the negative case.
    const result = await validateOpenApi31({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } },
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates against a pinned meta-schema URI, not a moving alias', () => {
    expect(OPENAPI_31_SCHEMA_URI).toBe('https://spec.openapis.org/oas/3.1/schema-base');
  });
});

describe('PF-371 — the generated document validates', () => {
  it('validate(generatePublicOpenAPIDocument()) passes', async () => {
    const result = await validateOpenApi31(generatePublicOpenAPIDocument());
    // Every error path printed, not just `false`. A test that reports
    // `expected false to be true` against a 40 KB document costs an hour.
    expect(result.errors.join('\n')).toBe('');
    expect(result.valid).toBe(true);
  });

  it('and the document it validated is the WHOLE surface', () => {
    // MVP gate item 7 says the spec is validated in a unit test. "The spec"
    // means all of it. With only `documents/routes.js` imported, the assertion
    // above ran against 3 operations and reported the gate satisfied — a schema
    // error in any other resource validated green because it was not in the
    // document. Passing on a subset is the same vacuity as passing on nothing,
    // scaled.
    const paths = Object.keys(generatePublicOpenAPIDocument().paths ?? {});
    const missing = V1_ROUTE_MODULES.filter(
      (resource) => !paths.some((path) => path.split('/')[1] === resource),
    );

    expect(
      missing,
      `${missing.join(', ')} contribute no path to the validated document, so the validation ` +
        `above says nothing about them. Registration happens at module load — check the ` +
        `import of allRoutes.js.`,
    ).toEqual([]);
  });
});

describe('PF-372 — the SERVED BYTES validate, not only the in-process object', () => {
  it('fetches /api/v1/openapi.json, JSON.parses the text, and validates that', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(generatePublicOpenAPIDocument()),
    });

    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    expect(res.status).toBe(200);

    // `res.text`, deliberately — parsing the raw body is what catches the class
    // of damage PF-371 structurally cannot: `undefined` values silently dropped
    // by JSON.stringify, a Date stringified, `res.send(object)` re-typing the
    // body. Testing Scenario 5 names the URL, not the function.
    const parsed = JSON.parse(res.text);
    const result = await validateOpenApi31(parsed);
    expect(result.errors.join('\n')).toBe('');
    expect(result.valid).toBe(true);
  });

  it('the served text is not empty and is a JSON object', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(generatePublicOpenAPIDocument()),
    });
    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    expect(res.text.length).toBeGreaterThan(1000);
    expect(res.text.trimStart().startsWith('{')).toBe(true);
  });
});
