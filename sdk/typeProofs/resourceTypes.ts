/**
 * PF-527 — the interface and its field tuple are ONE definition, proved.
 *
 * Every resource projection is written twice: once as a TypeScript interface
 * (what a consumer compiles against) and once as a `readonly` tuple of names
 * (what a fitness test can read at runtime, since an interface does not survive
 * `tsc`). Two representations of one fact is a drift bug waiting to happen —
 * unless something forces them equal.
 *
 * This file is that something. `Exact<A, B>` is `true` only when the two key
 * sets are mutually assignable, so adding a field to `ShipIssue` without adding
 * it to `ISSUE_FIELDS` fails `pnpm type-check` with the interface's name in the
 * error, at the keyboard, before anything is committed.
 *
 * The OTHER half of PF-527 — that the tuple matches the SERVED SPEC — cannot
 * live here: `sdk/**` may import nothing from this repository, so the comparison
 * against `docs/openapi.json` runs from the `api/` package in
 * `specSurfaceParity.test.ts`. Together they close the loop: interface ≡ tuple
 * ≡ spec. Either one alone lets two of the three agree with each other and with
 * nothing real.
 */
import type {
  ShipDocument,
  CreateDocumentInput,
} from '../src/resources/documents.js';
import {
  DOCUMENT_FIELDS,
  CREATE_DOCUMENT_FIELDS,
} from '../src/resources/documents.js';
import type { ShipIssue, CreateIssueInput, UpdateIssueInput } from '../src/resources/issues.js';
import {
  ISSUE_FIELDS,
  CREATE_ISSUE_FIELDS,
  UPDATE_ISSUE_FIELDS,
} from '../src/resources/issues.js';
import type { ShipSprint, CreateSprintInput, UpdateSprintInput } from '../src/resources/sprints.js';
import {
  SPRINT_FIELDS,
  CREATE_SPRINT_FIELDS,
  UPDATE_SPRINT_FIELDS,
} from '../src/resources/sprints.js';
import type {
  WebhookSubscription,
  WebhookSubscriptionWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
} from '../src/resources/webhookSubscriptions.js';
import {
  WEBHOOK_SUBSCRIPTION_FIELDS,
  WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS,
  CREATE_WEBHOOK_FIELDS,
  UPDATE_WEBHOOK_FIELDS,
} from '../src/resources/webhookSubscriptions.js';

/** Mutual assignability. `[A] extends [B]` defers conditional distribution. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless `T` is exactly `true`. */
function proof<T extends true>(_: T): void {
  /* the constraint IS the assertion */
}

// ── documents ───────────────────────────────────────────────────────────────
proof<Exact<keyof ShipDocument, (typeof DOCUMENT_FIELDS)[number]>>(true);
proof<Exact<keyof CreateDocumentInput, (typeof CREATE_DOCUMENT_FIELDS)[number]>>(true);

// ── issues ──────────────────────────────────────────────────────────────────
proof<Exact<keyof ShipIssue, (typeof ISSUE_FIELDS)[number]>>(true);
proof<Exact<keyof CreateIssueInput, (typeof CREATE_ISSUE_FIELDS)[number]>>(true);
proof<Exact<keyof UpdateIssueInput, (typeof UPDATE_ISSUE_FIELDS)[number]>>(true);

// ── sprints ─────────────────────────────────────────────────────────────────
proof<Exact<keyof ShipSprint, (typeof SPRINT_FIELDS)[number]>>(true);
proof<Exact<keyof CreateSprintInput, (typeof CREATE_SPRINT_FIELDS)[number]>>(true);
proof<Exact<keyof UpdateSprintInput, (typeof UPDATE_SPRINT_FIELDS)[number]>>(true);

// ── webhook subscriptions ───────────────────────────────────────────────────
proof<Exact<keyof WebhookSubscription, (typeof WEBHOOK_SUBSCRIPTION_FIELDS)[number]>>(true);
proof<
  Exact<
    keyof WebhookSubscriptionWithSecret,
    (typeof WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS)[number]
  >
>(true);
proof<Exact<keyof CreateWebhookInput, (typeof CREATE_WEBHOOK_FIELDS)[number]>>(true);
proof<Exact<keyof UpdateWebhookInput, (typeof UPDATE_WEBHOOK_FIELDS)[number]>>(true);

// ── and the proof harness itself is not vacuous ─────────────────────────────
// If `Exact` were broken — if it answered `true` for everything — every
// assertion above would pass while proving nothing. These two lines are the
// anti-vacuity check: a disagreement MUST be `false`.
proof<Exact<keyof ShipDocument, (typeof DOCUMENT_FIELDS)[number]>>(true);
// @ts-expect-error — document fields are not issue fields; `Exact` says so.
proof<Exact<keyof ShipDocument, (typeof ISSUE_FIELDS)[number]>>(true);
