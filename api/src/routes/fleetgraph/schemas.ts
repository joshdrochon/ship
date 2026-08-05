/**
 * Request schemas for the FleetGraph endpoints.
 *
 * Kept in their own module because two callers need the same objects: the
 * routes, which parse with them, and `openapi/schemas/fleetgraph.ts`, which
 * publishes them. Defining them twice is how a documented contract and an
 * enforced one drift apart, and the drift is invisible until a client trusts
 * the wrong half.
 *
 * `.strict()` on every body is deliberate and load-bearing — see the chat
 * schema below.
 */
import { z } from 'zod';

/**
 * Snooze horizon, in BUSINESS days (PRESEARCH.md Q23).
 *
 * Three fixed options rather than a free integer, and days rather than hours,
 * because every detector threshold in Q1 is measured in business days. An
 * hours-scale snooze would wake before the underlying state could plausibly
 * have changed and would re-present a byte-identical finding — which is the
 * alert-fatigue failure the snooze exists to prevent.
 *
 * Default 3, per Q23.
 */
export const SNOOZE_HORIZONS = [1, 3, 5] as const;
export const DEFAULT_SNOOZE_DAYS = 3;

export const snoozeBodySchema = z
  .object({
    days: z
      .union([z.literal(1), z.literal(3), z.literal(5)])
      .optional()
      .default(DEFAULT_SNOOZE_DAYS)
      .describe('Snooze horizon in business days. One of 1, 3, 5. Defaults to 3.'),
  })
  .strict();

export type SnoozeBody = z.infer<typeof snoozeBodySchema>;

/**
 * Accept and dismiss carry no payload.
 *
 * Still parsed, and still `.strict()`: a client that starts sending a field
 * here is a client that believes the endpoint does something it does not, and a
 * 400 says so immediately instead of silently ignoring it. An empty `{}`, a
 * missing body and `undefined` all parse — the routes normalise with `?? {}`.
 */
export const emptyBodySchema = z.object({}).strict();

/** Ship's `document_type` enum, as of migration 038. */
export const DOCUMENT_TYPES = [
  'wiki',
  'issue',
  'program',
  'project',
  'sprint',
  'person',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
  'sprint_review',
] as const;

/**
 * On-demand chat (PRESEARCH.md Q7).
 *
 * ── Why this schema is `.strict()` ──────────────────────────────────────────
 * Q7's decision is that the chat component sends ROUTE PARAMETERS, never
 * rendered content. That is a privacy boundary: the request feeds a model call
 * that leaves the process, and an id can be re-read under the caller's own
 * visibility rules while a blob of rendered HTML cannot be checked at all.
 *
 * `.strict()` is what makes the boundary enforceable rather than aspirational.
 * A client that adds `content`, `html`, `text`, `selection` or a DOM snapshot
 * gets a 400 naming the unrecognised key. Without it, an extra field would be
 * silently dropped today and quietly picked up by whoever wires the graph
 * tomorrow — which is exactly how a privacy boundary erodes without anyone
 * deciding to erode it.
 *
 * `message` is the one free-text field, and it is not a content channel: it is
 * what the human typed into the box, never anything the page rendered.
 */
export const chatBodySchema = z
  .object({
    document_id: z.string().uuid().describe('Document in view. The id IS the context (Q7).'),
    document_type: z
      .enum(DOCUMENT_TYPES)
      .describe("Ship document_type of that document."),
    tab: z
      .string()
      .max(64)
      .nullable()
      .optional()
      .describe('Active tab within the view, e.g. "plan". Null when the route has no tab.'),
    message: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'The user question. Omit for "summarise this document\'s state" (Q9 use case 6).'
      ),
  })
  .strict();

export type ChatBody = z.infer<typeof chatBodySchema>;

/** `:id` path parameter — a notification id on every approve-path route. */
export const idParamSchema = z.object({ id: z.string().uuid() });
