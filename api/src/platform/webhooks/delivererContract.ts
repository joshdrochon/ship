/**
 * PF-465 — `describeDelivererContract(make)`: ONE suite, executed twice.
 *
 * `docs/architecture.md` names `InMemoryDeliverer` (synchronous, tests) and the
 * HTTP deliverer as the Liskov exhibit, and says *"tests assert against the
 * interface contract."* This is that contract, and it runs against both
 * implementations with **zero test-body edits** — same shape as L14's PF-401
 * and L15's `subscriptionRepo.test.ts`.
 *
 * ## What the suite asserts, and why each one
 *
 * These are the properties the RETRY SCHEDULER actually relies on. Anything the
 * scheduler does not depend on is not in here, because a contract suite that
 * asserts incidental behaviour makes the two implementations harder to keep
 * substitutable rather than easier.
 *
 *   `deliver()` never throws         a throw aborts the ladder mid-run and
 *                                    strands an `in_flight` row with no terminal
 *                                    state (PF-466)
 *   a 2xx yields `ok: true`          the scheduler's success branch
 *   `latencyMs` is a non-negative    it goes straight into an INTEGER column
 *     integer                        with a `>= 0` CHECK (PF-461)
 *   `permanentFailure` agrees with   PF-467 — the whole point of the pair. If
 *     `classifyDeliveryOutcome`      the double called a 410 transient and the
 *                                    HTTP one called it permanent, every test
 *                                    written against the double would prove
 *                                    nothing about production
 *   `Idempotency-Key` is present     PF-471 — a header that appears on the first
 *     and non-empty on EVERY request attempt only is worse than no header,
 *                                    because it teaches subscribers to trust it
 *
 * It lives in a `.ts` rather than a `.test.ts` so vitest does not collect it
 * directly — it is a function two suites call, and collecting it here would run
 * it with no implementation bound.
 */
import { describe, it, expect } from 'vitest';
import { classifyDeliveryOutcome } from './classify.js';
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  type DeliveryRequest,
  type IWebhookDeliverer,
} from './deliverer.js';

/** What a fixture must provide: a deliverer, and the statuses it can produce. */
export interface DelivererFixture {
  /**
   * Builds a deliverer that will answer with `statuses`, in order.
   *
   * The implementation decides HOW — the double queues them, the HTTP one runs a
   * server that returns them. The suite never knows which.
   */
  make(statuses: number[]): Promise<{
    deliverer: IWebhookDeliverer;
    /** Headers the subscriber actually received, one entry per request. */
    received: () => Record<string, string>[];
    dispose?: () => Promise<void>;
  }>;
  /** Builds a deliverer whose target is unreachable, for the network-failure case. */
  makeUnreachable(): Promise<{
    deliverer: IWebhookDeliverer;
    dispose?: () => Promise<void>;
  }>;
  /** The URL to POST at. Supplied by the fixture because only it knows. */
  targetUrl(): string;
}

/**
 * The statuses the suite exercises. Exported so the non-vacuity assertion can
 * count them, and so a reader can see the coverage without reading the body.
 */
export const CONTRACT_STATUSES = [200, 204, 400, 404, 410, 429, 500, 503] as const;

function requestFor(targetUrl: string, n: number): DeliveryRequest {
  return {
    targetUrl,
    rawBody: Buffer.from(`{"n":${n}}`, 'utf8'),
    signatureHeader: `t=1000,v1=sig-${n}`,
    signedAtSeconds: 1000,
    idempotencyKey: `event-${n}:subscription-1`,
    eventId: `event-${n}`,
    subscriptionId: 'subscription-1',
  };
}

/** How many assertions this suite makes. Guards against an empty contract. */
let assertionsMade = 0;

