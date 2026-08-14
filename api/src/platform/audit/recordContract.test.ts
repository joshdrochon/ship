/**
 * L12 S1 — PF-326, PF-327, PF-328, PF-329.
 *
 * The record's shape, and the guarantee that recording it can never break the
 * thing being recorded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Router } from 'express';
import { createTestPublicApp, V1_PREFIX } from '../api/v1/testSupport.js';
import { testDeps } from '../../deps.js';
import {
  PUBLIC_API_CALL_FIELDS,
  InMemoryAuditSink,
  recordSafely,
  type IAuditSink,
  type PublicApiCallRecord,
} from './audit.js';

function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
}

const sampleRecord = (): PublicApiCallRecord => ({
  occurredAt: new Date(0),
  clientId: 'client_1',
  userId: 'user_1',
  method: 'GET',
  route: '/api/v1/documents',
  scopeUsed: 'documents:read',
  status: 200,
  latencyMs: 1.5,
  requestId: 'req_1',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PF-326 — the record is exactly the PRD field set plus request_id', () => {
  it('the keys equal the literal field list, so an added field is a deliberate edit', () => {
    const keys = Object.keys(sampleRecord()).sort();
    expect(keys).toEqual([...PUBLIC_API_CALL_FIELDS].sort());
  });

  it('carries the seven p.4 fields and the one p.18 adds', () => {
    // Named individually rather than counted. `toHaveLength(9)` would pass on a
    // record that dropped `scopeUsed` and gained `requestBody`.
    const fields = new Set<string>(PUBLIC_API_CALL_FIELDS);
    for (const p4 of ['occurredAt', 'clientId', 'userId', 'route', 'scopeUsed', 'status', 'latencyMs']) {
      expect(fields.has(p4), `p.4 names ${p4}`).toBe(true);
    }
    expect(fields.has('requestId'), 'p.18 (Pre-Search 3.5) names request_id').toBe(true);
  });

  it('carries NO field for bodies, headers or token material (PF-340, B11)', () => {
    // The closed key set is the enforcement, not a convention. A field that does
    // not exist cannot be filled in by a later well-meaning edit — including the
    // "which calls came from the portal?" field B11 documents as a known
    // limitation and L22's PF-676 discloses in the UI instead.
    const forbidden = [
      'body',
      'requestBody',
      'responseBody',
      'headers',
      'authorization',
      'token',
      'accessToken',
      'clientSecret',
      'ip',
      'source',
      'origin',
    ];
    for (const name of forbidden) {
      expect(PUBLIC_API_CALL_FIELDS as readonly string[], `${name} must not be a field`).not.toContain(
        name,
      );
    }
  });

  it('the three nullable fields each accept null — the documented cases are representable', () => {
    // Each null has ONE documented meaning (see the type's docstring):
    // clientId null ⇒ never authenticated; userId null ⇒ that OR machine-to-
    // machine; scopeUsed null ⇒ no scope was checked, never "the check passed".
    const anonymous: PublicApiCallRecord = {
      ...sampleRecord(),
      clientId: null,
      userId: null,
      scopeUsed: null,
    };
    expect(Object.keys(anonymous).sort()).toEqual([...PUBLIC_API_CALL_FIELDS].sort());

    // Machine-to-machine: an app with no end user behind it. Distinguishable
    // from anonymous precisely because clientId survives.
    const m2m: PublicApiCallRecord = { ...sampleRecord(), userId: null };
    expect(m2m.clientId).not.toBeNull();
    expect(m2m.userId).toBeNull();
  });
});

describe('PF-328 — an audit sink can never fail a request', () => {
  it('a sink that throws SYNCHRONOUSLY leaves the response byte-identical', async () => {
    const throwing: IAuditSink = {
      record() {
        throw new Error('the audit database is down');
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const control = createTestPublicApp({ mountResources: mountSampleResources });
    const expected = await request(control.app).get(`${V1_PREFIX}/documents`).expect(200);

    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    // Swap the sink by rebuilding with the throwing one — the router takes it as
    // a dependency, which is the whole point of the seam.
    const broken = createTestPublicApp({
      mountResources: mountSampleResources,
      auditSink: throwing,
    });
    const actual = await request(broken.app).get(`${V1_PREFIX}/documents`).expect(200);

    expect(actual.status).toBe(expected.status);
    expect(actual.body).toEqual(expected.body);
    expect(actual.headers['content-type']).toBe(expected.headers['content-type']);
    // A synchronous throw inside a `res.on('finish')` listener becomes an
    // uncaughtException and takes the PROCESS down, not the request — so the
    // fact that this line runs at all is half the assertion.
    expect(app).toBeDefined();
  });

  it('a sink that REJECTS asynchronously leaves the response byte-identical', async () => {
    const rejecting: IAuditSink = {
      record() {
        return Promise.reject(new Error('insert timed out'));
      },
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const control = createTestPublicApp({ mountResources: mountSampleResources });
    const expected = await request(control.app).get(`${V1_PREFIX}/documents`).expect(200);

    const { app } = createTestPublicApp({
      mountResources: mountSampleResources,
      auditSink: rejecting,
    });
    const actual = await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    expect(actual.body).toEqual(expected.body);
    // A rejected promise is an unhandledRejection, which Node treats as fatal by
    // default — and it would not show up as a failed response either.
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toHaveBeenCalled();
  });

  it('a failing sink still lets a FAILING request produce its own error correctly', async () => {
    // The compounding case: an audit failure during the handling of a 401 must
    // not turn a clean 401 into a 500.
    const throwing: IAuditSink = {
      record() {
        throw new Error('down');
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { app } = createTestPublicApp({
      auth: null,
      auditSink: throwing,
      mountResources: mountSampleResources,
    });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('the failure is logged ONCE, with the request_id', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing: IAuditSink = {
      record() {
        throw new Error('down');
      },
    };

    recordSafely(throwing, sampleRecord());

    expect(errors).toHaveBeenCalledTimes(1);
    // An operator needs to tie a missing row to a specific call, not to a time
    // range. Without the id the log line is "some audit write failed".
    expect(String(errors.mock.calls[0]![0])).toContain('req_1');
  });

  it('a working sink is called exactly once and its return value is not awaited', () => {
    let calls = 0;
    let resolved = false;
    const slow: IAuditSink = {
      record() {
        calls++;
        return new Promise<void>((resolve) => {
          setImmediate(() => {
            resolved = true;
            resolve();
          });
        });
      },
    };

    recordSafely(slow, sampleRecord());
    expect(calls).toBe(1);
    // Fire-and-forget: `recordSafely` returned before the promise settled. If it
    // awaited, every public response would wait on a database write.
    expect(resolved).toBe(false);
  });
});

describe('PF-329 — InMemoryAuditSink is the double, wired through testDeps()', () => {
  it('testDeps() supplies it, so no assertion in this lane needs a database', () => {
    expect(testDeps().auditSink).toBeInstanceOf(InMemoryAuditSink);
  });

  it('records are exposed in insertion order', () => {
    const sink = new InMemoryAuditSink();
    for (const status of [200, 401, 429, 500]) {
      sink.record({ ...sampleRecord(), status });
    }
    // Order is what makes "exactly one row per request" checkable rather than a
    // spot check — a Set or a Map keyed by request id would hide a duplicate.
    expect(sink.records.map((r) => r.status)).toEqual([200, 401, 429, 500]);
  });

  it('the router writes to the sink it was handed, not to a module-level singleton', async () => {
    const a = createTestPublicApp({ mountResources: mountSampleResources });
    const b = createTestPublicApp({ mountResources: mountSampleResources });

    await request(a.app).get(`${V1_PREFIX}/documents`).expect(200);

    expect(a.auditSink.records).toHaveLength(1);
    // Two apps in one process must not share a trail. A singleton here would
    // make every count in this lane depend on test execution order.
    expect(b.auditSink.records).toHaveLength(0);
  });
});
