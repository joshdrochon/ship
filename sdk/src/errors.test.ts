/**
 * PF-497 – PF-502 — the typed error union.
 *
 * The compile-time half of PF-497 is `typeProofs/exhaustiveKind.ts`; this file
 * covers everything a runtime test can actually falsify.
 */
import { describe, expect, it } from 'vitest';
import {
  errorFromResponse,
  KIND_BY_CODE,
  kindForStatus,
  parseRetryAfter,
  SHIP_API_ERROR_CODES,
  SHIP_ERROR_KINDS,
  ShipError,
} from './errors.js';
import { headersOf } from './testSupport.js';

describe('PF-497 · the kind union is exactly five members', () => {
  it('five, no more, no fewer', () => {
    expect([...SHIP_ERROR_KINDS]).toEqual([
      'auth',
      'rate_limit',
      'not_found',
      'validation',
      'server',
    ]);
    expect(new Set(SHIP_ERROR_KINDS).size).toBe(5);
  });
});

describe('PF-498 · the code→kind map is 6→5, exhaustive in BOTH directions', () => {
  it('(a) every one of the six codes maps to exactly one kind', () => {
    for (const code of SHIP_API_ERROR_CODES) {
      const kind = KIND_BY_CODE[code];
      expect(kind, `${code} has no kind`).toBeDefined();
      expect(SHIP_ERROR_KINDS).toContain(kind);
    }
    expect(Object.keys(KIND_BY_CODE)).toHaveLength(6);
  });

  it('(b) every one of the five kinds is reachable from at least one code', () => {
    const reachable = new Set(Object.values(KIND_BY_CODE));
    for (const kind of SHIP_ERROR_KINDS) {
      expect(reachable, `no server code produces kind '${kind}'`).toContain(kind);
    }
  });

  it('the collapse is exactly `unauthorized` + `forbidden` → `auth`', () => {
    const collapsed = SHIP_API_ERROR_CODES.filter((code) => KIND_BY_CODE[code] === 'auth');
    expect([...collapsed]).toEqual(['unauthorized', 'forbidden']);
    // Six keys, five distinct values — the arithmetic the old "Maps 1:1"
    // comment denied (PF-499).
    expect(new Set(Object.values(KIND_BY_CODE)).size).toBe(5);
    expect(Object.keys(KIND_BY_CODE).length).toBe(6);
  });
});

describe('PF-500 · the server code survives, so `auth` still splits', () => {
  it('a 403 from a scope-gated route yields kind auth, code forbidden, and a scope to re-consent for', () => {
    const error = errorFromResponse({
      status: 403,
      body: {
        code: 'forbidden',
        message: 'This token cannot write documents.',
        request_id: '11111111-1111-4111-8111-111111111111',
        details: {
          missing_scope: 'documents:write',
          granted_scopes: ['documents:read'],
          scope_description: 'Create and edit documents',
        },
      },
      headers: headersOf(),
    });

    expect(error.kind).toBe('auth');
    expect(error.code).toBe('forbidden');
    // The whole point: this string can be handed straight to a re-consent flow.
    expect(error.requiredScope).toBe('documents:write');
    expect(error.grantedScopes).toEqual(['documents:read']);
    // …and it is NOT a 401, so a client must not try to refresh its way out.
    expect(error.reason).toBeNull();
  });

  it('a 401 yields kind auth, code unauthorized, and B14’s details.reason', () => {
    for (const reason of ['expired', 'invalid', 'missing'] as const) {
      const error = errorFromResponse({
        status: 401,
        body: {
          code: 'unauthorized',
          message: 'nope',
          request_id: '2',
          details: { reason },
        },
        headers: headersOf(),
      });
      expect(error.kind).toBe('auth');
      expect(error.code).toBe('unauthorized');
      expect(error.reason).toBe(reason);
      expect(error.requiredScope).toBeNull();
    }
  });

  it('an unknown reason is not surfaced as one — the enum is closed', () => {
    const error = errorFromResponse({
      status: 401,
      body: { code: 'unauthorized', message: 'x', details: { reason: 'because' } },
      headers: headersOf(),
    });
    expect(error.reason).toBeNull();
  });
});

