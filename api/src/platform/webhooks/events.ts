/**
 * The event registry — event types as DATA, one Zod schema each (PRD p.3).
 *
 * Tickets: PF-391 (the eight types), PF-392 (a schema each, exhaustive by
 * construction), PF-393 (the envelope dispatches `data` on `type`), PF-394 (the
 * event id), PF-395 (a ninth type is a registration, not a code edit), PF-397
 * (the closed set is asserted here and nowhere else), PF-408/PF-409/PF-410 (what
 * a payload contains — decision D7).
 *
 * ## What this module is for
 *
 * PRD p.3, Event Registry: *"Event types as data … Each with a Zod schema."*
 * Two consumers generate from these schemas rather than restating them — L13's
 * OpenAPI `webhooks` section and L17's SDK event types. A hand-written second
 * copy of any of this is the drift those lanes exist to prevent, so the registry
 * is the single source and `events.fitness.test.ts` greps the repo to prove no
 * second union of these strings exists.
 *
 * ## D7 — WHAT A PAYLOAD CARRIES. This was re-litigated, not inherited.
 *
 * PRD p.15's Pre-Search 1.4 asks it directly: *"do you ship document content in
 * `document.created`, or just the ID? Defend the tradeoff between subscriber
 * convenience and exposure surface."*
 *
 * **Decision: the event carries the resource's PUBLIC API REPRESENTATION —
 * `documentSchema`, the same object `GET /api/v1/documents/{id}` returns.**
 * That is the "full object" end of the range (Stripe's model), and the previous
 * ticketed position — identifiers + `title`, never `content` — is dropped.
 *
 * The fact that settles it is one L09 already established and that the ticket
 * framing missed. **`content` was never on the table.** `documentSchema`
 * (`platform/api/v1/documents/documents.schema.ts`) is an ALLOWLIST projection
 * (PF-252, finding F17) and it is exactly:
 *
 *     { id, document_type, title, parent_id, created_at, updated_at, created_by }
 *
 * No `content`, no `properties`, no `yjs_state`. So "ship the full object" and
 * "never ship document bodies" are not opposing positions here — the public
 * representation of a Ship document is already metadata. The old framing was
 * choosing between ids-only and a thing that does not exist.
 *
 * Given that, shipping the whole representation wins on every axis that was
 * actually in tension:
 *
 *   **Exposure surface does not grow.** Every field here is a field the
 *   subscriber's own token could already read back through `GET`. The event
 *   tells a subscriber nothing the API would not. That is the honest form of
 *   the exposure argument, and ids-only was buying nothing with it.
 *
 *   **The availability coupling goes away.** Under ids-only every subscriber
 *   must make an authenticated `GET` per event — doubling the moving parts,
 *   putting our uptime inside their handler, and defeating an offline or queued
 *   consumer entirely. That was the strong case against ids-only and it stands.
 *
 *   **F10 forced this anyway.** `DELETE /api/documents/:id` is a HARD delete
 *   (`api/src/routes/documents.ts:1080`), so an ids-only `document.deleted` is
 *   unresolvable forever — the subscriber's follow-up `GET` returns 404 for all
 *   time. Ids-only could therefore never have been the universal rule; it was
 *   always going to need `document.deleted` as a carve-out. A rule with a
 *   mandatory exception on one of its three document events is not a rule.
 *
 *   **One schema cannot drift from the other.** `documentEventData` is built
 *   from `documentSchema` by `.extend()`, so the payload a subscriber receives
 *   and the resource the SDK types are the same declaration. `event.data` is
 *   assignable to the SDK's `Document`. Under ids-only they were two shapes
 *   maintained by two lanes.
 *
 * **What it costs, stated plainly.** Payload size is now proportional to the
 * projection rather than constant, which matters for fanout (p.15's 1.1); it is
 * bounded and small because the projection is seven scalar fields, but it is no
 * longer O(1). And `title` genuinely is user-authored content — that is the
 * honest objection to the old middle position and it does not disappear here,
 * it moves. See `visibility` below for where it moves to.
 *
 * ## PF-410 — private documents, and why the answer is a field and not a redaction
 *
 * `documents.visibility` is `'private' | 'workspace'`. The ticketed fix was to
 * OMIT `title` from the payload when a document is private. That is rejected,
 * for two reasons.
 *
 * First, it is the wrong boundary. **The bus is not an exposure boundary.** It
 * is in-process; nothing leaves this server until L15's matcher has selected
 * subscriptions and L16 has signed and sent. Redacting at publish time protects
 * nothing that the matcher does not have to get right anyway, and it protects it
 * only for `title` while leaving the document's existence, type, parent and
 * author in the payload — which for a private document is most of what there is
 * to leak.
 *
 * Second, a payload whose shape depends on a row's ACL state is a payload no
 * consumer can type. `title` becomes optional for every subscriber forever
 * because of a case most of them never see.
 *
 * So the payload carries **`visibility`**, and the rule it hands L15 is the one
 * that is actually correct: *a private document's event may only be delivered to
 * a subscription whose consenting user could `GET` that document* — i.e.
 * `data.created_by === subscription.user_id`, or that user is a workspace admin.
 * The payload already carries `created_by`, so the matcher needs no database
 * read to decide — which is what makes the rule enforceable for
 * `document.deleted`, where F10 means there is no row left to read.
 *
 * `visibility` is a strict superset of `documentSchema` rather than part of it
 * because it is an authorization input, not a resource field — `GET
 * /api/v1/documents/{id}` does not return it and should not start.
 */
