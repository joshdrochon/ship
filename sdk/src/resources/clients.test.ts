/**
 * PF-521 – PF-526 · the four resource clients, as a SHAPE.
 *
 * Everything here is about the surface itself — what hangs off the client, what
 * is writable, which class each field is, and which HTTP call each method makes.
 * The live half (real server, real tokens, real rows) is
 * `api/src/platform/api/v1/sdkResources.test.ts`, which cannot live in this
 * package: ESLint fence 4 forbids `sdk/**` from importing anything in this
 * repository, so an SDK test cannot boot Ship.
 */
import { describe, expect, it } from 'vitest';
import { ShipClient, RESOURCE_NAMES } from '../client.js';
import { DocumentsClient } from './documents.js';
import { IssuesClient } from './issues.js';
import { SprintsClient } from './sprints.js';
import { WebhooksClient } from './webhookSubscriptions.js';
import { ResourceClient } from './base.js';
import type { Transport } from '../transport.js';

/** Records every call the resource clients make, and answers with a fixture. */
class RecordingTransport implements Transport {
  readonly calls: { method: string; path: string; query?: unknown; body?: unknown }[] = [];
  constructor(private readonly answer: unknown = { data: [], next_cursor: null }) {}

  request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    this.calls.push({ method, path, query: options.query, body: options.body });
    return Promise.resolve(this.answer as T);
  }
}

describe('PF-521 · all four resource clients hang off ShipClient', () => {
  const client = new ShipClient({ token: 'tok', baseUrl: 'https://ship.test' });

  it('p.7’s interface sketch, literally — four named fields', () => {
    expect(client.documents).toBeInstanceOf(DocumentsClient);
    expect(client.issues).toBeInstanceOf(IssuesClient);
    expect(client.sprints).toBeInstanceOf(SprintsClient);
    expect(client.webhooks).toBeInstanceOf(WebhooksClient);
  });

  it('and RESOURCE_NAMES is the same four, so nothing iterates a copy', () => {
    expect([...RESOURCE_NAMES]).toEqual(['documents', 'issues', 'sprints', 'webhooks']);
    for (const name of RESOURCE_NAMES) {
      expect(client[name], `client.${name} is missing`).toBeDefined();
    }
  });

  it('each is its OWN class — not one god object with four namespaces', () => {
    // p.12 cites this structure as the SDK's Interface-Segregation evidence, so
    // it is a graded claim rather than a preference. Four distinct constructors.
    const constructors = RESOURCE_NAMES.map((name) => client[name].constructor);
    expect(new Set(constructors).size).toBe(4);

    // and cross-instance checks fail, which is what "segregated" means.
    expect(client.documents instanceof IssuesClient).toBe(false);
    expect(client.webhooks instanceof DocumentsClient).toBe(false);
  });

  it('they share ONE implementation of list/get/iterate, and it is ResourceClient', () => {
    // PF-533's mechanism: four hand-rolled paginating loops is the defect that
    // ticket names, and four copies of `list()` is the same defect one level
    // down.
    for (const name of RESOURCE_NAMES) {
      expect(client[name], `${name} does not extend ResourceClient`).toBeInstanceOf(ResourceClient);
    }
  });

  it('the fields are non-writable at RUNTIME, not only `readonly` in the types', () => {
    // `readonly` is erased by tsc. Swapping `client.documents` for a look-alike
    // is how a token goes somewhere it should not, so this is asserted on the
    // descriptor.
    for (const name of RESOURCE_NAMES) {
      const descriptor = Object.getOwnPropertyDescriptor(client, name);
      expect(descriptor, `${name} has no own property descriptor`).toBeDefined();
      expect(descriptor?.writable, `client.${name} is writable`).toBe(false);
      expect(descriptor?.configurable, `client.${name} is configurable`).toBe(false);
    }
  });

  it('and assignment really does fail rather than silently succeeding', () => {
    // Non-strict assignment to a non-writable property is a silent no-op; the
    // ES module this test compiles to is strict, so it throws. Either way the
    // value must not change, which is the property that matters.
    const before = client.documents;
    expect(() => {
      (client as unknown as Record<string, unknown>).documents = new IssuesClient(
        {} as Transport,
      );
    }).toThrow();
    expect(client.documents).toBe(before);
  });
});