describe('PF-501 · kind derivation when the body is missing, truncated, or not JSON', () => {
  const VALID: Record<number, string> = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    422: 'validation_failed',
    429: 'rate_limited',
    500: 'server_error',
  };

  const EXPECTED_BY_STATUS: Record<number, string> = {
    401: 'auth',
    403: 'auth',
    404: 'not_found',
    422: 'validation',
    429: 'rate_limit',
    500: 'server',
    502: 'server',
  };

  for (const status of [401, 403, 404, 422, 429, 500, 502]) {
    describe(`status ${status}`, () => {
      it('valid envelope → the code’s kind', () => {
        const code = VALID[status];
        const body = code ? { code, message: 'm' } : null;
        const error = errorFromResponse({ status, body, headers: headersOf() });
        expect(error.kind).toBe(EXPECTED_BY_STATUS[status]);
      });

      it('null body → the status’s kind, and NEVER a 4xx on `server`', () => {
        const error = errorFromResponse({ status, body: null, headers: headersOf() });
        expect(error.kind).toBe(EXPECTED_BY_STATUS[status]);
        if (status < 500) expect(error.kind).not.toBe('server');
        expect(error.code).toBeNull();
      });

      it('a proxy’s HTML body → the status’s kind (the body never parsed)', () => {
        // `parseErrorBody` in transport.ts turns unparseable text into null; the
        // classifier's contract is what happens next.
        const error = errorFromResponse({ status, body: null, headers: headersOf() });
        expect(error.kind).toBe(EXPECTED_BY_STATUS[status]);
      });

      it('JSON with an UNKNOWN code → the status’s kind, not a crash', () => {
        const error = errorFromResponse({
          status,
          body: { code: 'teapot_overflow', message: 'm' },
          headers: headersOf(),
        });
        expect(error.kind).toBe(EXPECTED_BY_STATUS[status]);
        // Unknown to this client version, so it is not reported as a known code.
        expect(error.code).toBeNull();
      });
    });
  }

  it('the exact regression: a 400 behind a proxy is NOT `server`', () => {
    // The old fallback chain ended at 'server' for anything unmatched, so this
    // told a consumer "not your fault, retry" about a request that will fail
    // identically forever.
    expect(kindForStatus(400)).toBe('validation');
    expect(kindForStatus(409)).toBe('validation');
    expect(kindForStatus(418)).toBe('validation');
    expect(kindForStatus(499)).toBe('validation');
    expect(kindForStatus(503)).toBe('server');
  });
});

describe('PF-502 · request_id and details survive, and the message is usable unmodified', () => {
  it('prefers the body’s request_id', () => {
    const error = errorFromResponse({
      status: 500,
      body: { code: 'server_error', message: 'Something failed.', request_id: 'from-body' },
      headers: headersOf({ 'X-Request-Id': 'from-header' }),
    });
    expect(error.requestId).toBe('from-body');
    expect(error.message).toBe('Something failed.');
  });

  it('falls back to X-Request-Id when the body did not survive — the support path', () => {
    const error = errorFromResponse({
      status: 500,
      body: null,
      headers: headersOf({ 'X-Request-Id': 'req-abc-123' }),
    });
    expect(error.requestId).toBe('req-abc-123');
  });

  it('is a real Error with a usable message and a stack', () => {
    const error = errorFromResponse({ status: 404, body: null, headers: headersOf() });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ShipError');
    expect(error.message).toBe('Ship request failed with status 404.');
    expect(typeof error.stack).toBe('string');
  });

  it('carries the server’s details verbatim', () => {
    const details = { fields: [{ field: 'title', message: 'Required' }] };
    const error = errorFromResponse({
      status: 422,
      body: { code: 'validation_failed', message: 'bad', details },
      headers: headersOf(),
    });
    expect(error.details).toEqual(details);
  });
});

describe('PF-511 · Retry-After, both RFC 7231 forms', () => {
  const NOW = Date.parse('2026-08-12T10:00:00Z');

  it('delta-seconds', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30);
    expect(parseRetryAfter(' 5 ', NOW)).toBe(5);
  });

  it('HTTP-date, resolved against the INJECTED clock', () => {
    expect(parseRetryAfter('Wed, 12 Aug 2026 10:00:45 GMT', NOW)).toBe(45);
  });

  it('an HTTP-date in the past is zero seconds of waiting, not null', () => {
    expect(parseRetryAfter('Wed, 12 Aug 2026 09:59:00 GMT', NOW)).toBe(0);
  });

  it('absent, empty and unparseable are all null — never NaN, never a silent 0', () => {
    for (const raw of [null, undefined, '', '   ', 'soon', '-5', '3.5']) {
      expect(parseRetryAfter(raw, NOW), `${String(raw)}`).toBeNull();
    }
  });

  it('is attached to the error on a 429', () => {
    const error = errorFromResponse({
      status: 429,
      body: { code: 'rate_limited', message: 'Slow down.' },
      headers: headersOf({ 'Retry-After': '12' }),
      nowMs: NOW,
    });
    expect(error.kind).toBe('rate_limit');
    expect(error.retryAfterSeconds).toBe(12);
  });
});

describe('ShipError construction', () => {
  it('defaults every optional field to null rather than undefined', () => {
    const error = new ShipError({ kind: 'server', message: 'x', status: 500 });
    expect(error.code).toBeNull();
    expect(error.requestId).toBeNull();
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.rateLimit).toBeNull();
  });
});
