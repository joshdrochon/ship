/**
 * Request and response Zod for `/api/v1/webhooks`, adjacent to the handler.
 *
 * Tickets: PF-429 (create), PF-430 (list), PF-431 (get/patch/delete), PF-433
 * (rotate), PF-424 (the secret is not in the read projection), PF-425
 * (`target_url` validation).
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."* This file is that adjacency — a
 * sibling of `routes.ts`, and deliberately NOT `api/src/openapi/schemas/`, which
 * is the hand-written-spec tree L13 exists to keep out of the public surface.
 *
 * ## `event`, singular — and where the plural lives
 *
 * The wire field is `event`, matching p.7's drill loop verbatim:
 * `client.webhooks.create({ event, target_url })`. The database column is
 * `event_type`, and `PgWebhookSubscriptionRepo` is the only place that knows
 * both spellings. A subscription is one event type; an app that wants three
 * creates three subscriptions, which is also what makes `active` and `rotate`
 * meaningful per event type rather than per bundle.
 */
import { z } from 'zod';
import { EVENT_TYPES } from '../../../webhooks/events.js';
import { checkTargetUrl } from '../../../webhooks/targetUrl.js';

/** The cursor's resource binding. A cursor minted here is rejected elsewhere (PF-218). */
export const WEBHOOKS_RESOURCE = 'webhooks';

/**
 * PF-424 — THE read projection. An allowlist, and there is no secret in it.
 *
 * `.strict()` is the enforcement rather than a stylistic choice: L13's
 * `responseContract` parses every 2xx body through this schema, so a handler
 * that put `signing_secret` on a read response would **fail to serialise** —
 * `.strict()` rejects the unknown key and the route 500s in test and dev. The
 * secret cannot leak through a read path by carelessness; it can only leak by
 * someone deliberately editing this schema, which is a visible diff.
 *
 * `secret_prefix` is present on purpose. It is the 8 characters the portal and
 * L16's delivery log use to say WHICH secret without holding one.
 */
export const webhookSubscriptionSchema = z
  .object({
    id: z.string().uuid(),
    event: z.enum(EVENT_TYPES),
    target_url: z.string(),
    active: z.boolean(),
    secret_prefix: z.string(),
    secret_version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    deactivated_at: z.string().nullable(),
  })
  .strict();

export type WebhookSubscriptionBody = z.infer<typeof webhookSubscriptionSchema>;

/**
 * PF-429 / PF-433 — the ONE response in this codebase that carries a raw secret.
 *
 * `.extend()` on the read projection rather than a hand-written second object,
 * so the two cannot drift: a field added to the resource appears here for free,
 * and a consumer that stores the create response can pass it anywhere a
 * subscription is expected.
 *
 * `grep -rn "signing_secret" api/src` returns this schema, the repository types
 * and the two handlers that build it. Nothing else.
 */
export const webhookSubscriptionWithSecretSchema = webhookSubscriptionSchema
  .extend({
    /**
     * Shown exactly once, here and on rotate. p.8: *"Subscription persisted;
     * signing secret returned once"*; p.7's drill reads `sub.signing_secret`
     * straight off this body.
     */
    signing_secret: z.string(),
  })
  .strict();

/**
 * PF-425 — the create request.
 *
 * `.strict()` for the same reason L09's create schema is: `app_id`,
 * `workspace_id` and `secret` are internal or token-derived, and a body that
 * named one must be REJECTED rather than ignored. Ignoring is how a caller comes
 * to believe they bound a subscription to an app they do not own — the request
 * succeeds, the response shows the right thing, and they conclude it worked.
 */
export const createWebhookRequestSchema = z
  .object({
    event: z.enum(EVENT_TYPES),
    target_url: z
      .string()
      .min(1)
      .superRefine((value, ctx) => {
        const problem = checkTargetUrl(value);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message });
      }),
  })
  .strict();

export type CreateWebhookRequest = z.infer<typeof createWebhookRequestSchema>;

/**
 * PF-431 — `PATCH` accepts `active` and NOTHING else.
 *
 * `event` and `target_url` are immutable, and that is a decision with a reason:
 * mutating `target_url` in place would silently redirect an existing secret to a
 * new host, so a subscriber who lost control of a domain — or an attacker who
 * gained `webhooks:manage` — could repoint a live subscription and keep the
 * secret the old owner still believes is theirs. Changing a target is
 * `DELETE` + `POST`, which mints a new secret.
 *
 * The rejection names the field, rather than a generic "unknown key", because
 * "you cannot change that" and "there is no such field" are different facts.
 */
export const patchWebhookRequestSchema = z.object({ active: z.boolean() }).strict();

export type PatchWebhookRequest = z.infer<typeof patchWebhookRequestSchema>;

/** Fields a caller plausibly PATCHes that are immutable. Data, so the test reads it. */
export const IMMUTABLE_SUBSCRIPTION_FIELDS = ['event', 'target_url'] as const;

/** Fields a caller might send on create that are token-derived or internal. */
export const REJECTED_CREATE_FIELDS = [
  'app_id',
  'workspace_id',
  'user_id',
  'signing_secret',
  'secret_prefix',
  'active',
] as const;

/** The path parameter, validated as a UUID before it reaches Postgres. */
export const webhookIdParamSchema = z.object({ id: z.string().uuid() }).strict();
