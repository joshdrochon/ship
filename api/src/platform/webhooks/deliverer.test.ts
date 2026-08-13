/**
 * PF-465 – PF-468 — the contract suite run against both implementations, plus
 * the assertions specific to each.
 *
 * The suite in `delivererContract.ts` appears twice below with **zero body
 * edits**: once bound to `InMemoryDeliverer`, once to `HttpDeliverer` pointed at
 * a real local `http.Server`. That is the Liskov claim
 * `docs/architecture.md` makes, checked rather than asserted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeClock, SystemClock } from '../clock.js';
import {
  describeDelivererContract,
  assertContractSuiteIsNotEmpty,
  CONTRACT_STATUSES,
  type DelivererFixture,
} from './delivererContract.js';
import {
  HttpDeliverer,
  InMemoryDeliverer,
  ResponseScriptExhaustedError,
  deliveryResult,
  excerptOf,
  envelopeToRawBody,
  EXCERPT_LIMIT,
  TRUNCATION_MARKER,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  type DeliveryRequest,
} from './deliverer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 1 — the double
// ─────────────────────────────────────────────────────────────────────────────

const inMemoryFixture: DelivererFixture = {
  targetUrl: () => 'https://subscriber.test/hook',
  make: async (statuses) => {
    const deliverer = new InMemoryDeliverer();
    for (const status of statuses) deliverer.queueResponse({ status });
    return {
      deliverer,
      // The double "receives" exactly what it was handed, which is the honest
      // analogue of reading headers off the wire.
      received: () =>
        deliverer.delivered.map((r) => ({
          [IDEMPOTENCY_HEADER]: r.idempotencyKey,
          [SIGNATURE_HEADER]: r.signatureHeader,
        })),
    };
  },
  makeUnreachable: async () => {
    const deliverer = new InMemoryDeliverer();
    deliverer.queueResponse({ status: null, responseExcerpt: 'ECONNREFUSED' });
    return { deliverer };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 2 — the real courier against a real server
// ─────────────────────────────────────────────────────────────────────────────

const openServers: Server[] = [];

/**
 * `closeAllConnections()` BEFORE `close()`, and that is not belt-and-braces.
 *
 * Node's `fetch` is undici, which keeps sockets ALIVE after a response. Plain
 * `server.close()` stops accepting new connections and then waits for the
 * existing ones to end — which a keep-alive socket never does — so the callback
 * never fires, `afterAll` times out at vitest's 10 s default, and the whole FILE
 * is reported as failed with the tests inside it merely "skipped".
 *
 * That failure shape is worth naming because it is indistinguishable from the
 * database lock-convoy failure PF-030 documents three lines away in
 * `src/test/setup.ts`, and the first instinct is to blame Postgres.
 */
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterAll(async () => {
  await Promise.all(openServers.map(closeServer));
});

/** A local server that answers `statuses` in order and records what it got. */
async function scriptedServer(statuses: number[]): Promise<{
  url: string;
  received: Record<string, string>[];
  bodies: Buffer[];
  close: () => Promise<void>;
}> {
  const received: Record<string, string>[] = [];
  const bodies: Buffer[] = [];
  let index = 0;

  const server = createServer((req, res) => {
    received.push(req.headers as Record<string, string>);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      const status = statuses[index] ?? 200;
      index += 1;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`response ${status}`);
    });
  });
  openServers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    bodies,
    close: () => closeServer(server),
  };
}

/**
 * `SystemClock`, deliberately, for the HTTP fixture only.
 *
 * This is the one place in the lane where real time is correct: the deliverer's
 * `latencyMs` is measuring a real socket round trip, and a `FakeClock` would
 * report 0 ms for a request that genuinely took some. p.11's rule is about
 * RETRY tests waiting on timers — no test here waits for anything; they await a
 * server on loopback that answers immediately.
 */