import { z } from 'zod';
import {
  documentSchema,
  PUBLIC_DOCUMENT_TYPES,
} from '../api/v1/documents/documents.schema.js';

/**
 * PF-391 — the eight event types p.3 names, as one frozen array.
 *
 * `as const` makes the tuple the source of `EventType`, so the type and the
 * runtime list cannot disagree. `Object.freeze` makes a stray `push` at module
 * load a `TypeError` rather than a silent ninth type — the registry below is the
 * sanctioned way to add one (PF-395).
 */
export const EVENT_TYPES = Object.freeze([
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const);

export type EventType = (typeof EVENT_TYPES)[number];

// ───────────────────────────────────────────────────────────────────────────
// Resource representations
// ───────────────────────────────────────────────────────────────────────────

/**
 * The `document.*` payload: the public resource, plus the one authorization
 * field the matcher needs. See the D7 and PF-410 notes in the module header.
 */
const documentEventData = documentSchema
  .extend({
    visibility: z.enum(['private', 'workspace']),
  })
  .strict();

/**
 * `document.deleted` — the one event that cannot be "fetch on demand" (PF-409).
 *
 * The delete path is a HARD delete (finding F10), so this envelope is the ONLY
 * surviving record of the row. Every field is captured BEFORE the `DELETE`
 * runs; `deleted_at` is the moment the domain service observed the deletion,
 * not a column read back off the row (there is no row).
 */
const documentDeletedData = documentEventData
  .extend({
    deleted_at: z.string(),
  })
  .strict();

/**
 * The `issue.*` resource shape.
 *
 * Declared HERE rather than imported from L10's `issueSchema`, because L10 is
 * building `/api/v1/issues` in parallel and that schema does not exist on this
 * branch. The fields are taken from the `documents` row an issue is stored as
 * (`document_type='issue'`, with `state`/`priority`/`assignee_id` in the
 * `properties` JSONB — `api/src/db/schema.sql`), so the vocabulary matches.
 *
 * **This is a known seam, not a finished one.** When L10's `issueSchema` lands,
 * this object should be rebuilt from it by `.extend()` exactly as
 * `documentEventData` is built from `documentSchema`, so the "one declaration"
 * property in the module header holds for issues too. `events.fitness.test.ts`
 * records the gap so it is not discovered by drift.
 */
const issueEventData = z
  .object({
    id: z.string().uuid(),
    document_type: z.literal('issue'),
    title: z.string(),
    ticket_number: z.number().int().nullable(),
    state: z.string().nullable(),
    priority: z.string().nullable(),
    assignee_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    created_by: z.string().uuid().nullable(),
    visibility: z.enum(['private', 'workspace']),
  })
  .strict();

/**
 * The `sprint.*` resource shape.
 *
 * `sprint` is the `document_type` and `sprints` is the public resource name;
 * Ship's INTERNAL route for the same data is spelled differently again. That
 * divergence is route-path-and-vocabulary only — the table needs no translation
 * — and the one sanctioned place to know it is L03's `resource-map.ts`, via
 * `internalPathFor('sprints')`. PF-396's fitness test fails on the internal
 * spelling appearing anywhere in this tree, including in a comment like this one.
 */
const sprintEventData = z
  .object({
    id: z.string().uuid(),
    document_type: z.literal('sprint'),
    title: z.string(),
    sprint_number: z.number().int().nullable(),
    status: z.enum(['planning', 'active', 'completed']),
    created_at: z.string(),
    updated_at: z.string(),
    created_by: z.string().uuid().nullable(),
    visibility: z.enum(['private', 'workspace']),
  })
  .strict();

// ───────────────────────────────────────────────────────────────────────────
// PF-392 — one schema per event type, exhaustive by construction
// ───────────────────────────────────────────────────────────────────────────

/**
 * `Record<EventType, ZodTypeAny>` is the load-bearing annotation: deleting an
 * entry is a `pnpm type-check` failure, not a runtime surprise. A test also
 * iterates `EVENT_TYPES` and asserts each schema exists, is `.strict()` and
 * rejects `{}` — because the type alone would accept a schema that parses
 * anything.
 */
export const eventPayloadSchemas: Record<EventType, z.ZodTypeAny> = {
  'document.created': documentEventData,
  'document.updated': documentEventData,
  'document.deleted': documentDeletedData,

  'issue.created': issueEventData,
  /** The assignee CHANGED — both ends, so a subscriber needs no prior state. */
  'issue.assigned': issueEventData
    .extend({ previous_assignee_id: z.string().uuid().nullable() })
    .strict(),
  /** `from`/`to` are the history row's old/new values (PF-406). */
  'issue.status_changed': issueEventData
    .extend({ from: z.string().nullable(), to: z.string().nullable() })
    .strict(),

  'sprint.started': sprintEventData,
  'sprint.completed': sprintEventData,
};

// ───────────────────────────────────────────────────────────────────────────
// PF-397 — the closed set, asserted in one place
// ───────────────────────────────────────────────────────────────────────────

/** Type guard for a string from an untrusted source. */
export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Throws naming every valid type.
 *
 * L15's subscription-create validation calls THIS rather than restating the
 * list. That is the whole ticket: the day a ninth type is registered, a
 * hand-written list in a route handler is the copy that does not get updated.
 */
export function assertEventType(value: string): asserts value is EventType {
  if (!isEventType(value)) {
    throw new UnknownEventTypeError(value, EVENT_TYPES);
  }
}

export class UnknownEventTypeError extends Error {
  constructor(received: string, known: readonly string[]) {
    super(
      `"${received}" is not a registered event type. The registered types are: ` +
        `${known.join(', ')}. Adding one is a registration against an EventRegistry ` +
        `(platform/webhooks/events.ts), never an edit to the bus or a matcher.`,
    );
    this.name = 'UnknownEventTypeError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The envelope (PF-393, PF-394)
// ───────────────────────────────────────────────────────────────────────────

/**
 * What `publish()` is given. Deliberately WITHOUT `id` and `created_at`.
 *
 * PF-394: the event id is minted inside `publish()` and is the only idempotency
 * basis downstream — the delivery log's `event_id` (p.4) and the
 * `Idempotency-Key` L15/L16 derive are functions of that field and nothing
 * else. A caller that could supply its own id could supply the same one twice,
 * and the property TS-8 checks ("original idempotency key intact" across a
 * replay) would stop meaning anything.
 */
export interface PublishInput {
  type: string;
  workspace_id: string;
  data: unknown;
}

/** The signed body. `id` and `created_at` are the bus's, not the caller's. */
export interface EventEnvelope {
  id: string;
  type: string;
  created_at: string;
  workspace_id: string;
  data: unknown;
}

/** The envelope's shape, without the per-type `data` dispatch. */
const envelopeShape = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    created_at: z.string(),
    workspace_id: z.string().uuid(),
    data: z.unknown(),
  })
  .strict();

// ───────────────────────────────────────────────────────────────────────────
// PF-395 — the registry. A ninth type is a registration, not a code edit.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The map from event type to payload schema, as an object rather than a module
 * constant.
 *
 * This is the Open/Closed exhibit `docs/architecture.md` claims for events and
 * p.12 asks the architecture doc to defend with a file path. The claim is
 * checkable precisely because the registry is a value: `PF-395`'s test builds a
 * FRESH registry, registers `plugin.installed` on it, publishes through a bus
 * constructed with it, and a subscriber receives it — with `bus.ts` untouched.
 * If the type list were a module-level constant the bus imported, that test
 * could not be written without editing the bus, and "open for extension" would
 * be a comment rather than a property.
 */
export class EventRegistry {
  private readonly schemas = new Map<string, z.ZodTypeAny>();

  constructor(initial: Readonly<Record<string, z.ZodTypeAny>> = {}) {
    for (const [type, schema] of Object.entries(initial)) this.register(type, schema);
  }

  /** Register a type. Re-registering the same type is a programming error. */
  register(type: string, schema: z.ZodTypeAny): this {
    if (this.schemas.has(type)) {
      throw new Error(
        `Event type "${type}" is already registered. Registering twice means two ` +
          `payload shapes for one type name, and the one that wins is load order.`,
      );
    }
    this.schemas.set(type, schema);
    return this;
  }

  has(type: string): boolean {
    return this.schemas.has(type);
  }

  /** The registered types, in registration order. */
  types(): string[] {
    return [...this.schemas.keys()];
  }

  schemaFor(type: string): z.ZodTypeAny | undefined {
    return this.schemas.get(type);
  }

  /** Throws naming every registered type. The registry's own PF-397. */
  assertRegistered(type: string): void {
    if (!this.has(type)) throw new UnknownEventTypeError(type, this.types());
  }

  /**
   * PF-393 — parse an envelope, dispatching `data` on `type`.
   *
   * The sketch this replaces typed `data` as `z.record(z.unknown())`, which
   * accepts any object at all. The envelope is what gets SIGNED (L15), so a
   * wrong-shaped payload that parses here is a wrong-shaped payload delivered
   * under a valid signature — the subscriber has no way left to detect it.
   */
  parseEnvelope(value: unknown): EventEnvelope {
    const base = envelopeShape.parse(value);
    const schema = this.schemaFor(base.type);
    if (!schema) throw new UnknownEventTypeError(base.type, this.types());
    return { ...base, data: schema.parse(base.data) };
  }

  /** A Zod schema over this registry, for callers that want `safeParse`. */
  envelopeSchema(): z.ZodType<EventEnvelope> {
    return envelopeShape.superRefine((value, ctx) => {
      const schema = this.schemaFor(value.type);
      if (!schema) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['type'],
          message: new UnknownEventTypeError(value.type, this.types()).message,
        });
        return;
      }
      const result = schema.safeParse(value.data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ ...issue, path: ['data', ...issue.path] });
        }
      }
    }) as unknown as z.ZodType<EventEnvelope>;
  }
}

/**
 * The registry the application runs on: the eight types of p.3.
 *
 * Exported as a value so the composition root can hand it to the bus. It is not
 * reached for from inside the bus — see `bus.ts`.
 */
export const defaultEventRegistry = new EventRegistry(eventPayloadSchemas);

/**
 * PF-393's envelope schema, over the eight shipped types.
 *
 * `eventEnvelopeSchema.parse(x)` is what an envelope must satisfy before it can
 * be signed. Tests assert that an `issue.assigned` envelope whose `data` lacks
 * `assignee_id` FAILS here.
 */
export const eventEnvelopeSchema = defaultEventRegistry.envelopeSchema();

/** The public resource types a `document.*` event can be about (PF-408). */
export { PUBLIC_DOCUMENT_TYPES };
