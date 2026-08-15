/**
 * F113 · `client.audit` — the SDK surface for PRD p.4's public audit trail.
 *
 * Shape and call-construction only. The live half (real server, real rows, real
 * tenancy) is `api/src/platform/api/v1/audit/*.test.ts`, which cannot live in
 * this package: ESLint fence 4 forbids `sdk/**` from importing anything else in
 * this repository, so an SDK test cannot boot Ship.
 */
import { describe, expect, it } from 'vitest';
import { ShipClient } from '../client.js';
import { AuditClient, AUDIT_CALL_FIELDS, type AuditCall } from './audit.js';
import { ResourceClient } from './base.js';
import type { Transport } from '../transport.js';

/** Records every call, and answers with whatever the case needs. */
class RecordingTransport implements Transport {
  readonly calls: { method: string; path: string; query?: unknown }[] = [];
  private queue: unknown[];

  constructor(...answers: unknown[]) {
    this.queue = answers.length > 0 ? answers : [{ data: [], next_cursor: null }];
  }

  request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string> } = {},
  ): Promise<T> {
    this.calls.push({ method, path, query: options.query });
    const answer = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return Promise.resolve(answer as T);
  }
}

const call = (id: string): AuditCall => ({
  id,
  request_id: `req_${id}`,
  client_id: 'client_mine',
  user_id: 'user_1',
  method: 'GET',
  route: '/documents',
  scope_used: 'documents:read',
  status: 200,
  latency_ms: 4,
  occurred_at: '2026-08-01T12:00:00.000Z',
});

describe('F113 · the client hangs off ShipClient', () => {
  const client = new ShipClient({ token: 'tok', baseUrl: 'https://ship.test' });

  it('exposes `audit` as an AuditClient', () => {
    expect(client.audit).toBeInstanceOf(AuditClient);
  });

  it('is NOT a ResourceClient — there is no GET /audit/{id} to inherit', () => {
    // Inheriting the base would put a `get()` on the prototype with no spec
    // operation behind it, which PF-531's reverse-parity walk reads off the real
    // prototype and correctly reports.
    expect(client.audit).not.toBeInstanceOf(ResourceClient);
    expect((client.audit as unknown as { get?: unknown }).get).toBeUndefined();
  });

  it('is genuinely read-only at runtime, not just `readonly` in the types', () => {
    // `readonly` is erased by tsc. Swapping `client.audit` for a look-alike is
    // how a token ends up going somewhere it was not issued for.
    expect(() => {
      (client as unknown as { audit: unknown }).audit = new AuditClient(
        new RecordingTransport(),
      );
    }).toThrow();
  });

  it('names the ten fields PRD p.4 records, as data', () => {
    expect([...AUDIT_CALL_FIELDS]).toEqual([
      'id',
      'request_id',
      'client_id',
      'user_id',
      'method',
      'route',
      'scope_used',
      'status',
      'latency_ms',
      'occurred_at',
    ]);
  });
});

describe('F113 · list() builds the right request', () => {
  it('GETs /audit with no query when given nothing', async () => {
    const transport = new RecordingTransport();
    await new AuditClient(transport).list();

    expect(transport.calls).toEqual([{ method: 'GET', path: '/audit', query: {} }]);
  });

  it('passes every declared filter through', async () => {
    const transport = new RecordingTransport();
    await new AuditClient(transport).list({
      limit: 10,
      cursor: 'c1',
      status: 429,
      route: '/documents',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });

    expect(transport.calls[0]?.query).toEqual({
      limit: '10',
      cursor: 'c1',
      status: '429',
      route: '/documents',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });
  });

  it('omits absent filters rather than sending them blank', async () => {
    const transport = new RecordingTransport();
    // A blank `route=` would be a real filter server-side — "the route whose
    // template is the empty string" — and would return nothing.
    await new AuditClient(transport).list({ cursor: null, route: '' });

    expect(transport.calls[0]?.query).toEqual({});
  });

  it('sends status=0 nowhere near a truthiness check', async () => {
    const transport = new RecordingTransport();
    // `if (input.status)` would drop this. 0 is not a valid HTTP status and the
    // server rejects it — which is the POINT: the caller must see the 422 rather
    // than an unfiltered page.
    await new AuditClient(transport).list({ status: 0 });

    expect(transport.calls[0]?.query).toEqual({ status: '0' });
  });
});

describe('F113 · iterate() hides cursors, per PRD p.4', () => {
  it('walks every page and yields every row once', async () => {
    const transport = new RecordingTransport(
      { data: [call('a'), call('b')], next_cursor: 'c1' },
      { data: [call('c')], next_cursor: null },
    );

    const seen: string[] = [];
    for await (const row of new AuditClient(transport).iterate()) seen.push(row.id);

    expect(seen).toEqual(['a', 'b', 'c']);
    // The second request carried the cursor the first response handed back —
    // the consumer never saw it.
    expect(transport.calls[1]?.query).toMatchObject({ cursor: 'c1' });
  });

  it('stops at a null next_cursor rather than looping', async () => {
    const transport = new RecordingTransport({ data: [call('a')], next_cursor: null });

    const seen: string[] = [];
    for await (const row of new AuditClient(transport).iterate()) seen.push(row.id);

    expect(seen).toEqual(['a']);
    expect(transport.calls).toHaveLength(1);
  });

  it('carries filters onto every page, not just the first', async () => {
    const transport = new RecordingTransport(
      { data: [call('a')], next_cursor: 'c1' },
      { data: [call('b')], next_cursor: null },
    );

    for await (const _ of new AuditClient(transport).iterate({ status: 429 })) {
      // drained for the effect on `transport.calls`
    }

    // A filter dropped after page one silently widens the result mid-walk, which
    // reads as "the filter stopped working" and is nearly impossible to spot.
    expect(transport.calls[0]?.query).toMatchObject({ status: '429' });
    expect(transport.calls[1]?.query).toMatchObject({ status: '429', cursor: 'c1' });
  });

  it('yields nothing for an empty collection', async () => {
    const transport = new RecordingTransport({ data: [], next_cursor: null });

    const seen: AuditCall[] = [];
    for await (const row of new AuditClient(transport).iterate()) seen.push(row);

    expect(seen).toEqual([]);
  });
});
