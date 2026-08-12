/**
 * L07 S4 — `details` variance is bounded and machine-checked.
 *
 * PF-198 (the policy), PF-199 (`apiErrorBodySchema` is the single oracle).
 *
 * Every assertion below is about the schema being STRICTER than "an object with
 * a code and a message". A permissive schema would let the fitness harness in S5
 * pass while routes invented their own error bodies, which is precisely the
 * failure this lane exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiErrorBodySchema,
  API_ERROR_CODES,
  CODES_WITHOUT_DETAILS,
  CODES_REQUIRING_DETAILS,
  CODES_WITH_OPTIONAL_DETAILS,
  UNAUTHORIZED_REASONS,
} from './errors.js';

/** The 403 body both this lane and L03 emit. */
const FORBIDDEN_DETAILS = {
  missing_scope: 'documents:read',
  granted_scopes: ['issues:read'],
  scope_description: 'Read documents',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const RID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('PF-199 — the schema is the one definition', () => {
  it('is defined exactly once in the repo', () => {
    // The anti-drift criterion. A second copy of the envelope shape anywhere is
    // a second answer to "what does a v1 failure look like".
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          // Test files are excluded: this very file names the symbol in a regex
          // to search for it, which would otherwise count as a second definition.
          const text = readFileSync(full, 'utf8');
          if (/export const apiErrorBodySchema\b/.test(text)) hits.push(full);
        }
      }
    };
    walk(join(REPO_ROOT, 'api', 'src'));
    walk(join(REPO_ROOT, 'sdk', 'src'));

    expect(hits, `apiErrorBodySchema defined in more than one place: ${hits.join(', ')}`).toHaveLength(1);
  });

  it('the middleware imports it rather than restating the shape', () => {
    const middleware = readFileSync(join(HERE, 'errorMiddleware.ts'), 'utf8');
    expect(middleware).toMatch(/apiErrorBodySchema/);
  });

  it('covers every code in the union — no code is unrepresentable', () => {
    for (const code of API_ERROR_CODES) {
      const candidate: Record<string, unknown> = {
        code,
        message: 'something went wrong',
        request_id: RID,
      };
      if (code === 'forbidden') candidate.details = FORBIDDEN_DETAILS;
      if (code === 'validation_failed') {
        candidate.details = { fields: [{ field: 'title', message: 'required' }] };
      }
      const result = apiErrorBodySchema.safeParse(candidate);
      expect(result.success, `no schema member accepts a valid "${code}" envelope`).toBe(true);
    }
  });
});