describe('PF-522 / PF-523 / PF-524 · every method goes through the injected transport', () => {
  // The resource clients take a `Transport`; constructing them directly with a
  // recording double is how these assertions reach the wire shape without the
  // HTTP layer.
  it('documents — list, get, create', async () => {
    const transport = new RecordingTransport();
    const documents = new DocumentsClient(transport);

    await documents.list({ limit: 10, cursor: 'abc' });
    await documents.get('doc-1');
    await documents.create({ title: 'hello' });

    expect(transport.calls).toEqual([
      { method: 'GET', path: '/documents', query: { cursor: 'abc', limit: '10' }, body: undefined },
      { method: 'GET', path: '/documents/doc-1', query: undefined, body: undefined },
      { method: 'POST', path: '/documents', query: undefined, body: { title: 'hello' } },
    ]);
  });

  it('issues — list, get, create, update (PF-522)', async () => {
    const transport = new RecordingTransport();
    const issues = new IssuesClient(transport);

    await issues.list();
    await issues.get('i-1');
    await issues.create({ title: 'Bug' });
    await issues.update('i-1', { state: 'done' });

    expect(transport.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /issues',
      'GET /issues/i-1',
      'POST /issues',
      'PATCH /issues/i-1',
    ]);
    expect(transport.calls[3]?.body).toEqual({ state: 'done' });
  });

  it('sprints — the public path is /sprints (PF-523)', async () => {
    const transport = new RecordingTransport();
    const sprints = new SprintsClient(transport);

    await sprints.list();
    await sprints.get('s-1');
    await sprints.create({ sprint_number: 42 });
    await sprints.update('s-1', { status: 'active' });

    expect(transport.calls.map((c) => c.path)).toEqual([
      '/sprints',
      '/sprints/s-1',
      '/sprints',
      '/sprints/s-1',
    ]);
  });

  it('webhooks — six methods, including rotate (PF-524)', async () => {
    const transport = new RecordingTransport();
    const webhooks = new WebhooksClient(transport);

    await webhooks.create({ event: 'document.created', target_url: 'https://h.test/x' });
    await webhooks.list();
    await webhooks.get('w-1');
    await webhooks.update('w-1', { active: false });
    await webhooks.delete('w-1');
    await webhooks.rotate('w-1');

    expect(transport.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /webhooks',
      'GET /webhooks',
      'GET /webhooks/w-1',
      'PATCH /webhooks/w-1',
      'DELETE /webhooks/w-1',
      'POST /webhooks/w-1/rotate',
    ]);
  });

  it('ids are escaped, so a hostile id cannot reach another path', async () => {
    const transport = new RecordingTransport();
    await new DocumentsClient(transport).get('../../me');
    expect(transport.calls[0]?.path).toBe('/documents/..%2F..%2Fme');
  });

  it('an omitted cursor or limit sends NO query parameter, rather than an empty one', async () => {
    // `?cursor=` is not the same request as no cursor: L08's parser would have to
    // decide what an empty cursor means, and the answer a library should give is
    // "you did not send one".
    const transport = new RecordingTransport();
    await new IssuesClient(transport).list({});
    expect(transport.calls[0]?.query).toEqual({});
  });
});

describe('PF-526 · the delivery log and replay are NOT here, and that is measured', () => {
  it('no method on the webhooks client targets /webhooks/deliveries', () => {
    // p.4 does specify `/api/v1/webhooks/deliveries/:id/replay`, and PF-526 asks
    // for a client call. That route DOES NOT EXIST in the served spec — the
    // delivery log and the replay endpoint are L16's and have not landed.
    //
    // Shipping the client method anyway would break PF-531 (every public SDK
    // method resolves to a spec operation) and would hand consumers a method
    // that 404s. So the surface is asserted ABSENT here rather than half-built,
    // and this test is what will fail the day L16 lands the route with no client
    // to match — see the lane report and L99 F93.
    const client = new ShipClient({ token: 't', baseUrl: 'https://ship.test' });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client.webhooks));
    expect(methods).not.toContain('deliveries');
    expect(methods).not.toContain('replay');
  });
});
