/**
 * Fixtures shared by this lane's suites: a `DeliveryJob` builder and the
 * in-memory log wiring.
 *
 * A plain module rather than a `.test.ts` file so vitest does not collect it,
 * and inside `src/` rather than `src/test/` for the reason `deps.ts` gives about
 * `testDeps()` — `api/tsconfig.json` excludes the test directory, so a fixture
 * living there could drift out of shape without `tsc` noticing.
 */
import type { DeliveryJob } from './pipeline.js';
import { idempotencyKeyFor } from './pipeline.js';
import type { DeliveryRequest } from './deliverer.js';

export const TEST_SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_APP_ID = '22222222-2222-4222-8222-222222222222';
export const TEST_EVENT_ID = '33333333-3333-4333-8333-333333333333';

export interface JobFixtureOptions {
  subscriptionId?: string;
  eventId?: string;
  eventType?: string;
  targetUrl?: string;
  body?: unknown;
  /**
   * What `resign()` answers. `null` models a subscription deactivated
   * mid-ladder, which is L15's documented signal to abandon the ladder.
   */
  resign?: () => Promise<DeliveryRequest | null>;
}

/**
 * A signed attempt-1 request plus the job that carries it.
 *
 * The signature header is a fixture string rather than a real HMAC: this lane
 * does not compute signatures (that is L15's signer, PF-435/PF-442) and a test
 * that recomputed one here would be asserting L15's behaviour through L16's
 * code. What matters at this seam is that the header L15 handed over is the one
 * that goes on the wire and into the log, which a distinguishable literal proves
 * more clearly than a real MAC would.
 */
export function makeDeliveryJob(options: JobFixtureOptions = {}): {
  job: DeliveryJob;
  rawBody: Buffer;
  resignCalls: () => number;
} {
  const subscriptionId = options.subscriptionId ?? TEST_SUBSCRIPTION_ID;
  const eventId = options.eventId ?? TEST_EVENT_ID;
  const eventType = options.eventType ?? 'document.created';
  const targetUrl = options.targetUrl ?? 'https://subscriber.test/hook';
  const rawBody = Buffer.from(
    JSON.stringify(options.body ?? { id: eventId, type: eventType, data: { title: 'original' } }),
    'utf8',
  );
  const idempotencyKey = idempotencyKeyFor(eventId, subscriptionId);

  const request: DeliveryRequest = {
    targetUrl,
    rawBody,
    signatureHeader: 't=1000,v1=attempt-1-signature',
    signedAtSeconds: 1000,
    idempotencyKey,
    eventId,
    subscriptionId,
  };

  let resigns = 0;
  const job: DeliveryJob = {
    subscriptionId,
    eventId,
    eventType,
    targetUrl,
    idempotencyKey,
    request,
    resign: async () => {
      resigns += 1;
      if (options.resign) return options.resign();
      // A fresh `t` per attempt, which is what L15's PF-442 does. The BODY is the
      // same buffer object — re-serializing it is the PF-436 bug.
      return {
        ...request,
        signatureHeader: `t=${1000 + resigns},v1=attempt-${resigns + 1}-signature`,
        signedAtSeconds: 1000 + resigns,
      };
    },
  };

  return { job, rawBody, resignCalls: () => resigns };
}

/** Every subscription in the in-memory log fixtures belongs to one test app. */
export const singleAppResolver = (): string => TEST_APP_ID;