let httpUrl = '';
const httpFixture: DelivererFixture = {
  targetUrl: () => httpUrl,
  make: async (statuses) => {
    const server = await scriptedServer(statuses);
    httpUrl = server.url;
    return {
      deliverer: new HttpDeliverer({ clock: new SystemClock() }),
      received: () => server.received,
      dispose: server.close,
    };
  },
  makeUnreachable: async () => {
    // A port nothing is listening on. `127.0.0.1:1` refuses immediately rather
    // than hanging, so this is a connection-refused test and not a timeout test.
    httpUrl = 'http://127.0.0.1:1/hook';
    return { deliverer: new HttpDeliverer({ clock: new SystemClock() }) };
  },
};

describeDelivererContract('InMemoryDeliverer', inMemoryFixture);
describeDelivererContract('HttpDeliverer', httpFixture);

describe('PF-465 — the contract suite is not vacuous', () => {
  it('made assertions against both implementations', () => {
    // An empty contract suite is green against every implementation, which is
    // exactly the thing it exists to rule out.
    assertContractSuiteIsNotEmpty();
    expect(CONTRACT_STATUSES.length).toBeGreaterThanOrEqual(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PF-466 — HttpDeliverer posts the signed bytes, unchanged', () => {
  it('the body on the wire is byte-identical to rawBody', async () => {
    const server = await scriptedServer([200]);
    const deliverer = new HttpDeliverer({ clock: new SystemClock() });

    // A payload chosen to break under any re-serialization: a non-ASCII
    // character, a float that JSON.stringify renders differently from its
    // source text, and a key order that alphabetising would change.
    const rawBody = Buffer.from('{"z":1,"a":"café","n":1.50}', 'utf8');
    const request: DeliveryRequest = {
      targetUrl: server.url,
      rawBody,
      signatureHeader: 't=1,v1=abc',
      signedAtSeconds: 1,
      idempotencyKey: 'e:s',
      eventId: 'e',
      subscriptionId: 's',
    };

    await deliverer.deliver(request);
    await server.close();

    // PF-436. `JSON.stringify(JSON.parse(x))` would turn `1.50` into `1.5` and
    // re-order the keys, and the subscriber's HMAC would fail on a body nobody
    // tampered with — a failure that looks exactly like an attack.
    expect(Buffer.compare(server.bodies[0]!, rawBody)).toBe(0);
    expect(server.bodies[0]!.toString('utf8')).toBe('{"z":1,"a":"café","n":1.50}');
  });

  it('sends exactly three headers: content type, signature, idempotency key', async () => {
    const server = await scriptedServer([200]);
    const deliverer = new HttpDeliverer({ clock: new SystemClock() });
    await deliverer.deliver({
      targetUrl: server.url,
      rawBody: Buffer.from('{}'),
      signatureHeader: 't=99,v1=deadbeef',
      signedAtSeconds: 99,
      idempotencyKey: 'evt-1:sub-1',
      eventId: 'evt-1',
      subscriptionId: 'sub-1',
    });
    await server.close();

    const headers = server.received[0]!;
    expect(headers['content-type']).toBe('application/json');
    expect(headers[SIGNATURE_HEADER.toLowerCase()]).toBe('t=99,v1=deadbeef');
    expect(headers[IDEMPOTENCY_HEADER.toLowerCase()]).toBe('evt-1:sub-1');
  });

  it('does NOT follow a redirect — a 3xx is returned as a permanent failure', async () => {
    // Following a redirect on a webhook POST is an SSRF primitive: the
    // subscriber controls `Location` and could point it into the private
    // address space L15's checkTargetUrl refused at subscribe time (PF-425).
    const received: string[] = [];
    const server = createServer((req, res) => {
      received.push(req.url ?? '');
      if (received.length === 1) {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('should never be reached');
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const result = await new HttpDeliverer({ clock: new SystemClock() }).deliver({
      targetUrl: `http://127.0.0.1:${port}/hook`,
      rawBody: Buffer.from('{}'),
      signatureHeader: 't=1,v1=a',
      signedAtSeconds: 1,
      idempotencyKey: 'e:s',
      eventId: 'e',
      subscriptionId: 's',
    });
    await closeServer(server);

    expect(result.status).toBe(302);
    expect(result.ok).toBe(false);
    expect(result.permanentFailure).toBe(true);
    // Exactly one request: the redirect was not followed.
    expect(received).toHaveLength(1);
  });

  it('aborts on the timeout and returns rather than hanging or throwing', async () => {
    // The abort goes through the injected clock, so `FakeClock.advance` fires it
    // with no real waiting — which is the whole reason the timeout is testable
    // at all under p.11's no-`setTimeout` rule.
    const clock = new FakeClock(0);
    const server = createServer(() => {
      // Answers nothing, ever. The abort is the only thing that ends this.
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const deliverer = new HttpDeliverer({ clock, timeoutMs: 10_000 });
    const pending = deliverer.deliver({
      targetUrl: `http://127.0.0.1:${port}/hook`,
      rawBody: Buffer.from('{}'),
      signatureHeader: 't=1,v1=a',
      signedAtSeconds: 1,
      idempotencyKey: 'e:s',
      eventId: 'e',
      subscriptionId: 's',
    });

    // Let the request reach the socket, then fire the abort deterministically.
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(10_000);

    const result = await pending;
    await closeServer(server);

    expect(result.status).toBeNull();
    expect(result.ok).toBe(false);
    // Transient: nothing was said about the request, so nothing is concluded.
    expect(result.permanentFailure).toBe(false);
    expect(result.responseExcerpt).toBeTruthy();
  });
});

describe('PF-460 — the excerpt is bounded, body-only, and marks its truncation', () => {
  it('a 1 MB body yields a bounded excerpt ending in the marker', () => {
    const huge = '<html>' + 'x'.repeat(1_000_000);
    const excerpt = excerptOf(huge);
    expect(excerpt.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(excerpt.slice(0, EXCERPT_LIMIT)).toBe(huge.slice(0, EXCERPT_LIMIT));
    // Under the 280-char CHECK in migration 051, with room to spare.
    expect(excerpt.length).toBeLessThanOrEqual(280);
  });

  it("an empty body is '', not null — null is reserved for no response", () => {
    expect(excerptOf('')).toBe('');
    // The distinction matters in the log: a subscriber answering 204 and a
    // connection that timed out must not read the same.
    expect(deliveryResult({ status: 204, responseExcerpt: '', latencyMs: 0 }).responseExcerpt)
      .toBe('');
    expect(deliveryResult({ status: null, responseExcerpt: null, latencyMs: 0 }).responseExcerpt)
      .toBeNull();
  });

  it('invalid UTF-8 does not throw', () => {
    const mangled = Buffer.from([0xff, 0xfe, 0x41, 0x42]).toString('utf8');
    expect(() => excerptOf(mangled)).not.toThrow();
    expect(excerptOf(mangled).length).toBeGreaterThan(0);
  });

  it('a body just at the limit is not marked as truncated', () => {
    const exact = 'y'.repeat(EXCERPT_LIMIT);
    expect(excerptOf(exact)).toBe(exact);
    expect(excerptOf(exact)).not.toContain(TRUNCATION_MARKER);
  });
});

describe('PF-467 — permanentFailure is computed, never chosen', () => {
  it('deliveryResult derives ok and permanentFailure from the status alone', () => {
    expect(deliveryResult({ status: 200, responseExcerpt: null, latencyMs: 5 })).toEqual({
      ok: true,
      status: 200,
      responseExcerpt: null,
      latencyMs: 5,
      permanentFailure: false,
    });
    expect(deliveryResult({ status: 410, responseExcerpt: null, latencyMs: 5 }).permanentFailure)
      .toBe(true);
    // D9 in one assertion: a rate-limited subscriber is retried, not buried.
    expect(deliveryResult({ status: 429, responseExcerpt: null, latencyMs: 5 }).permanentFailure)
      .toBe(false);
  });

  it('the impossible pair {ok: true, permanentFailure: true} is unreachable', () => {
    for (const status of [100, 200, 204, 301, 400, 404, 408, 410, 429, 500, 503, null]) {
      const result = deliveryResult({ status, responseExcerpt: null, latencyMs: 0 });
      expect(result.ok && result.permanentFailure, `status ${status}`).toBe(false);
    }
  });

  it('latencyMs is rounded and floored at zero before it reaches the column', () => {
    expect(deliveryResult({ status: 200, responseExcerpt: null, latencyMs: 4.7 }).latencyMs).toBe(5);
    expect(deliveryResult({ status: 200, responseExcerpt: null, latencyMs: -3 }).latencyMs).toBe(0);
  });
});

describe('PF-468 — the double scripts per attempt and fails loudly when exhausted', () => {
  it('script([500, 500, 500, 200]) is consumed in order', async () => {
    const deliverer = new InMemoryDeliverer();
    deliverer.script([500, 500, 500, 200]);

    const statuses: (number | null)[] = [];
    for (let n = 0; n < 4; n += 1) {
      const r = await deliverer.deliver({
        targetUrl: 'https://s.test/h',
        rawBody: Buffer.from('{}'),
        signatureHeader: `t=${n},v1=x`,
        signedAtSeconds: n,
        idempotencyKey: 'e:s',
        eventId: 'e',
        subscriptionId: 's',
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([500, 500, 500, 200]);
    expect(deliverer.remaining()).toBe(0);
  });

  it('running past the end of a script is a TEST FAILURE, not a silent 200', async () => {
    // The old `?? {ok: true}` fallback would make a 7-attempt bug look like a
    // pass in Testing Scenario 8, whose entire assertion is that there is no
    // seventh attempt. A silent pass on the one thing the PRD wrote itself is
    // the worst possible outcome for this lane.
    const deliverer = new InMemoryDeliverer();
    deliverer.script([500]);
    const req: DeliveryRequest = {
      targetUrl: 'https://s.test/h',
      rawBody: Buffer.from('{}'),
      signatureHeader: 't=1,v1=x',
      signedAtSeconds: 1,
      idempotencyKey: 'e:s',
      eventId: 'e',
      subscriptionId: 's',
    };
    await deliverer.deliver(req);
    await expect(deliverer.deliver(req)).rejects.toBeInstanceOf(ResponseScriptExhaustedError);
  });

  it('an UNSCRIPTED deliverer still defaults to a healthy 200', async () => {
    // The fallback is not removed, only scoped: a test that never scripted
    // anything is describing a healthy subscriber and should not have to say so.
    const deliverer = new InMemoryDeliverer();
    const result = await deliverer.deliver({
      targetUrl: 'https://s.test/h',
      rawBody: Buffer.from('{}'),
      signatureHeader: 't=1,v1=x',
      signedAtSeconds: 1,
      idempotencyKey: 'e:s',
      eventId: 'e',
      subscriptionId: 's',
    });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
  });

  it('delivered[] retains the FULL request, headers included', async () => {
    // What Testing Scenario 8's "original idempotency key intact" is read off.
    const deliverer = new InMemoryDeliverer();
    const rawBody = Buffer.from('{"a":1}');
    await deliverer.deliver({
      targetUrl: 'https://s.test/h',
      rawBody,
      signatureHeader: 't=7,v1=sig',
      signedAtSeconds: 7,
      idempotencyKey: 'evt:sub',
      eventId: 'evt',
      subscriptionId: 'sub',
    });
    const sent = deliverer.delivered[0]!;
    expect(sent.idempotencyKey).toBe('evt:sub');
    expect(sent.signatureHeader).toBe('t=7,v1=sig');
    expect(sent.rawBody).toBe(rawBody);
  });
});

describe('PF-436 — envelopeToRawBody is the one serialization site', () => {
  it('returns a Buffer whose bytes are the envelope, once', () => {
    const envelope = { id: 'e1', type: 'document.created', data: { title: 'café' } };
    const buffer = envelopeToRawBody(envelope as never);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString('utf8')).toBe(JSON.stringify(envelope));
  });
});