export function describeDelivererContract(name: string, fixture: DelivererFixture): void {
  describe(`IWebhookDeliverer contract — ${name}`, () => {
    it('a 2xx is ok, and every non-2xx is not', async () => {
      const bound = await fixture.make([...CONTRACT_STATUSES]);
      try {
        for (const [index, status] of CONTRACT_STATUSES.entries()) {
          const result = await bound.deliverer.deliver(requestFor(fixture.targetUrl(), index));
          assertionsMade += 1;
          expect(result.status, `status ${status}`).toBe(status);
          expect(result.ok, `status ${status} ok`).toBe(status >= 200 && status <= 299);
        }
      } finally {
        await bound.dispose?.();
      }
    });

    it('PF-467 — permanentFailure agrees with classifyDeliveryOutcome for every status', async () => {
      // The property that makes these two a PAIR. Without it the double is free
      // to call a 410 transient while the HTTP one calls it permanent, and the
      // scheduler tests written against the double prove nothing.
      const bound = await fixture.make([...CONTRACT_STATUSES]);
      try {
        for (const [index, status] of CONTRACT_STATUSES.entries()) {
          const result = await bound.deliverer.deliver(requestFor(fixture.targetUrl(), index));
          assertionsMade += 1;
          expect(result.permanentFailure, `status ${status} permanentFailure`).toBe(
            classifyDeliveryOutcome(status) === 'permanent',
          );
        }
      } finally {
        await bound.dispose?.();
      }
    });

    it('latencyMs is a non-negative integer — it goes into an INTEGER column', async () => {
      const bound = await fixture.make([200]);
      try {
        const result = await bound.deliverer.deliver(requestFor(fixture.targetUrl(), 0));
        assertionsMade += 1;
        expect(Number.isInteger(result.latencyMs)).toBe(true);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      } finally {
        await bound.dispose?.();
      }
    });

    it('PF-471 — every request carries a non-empty Idempotency-Key and a signature', async () => {
      // First attempt, retry and replay alike. A header that appears on the
      // first attempt only is worse than no header: it teaches subscribers to
      // trust it, and then it is absent exactly when a retry makes it matter.
      const bound = await fixture.make([500, 500, 200]);
      try {
        for (let n = 0; n < 3; n += 1) {
          await bound.deliverer.deliver(requestFor(fixture.targetUrl(), n));
        }
        const headers = bound.received();
        assertionsMade += 1;
        expect(headers).toHaveLength(3);
        for (const [n, sent] of headers.entries()) {
          const key = sent[IDEMPOTENCY_HEADER.toLowerCase()] ?? sent[IDEMPOTENCY_HEADER];
          const sig = sent[SIGNATURE_HEADER.toLowerCase()] ?? sent[SIGNATURE_HEADER];
          expect(key, `attempt ${n} Idempotency-Key`).toBe(`event-${n}:subscription-1`);
          expect(sig, `attempt ${n} Ship-Signature`).toBe(`t=1000,v1=sig-${n}`);
        }
      } finally {
        await bound.dispose?.();
      }
    });

    it('PF-466 — an unreachable target RETURNS a result rather than throwing', async () => {
      // A throw here would abort the ladder mid-run and leave an `in_flight` row
      // with no terminal state: a delivery neither delivered nor dead-lettered,
      // invisible to the DLQ and to replay alike.
      const bound = await fixture.makeUnreachable();
      try {
        const result = await bound.deliverer.deliver(requestFor(fixture.targetUrl(), 0));
        assertionsMade += 1;
        expect(result.status).toBeNull();
        expect(result.ok).toBe(false);
        // Transient by construction: nothing was said about the request, so
        // nothing can be concluded about it.
        expect(result.permanentFailure).toBe(false);
      } finally {
        await bound.dispose?.();
      }
    });
  });
}

/** PF-465's anti-vacuity clause: an empty contract suite passes for BOTH. */
export function assertContractSuiteIsNotEmpty(): void {
  expect(
    assertionsMade,
    'The deliverer contract suite made no assertions. An empty contract suite is green ' +
      'against every implementation, which is exactly the thing it exists to rule out.',
  ).toBeGreaterThan(0);
}
