/**
 * L07 S1 — the closed six-code contract, as data.
 *
 * PF-186 (closed union), PF-187 (ApiError class), PF-188 (status map),
 * PF-189 (SDK kind map, 6→5).
 *
 * The point of every assertion here is drift. Each map is `Record<ApiErrorCode, …>`,
 * so a MISSING key is already a type error; what type-check cannot catch is the
 * literal values silently changing away from what the PRD prints on p.7 and what
 * the SDK's union declares. That is what these tests pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ERROR_CODES,
  STATUS_BY_CODE,
  SDK_KINDS,
  SDK_KIND_BY_CODE,
  ApiError,
  type ApiErrorCode,
} from './errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_ERRORS_FILE = join(HERE, '..', '..', '..', '..', '..', 'sdk', 'src', 'errors.ts');

describe('PF-186 — ApiErrorCode is a closed union derived from one array', () => {
  it('deep-equals the code set printed in the PRD (p.7)', () => {
    // Written out longhand on purpose. If someone adds a seventh code, this
    // fails and they have to come read the B14 dispute in lane-99 before
    // widening a union that L17's PF-498 asserts key-equality against.
    expect([...API_ERROR_CODES]).toEqual([
      'unauthorized',
      'forbidden',
      'not_found',
      'validation_failed',
      'rate_limited',
      'server_error',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('is the only definition — no hand-typed second copy of the union', () => {
    // PF-186's real criterion: the type is DERIVED, so a second copy cannot
    // drift. Proven structurally — `ApiErrorCode` is `typeof API_ERROR_CODES[number]`,
    // which this assignment only compiles if it holds.
    const fromArray: ApiErrorCode = API_ERROR_CODES[0];
    expect(fromArray).toBe('unauthorized');

    const source = readFileSync(join(HERE, 'errors.ts'), 'utf8');
    expect(source, 'ApiErrorCode must be derived from API_ERROR_CODES, not retyped').toContain(
      'export type ApiErrorCode = (typeof API_ERROR_CODES)[number];',
    );
  });
});

describe('PF-187 — ApiError class', () => {
  it('is a real Error with a usable stack', () => {
    const err = new ApiError('not_found', 'No such document.');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('ApiError');
    expect(err.message).toBe('No such document.');
    expect(typeof err.stack).toBe('string');
    // The stack should point at this test, not at the ApiError constructor.
    expect(err.stack).toContain('errors.test.ts');
  });

  it('OMITS details entirely — key absent, not undefined — when not supplied', () => {
    const err = new ApiError('not_found', 'No such document.');
    // The distinction the strict envelope schema depends on.
    expect('details' in err).toBe(false);
    expect(Object.hasOwn(err, 'details')).toBe(false);
    expect(Object.keys(err)).not.toContain('details');
  });

  it('carries details when supplied', () => {
    const err = new ApiError('forbidden', 'Missing scope.', {
      details: { missing_scope: 'documents:read' },
    });
    expect(Object.hasOwn(err, 'details')).toBe(true);
    expect(err.details).toEqual({ missing_scope: 'documents:read' });
  });

  it('retains an underlying cause for logging but never serializes it', () => {
    const underlying = new Error('connect ECONNREFUSED 10.0.0.4:5432');
    const err = new ApiError('server_error', 'An unexpected error occurred.', {
      cause: underlying,
    });

    // Retained for the log...
    expect(err.cause).toBe(underlying);
    // ...but invisible to JSON. `cause` set via the Error options bag is
    // non-enumerable, which is what makes this safe by construction rather
    // than by the middleware remembering to strip it.
    expect(JSON.stringify(err)).not.toContain('ECONNREFUSED');
    expect(Object.keys(err)).not.toContain('cause');
  });

  it('exposes status and sdkKind derived from the maps', () => {
    expect(new ApiError('rate_limited', 'Slow down.').status).toBe(429);
    expect(new ApiError('forbidden', 'Nope.').sdkKind).toBe('auth');
  });
});

describe('PF-188 — code → HTTP status, exhaustive over the union', () => {
  it('gives every code a status', () => {
    for (const code of API_ERROR_CODES) {
      const status = STATUS_BY_CODE[code];
      expect(status, `no status mapped for code "${code}"`).toBeTypeOf('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it('pins the PRD-mandated pairs', () => {
    expect(STATUS_BY_CODE.unauthorized, 'p.2/p.3').toBe(401);
    expect(STATUS_BY_CODE.forbidden, 'p.3').toBe(403);
    expect(STATUS_BY_CODE.rate_limited, 'p.4').toBe(429);
  });

  it('pins validation_failed → 422 (our call, recorded in docs/architecture.md)', () => {
    expect(STATUS_BY_CODE.validation_failed).toBe(422);

    const doc = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'docs', 'architecture.md'), 'utf8');
    expect(
      doc,
      'the 422 decision is ours, not the PRD\'s — it must be defended in docs/architecture.md',
    ).toMatch(/422/);
  });
});

describe('PF-189 — ApiErrorCode → SDK kind is 6→5, not 1:1 (finding F6)', () => {
  it('maps every code to exactly one kind', () => {
    for (const code of API_ERROR_CODES) {
      const kind = SDK_KIND_BY_CODE[code];
      expect(kind, `no SDK kind mapped for code "${code}"`).toBeDefined();
      expect(SDK_KINDS).toContain(kind);
    }
  });

  it('every SDK kind is reachable from some code', () => {
    const reached = new Set(Object.values(SDK_KIND_BY_CODE));
    for (const kind of SDK_KINDS) {
      expect(reached, `SDK kind "${kind}" is unreachable — no code produces it`).toContain(kind);
    }
  });

  it('is 6 codes onto 5 kinds — unauthorized and forbidden both collapse to auth', () => {
    expect(API_ERROR_CODES.length).toBe(6);
    expect(SDK_KINDS.length).toBe(5);
    expect(new Set(Object.values(SDK_KIND_BY_CODE)).size).toBe(5);

    // The specific collapse F6 was raised about.
    expect(SDK_KIND_BY_CODE.unauthorized).toBe('auth');
    expect(SDK_KIND_BY_CODE.forbidden).toBe('auth');
  });

  it('no longer claims a 1:1 mapping anywhere in the module (F6 regression)', () => {
    const source = readFileSync(join(HERE, 'errors.ts'), 'utf8');
    expect(source).not.toMatch(/maps 1:1/i);
  });

  it('agrees with the SDK\'s own ShipErrorKind union', () => {
    // Cross-checked by reading the file rather than importing it: the boundary
    // contract says sdk/ imports nothing from this repo, and we do not want the
    // dependency running the other way either. Reading the source keeps the two
    // honest without coupling the builds.
    const sdkSource = readFileSync(SDK_ERRORS_FILE, 'utf8');
    const match = sdkSource.match(/export type ShipErrorKind\s*=\s*([^;]+);/);
    const union = match?.[1];
    expect(union, 'could not find ShipErrorKind in sdk/src/errors.ts').toBeDefined();

    const declared = (union ?? '')
      .split('|')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();

    expect(declared, 'SDK kind union drifted from SDK_KINDS').toEqual([...SDK_KINDS].sort());
  });
});