describe('PF-199 — .strict() rejects extra top-level keys', () => {
  it('rejects a stray key alongside a valid envelope', () => {
    const result = apiErrorBodySchema.safeParse({
      code: 'not_found',
      message: 'No such document.',
      request_id: RID,
      error: 'No such document.', // the internal shape leaking in
    });
    expect(result.success).toBe(false);
  });

  it('rejects a leaked stack', () => {
    const result = apiErrorBodySchema.safeParse({
      code: 'server_error',
      message: 'An unexpected error occurred.',
      request_id: RID,
      stack: 'Error: at /app/api/src/routes/documents.ts:397',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing or non-uuid request_id', () => {
    expect(
      apiErrorBodySchema.safeParse({ code: 'not_found', message: 'gone' }).success,
    ).toBe(false);
    expect(
      apiErrorBodySchema.safeParse({ code: 'not_found', message: 'gone', request_id: 'nope' })
        .success,
    ).toBe(false);
  });

  it('rejects a code outside the closed union', () => {
    const result = apiErrorBodySchema.safeParse({
      code: 'token_expired',
      message: 'Token expired.',
      request_id: RID,
    });
    expect(result.success, 'a seventh code slipped past the union').toBe(false);
  });
});

describe('PF-198 — details is fixed per code', () => {
  it.each(CODES_WITHOUT_DETAILS)('%s MUST omit details', (code) => {
    expect(apiErrorBodySchema.safeParse({ code, message: 'm', request_id: RID }).success).toBe(true);
    expect(
      apiErrorBodySchema.safeParse({ code, message: 'm', request_id: RID, details: { any: 1 } })
        .success,
      `${code} accepted a details key it must omit`,
    ).toBe(false);
  });

  it.each(CODES_REQUIRING_DETAILS)('%s MUST carry details', (code) => {
    expect(
      apiErrorBodySchema.safeParse({ code, message: 'm', request_id: RID }).success,
      `${code} was accepted without the details it must carry`,
    ).toBe(false);
  });

  it.each(CODES_WITH_OPTIONAL_DETAILS)('%s is valid with AND without details', (code) => {
    expect(
      apiErrorBodySchema.safeParse({ code, message: 'm', request_id: RID }).success,
      `${code} must be valid with no details`,
    ).toBe(true);
  });

  it('forbidden carries the missing scope, the granted set, and the prose (p.2)', () => {
    expect(
      apiErrorBodySchema.safeParse({
        code: 'forbidden',
        message: 'Missing required scope: documents:read',
        request_id: RID,
        details: FORBIDDEN_DETAILS,
      }).success,
    ).toBe(true);

    // L03's `require-scope.ts` emits this EXACT body today — same three facts,
    // but the first field is named `required_scope`. PRD p.2 asks for "the
    // missing scope named explicitly in the error body", so `missing_scope` is
    // the contract and L03's guard gets the one-word rename at merge. Pinned
    // here so the rename cannot be quietly skipped.
    expect(
      apiErrorBodySchema.safeParse({
        code: 'forbidden',
        message: 'm',
        request_id: RID,
        details: {
          required_scope: 'documents:read',
          granted_scopes: ['issues:read'],
          scope_description: 'Read documents',
        },
      }).success,
      'required_scope must not validate — the contract field is missing_scope',
    ).toBe(false);
  });

  it('forbidden is rejected when any of the three fields is dropped', () => {
    // Each one is load-bearing: without scope_description the 403 is opaque
    // again, which is exactly what gate item 6 forbids.
    for (const omitted of Object.keys(FORBIDDEN_DETAILS)) {
      const details: Record<string, unknown> = { ...FORBIDDEN_DETAILS };
      delete details[omitted];
      expect(
        apiErrorBodySchema.safeParse({
          code: 'forbidden',
          message: 'm',
          request_id: RID,
          details,
        }).success,
        `forbidden validated without "${omitted}"`,
      ).toBe(false);
    }
  });

  it('validation_failed carries a non-empty fields[]', () => {
    expect(
      apiErrorBodySchema.safeParse({
        code: 'validation_failed',
        message: 'Invalid request.',
        request_id: RID,
        details: { fields: [{ field: 'title', message: 'required' }] },
      }).success,
    ).toBe(true);

    expect(
      apiErrorBodySchema.safeParse({
        code: 'validation_failed',
        message: 'Invalid request.',
        request_id: RID,
        details: { fields: [] },
      }).success,
      'an empty fields[] tells the caller nothing',
    ).toBe(false);
  });

  it('rate_limited MAY carry retry_after_seconds', () => {
    const base = { code: 'rate_limited' as const, message: 'Slow down.', request_id: RID };
    expect(apiErrorBodySchema.safeParse(base).success).toBe(true);
    expect(
      apiErrorBodySchema.safeParse({ ...base, details: { retry_after_seconds: 30 } }).success,
    ).toBe(true);
    expect(
      apiErrorBodySchema.safeParse({ ...base, details: { retry_after_seconds: -1 } }).success,
    ).toBe(false);
  });

  it('every code is classified by exactly one details rule', () => {
    const lists = [CODES_WITHOUT_DETAILS, CODES_REQUIRING_DETAILS, CODES_WITH_OPTIONAL_DETAILS];
    const all = lists.flatMap((l) => [...l]);

    expect(new Set(all).size, 'a code appears in two details-rule lists').toBe(all.length);
    expect([...all].sort()).toEqual([...API_ERROR_CODES].sort());
  });
});

describe('B14 / MVP gate item 3 — expired tokens are distinguishable on a 401', () => {
  const base = { code: 'unauthorized' as const, message: 'Token expired.', request_id: RID };

  it('a 401 MAY carry details.reason', () => {
    expect(apiErrorBodySchema.safeParse({ ...base, details: { reason: 'expired' } }).success).toBe(
      true,
    );
  });

  it('accepts every declared reason', () => {
    for (const reason of UNAUTHORIZED_REASONS) {
      expect(
        apiErrorBodySchema.safeParse({ ...base, details: { reason } }).success,
        `reason "${reason}" was rejected`,
      ).toBe(true);
    }
  });

  it('distinguishes expired from invalid — the gate\'s actual requirement', () => {
    const expired = apiErrorBodySchema.parse({ ...base, details: { reason: 'expired' } });
    const invalid = apiErrorBodySchema.parse({ ...base, details: { reason: 'invalid' } });
    expect(expired).not.toEqual(invalid);
  });

  it('the enum is CLOSED — a free-form reason is a second undocumented taxonomy', () => {
    expect(
      apiErrorBodySchema.safeParse({ ...base, details: { reason: 'token_is_a_bit_old' } }).success,
    ).toBe(false);
  });

  it('rejects any other key alongside reason', () => {
    expect(
      apiErrorBodySchema.safeParse({ ...base, details: { reason: 'expired', token: 'abc123' } })
        .success,
      'a 401 must never echo the credential back',
    ).toBe(false);
  });

  it('the code union is still closed at six — no seventh code was added', () => {
    expect(API_ERROR_CODES).toHaveLength(6);
    expect(API_ERROR_CODES).not.toContain('token_expired');
  });
});

describe('PF-198 — the policy is written down where a human will find it', () => {
  it('platform/README.md documents the per-code details rules', () => {
    const readme = readFileSync(join(REPO_ROOT, 'api', 'src', 'platform', 'README.md'), 'utf8');
    expect(readme).toMatch(/missing_scope/);
    expect(readme).toMatch(/retry_after_seconds/);
    expect(readme).toMatch(/X-Request-Id/);
  });
});
