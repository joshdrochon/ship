/**
 * `@ship/integration-testkit` — PF-721's one shared fixture.
 *
 * A DEV dependency of every webhook-receiving integration and a runtime
 * dependency of none. `scripts/lib/integration-packages.mjs` encodes that
 * distinction: the front-door claim is about what an integration's PROCESS
 * depends on, and this package never ships inside one.
 *
 * It imports `@ship/sdk` and nothing else from this repository, so the verifier
 * it gates deliveries with is the same `verifyWebhook` an external developer
 * installs — not a re-implementation that could agree with the server for the
 * wrong reason.
 */
export { createTestListener } from './listener.js';
export type {
  CapturedRequest,
  ListenerHandler,
  ListenerReply,
  TestListener,
  WaitOptions,
} from './listener.js';
export { signatureGate, SIGNATURE_REJECTED_STATUS } from './signatureGate.js';
export type { SignatureGateOptions, SignatureGateResult } from './signatureGate.js';
