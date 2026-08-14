/**
 * `IEventBus` — the seam between a domain write and webhook delivery.
 *
 * Tickets: PF-398 (the interface), PF-399 (the in-process implementation),
 * PF-400 (handler isolation), PF-401 (the Liskov contract suite), PF-402
 * (constructed at the composition root only), PF-394 (the event id).
 *
 * ## The rule this module exists for
 *
 * PRD p.3: *"IEventBus interface. Domain layer publishes on writes — **never the
 * route layer**. In-process implementation must-ship; queue-backed
 * implementation is a Liskov-substitutable drop-in."*
 *
 * "Never the route layer" is mechanical, not aspirational:
 * `publishFitness.test.ts` fails on any `.publish(` under
 * `api/src/platform/api/v1/**` or `api/src/routes/**`. The permitted call sites
 * are an explicit allowlist of domain-service modules, and the test also asserts
 * that allowlist is non-empty and that each entry really contains a publish
 * call — an empty allowlist over an unwired codebase passes vacuously, which is
 * exactly how this rule would rot.
 *
 * The reason is not style. Two surfaces create documents — internal
 * `POST /api/documents` (session + CSRF) and public `POST /api/v1/documents`
 * (bearer) — and both call `documentService.create`. Publishing from the route
 * means two publish sites, and the one nobody remembers is the one that stops
 * firing.
 *
 * ### A correction to the sketch this file replaces (finding F13)
 *
 * The previous version justified the rule by saying non-HTTP writers "(the
 * FleetGraph agent, seeds, migrations)" must emit too. That does not survive
 * contact with the repo. The agent writes only `fleetgraph_*` tables and touches
 * `documents` nowhere outside tests and fixtures, so it is not a document writer
 * at all. Seeds and migrations ARE real non-HTTP writers — and they must
 * emphatically **not** publish: `pnpm db:seed` inserts 14 documents, and a seed
 * run that fanned those out to live subscriptions is a self-inflicted incident.
 * That is what `NoopEventBus` below is for. The rule still holds; it holds
 * because p.3 says so and because of the two-surfaces argument above, not
 * because of the reason the sketch gave.
 *
 * ## PUBLISH TIMING — the contract L15 and L16 build to (dispute B2)
 *
 * This was a live disagreement and this file settles it, because L15 and L16 are
 * unbuilt and will build to whatever ships here.
 *
 * **`publish()` resolves when every subscriber has ACCEPTED the event — never
 * when any network I/O completes. A handler MUST NOT perform outbound network
 * I/O.**
 *
 * "Accepted" means the handler has taken durable responsibility for the event:
 * for L15/L16 that is matching subscriptions, signing, and writing the delivery
 * row or enqueueing. The HTTP POST to the subscriber happens *after* the handler
 * returns, off the request path.
 *
 * That single sentence reconciles what looked like two incompatible readings:
 *
 *   **L14's side (PF-399/PF-404).** Handlers are awaited and dispatch is
 *   synchronous, so a test can assert a handler's effect on the next line with
 *   no `await` gap, no timer and no sleep. p.11 requires the in-memory path to
 *   *"resolve synchronously"*; that is what makes TS-6's 2 s budget a non-issue
 *   and keeps the suite free of the flake p.9 budgets at 0% over 20 runs.
 *
 *   **L15's side (PF-441).** Signing and enqueueing without awaiting the wire is
 *   correct and stays correct — because the wire was never inside `publish()`.
 *   L15 reads p.11's "resolves synchronously" as scoped to tests; under this
 *   contract it does not need to, since the synchronous part is in-process
 *   bookkeeping either way.
 *
 * The budget is why it has to be stated rather than left to each lane. MVP-9
 * allows +10% on P95 against the Part 1 baseline (p.2, p.6). Work on the request
 * path is bounded here at "in-process dispatch plus whatever the subscriber
 * writes locally", which is a number we control. If a handler were allowed to
 * `fetch()` a subscriber's URL, a third party's latency would be inside Ship's
 * P95 and the budget would be theirs to blow, not ours.
 *
 * `slowHandlerMs` makes the contract observable rather than merely documented: a
 * handler that exceeds it logs a warning naming the handler and the event. It is
 * a warning and not a rejection deliberately — failing a domain write because a
 * subscriber was slow is the failure PF-400 exists to prevent.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import {
  EventRegistry,
  defaultEventRegistry,
  type EventEnvelope,
  type PublishInput,
} from './events.js';

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

/** Subscribe to one event type, or to `'*'` for every event. */
export type SubscriptionTarget = string | '*';

/**
 * PF-398 — two methods, no transport knowledge.
 *
 * This is the Dependency Inversion exhibit p.12 asks the architecture doc to
 * name with a file path. The module imports `node:crypto` and this repo's own
 * `Clock`; it imports nothing from `express`, `pg` or `node:http`, and
 * `bus.test.ts` asserts that by reading the source rather than by inspection. A
 * bus that knew what a request was could not be the thing a queue-backed
 * implementation drops into.
 */
export interface IEventBus {
  /**
   * Publish one event.
   *
   * Takes a `PublishInput` — `{type, workspace_id, data}` — and NOT a finished
   * envelope: `id` and `created_at` are minted here (PF-394). Resolves per the
   * timing contract in the module header.
   */
  publish(input: PublishInput): Promise<void>;

  /** Register a handler for one type, or `'*'`. */
  subscribe(type: SubscriptionTarget, handler: EventHandler): void;
}

export interface EventBusOptions {
  /** The type→schema map the envelope is validated against. */
  registry?: EventRegistry;
  /**
   * The only source of `created_at`. Injected so tests are deterministic.
   *
   * `Pick<Clock, 'nowMs'>` rather than the whole `Clock`: the bus reads time and
   * never SCHEDULES any, which is the same fact PF-399's no-timers grep asserts
   * from the other direction. Asking for the narrower type means a caller cannot
   * read a scheduling capability into this dependency, and a test can pass
   * `{ nowMs: () => 0 }` without stubbing a `setTimeout` the bus would never call.
   */
  clock?: Pick<Clock, 'nowMs'>;
  /** Mints `event.id`. Injected only so PF-394's uniqueness test can be exact. */
  newId?: () => string;
  /** Where handler failures and slow handlers are reported. */
  logger?: Pick<Console, 'error' | 'warn'>;
  /** Warn above this many ms in a single handler. See the B2 note above. */
  slowHandlerMs?: number;
}

/** Default ceiling for a single handler before it is called out in the log. */
export const DEFAULT_SLOW_HANDLER_MS = 250;

/**
 * PF-399 — the must-ship implementation. Synchronous, awaited, ordered.
 *
 * Every subscribed handler has run before `publish()`'s promise resolves.
 * Targeted handlers run before wildcard handlers, and within each group in
 * registration order. There is no `setTimeout` and no `setInterval` in this
 * module and a grep test asserts it — a bus that deferred dispatch to a timer
 * would make every downstream test a race.
 */
export class InProcessEventBus implements IEventBus {
  private readonly handlers = new Map<SubscriptionTarget, EventHandler[]>();
  private readonly registry: EventRegistry;
  private readonly clock: Pick<Clock, 'nowMs'> | undefined;
  private readonly newId: () => string;
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private readonly slowHandlerMs: number;

  constructor(options: EventBusOptions = {}) {
    this.registry = options.registry ?? defaultEventRegistry;
    this.clock = options.clock;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? console;
    this.slowHandlerMs = options.slowHandlerMs ?? DEFAULT_SLOW_HANDLER_MS;
  }

  subscribe(type: SubscriptionTarget, handler: EventHandler): void {
    const list = this.handlers.get(type);
    if (list) list.push(handler);
    else this.handlers.set(type, [handler]);
  }

  async publish(input: PublishInput): Promise<void> {
    const envelope = this.mint(input);

    // Targeted first, then wildcard; registration order within each. Wildcard
    // subscribers are observers (audit, the delivery pipeline's catch-all);
    // running them last means a targeted handler's effect is already in place.
    const targeted = this.handlers.get(envelope.type) ?? [];
    const wildcard = this.handlers.get('*') ?? [];

    for (const handler of [...targeted, ...wildcard]) {
      // PF-400 — isolation. A throwing handler must not prevent later handlers
      // from running and must not reject this promise.
      //
      // DECISION, and it is a decision rather than a requirement: the bus is
      // at-most-once IN-PROCESS and never fails the domain write. A webhook
      // subscriber must not be able to break `POST /documents`. Delivery
      // durability is L16's problem — that is what the delivery log, the retry
      // ladder and the DLQ are for, and solving it here would mean the bus
      // needed its own storage. p.17's 3.1 asks at-least-once vs at-most-once
      // about the DELIVERER, not the bus, so it is not cited as the source.
      const startedMs = this.clock?.nowMs() ?? Date.now();
      try {
        await handler(envelope);
      } catch (err) {
        this.logger.error(
          `[webhooks] subscriber threw for ${envelope.type} (event ${envelope.id}); ` +
            `later handlers still ran and the domain write is unaffected.`,
          err,
        );
      }
      const elapsedMs = (this.clock?.nowMs() ?? Date.now()) - startedMs;
      if (elapsedMs > this.slowHandlerMs) {
        this.logger.warn(
          `[webhooks] a subscriber took ${elapsedMs}ms for ${envelope.type} (event ` +
            `${envelope.id}), over the ${this.slowHandlerMs}ms budget. publish() is on ` +
            `the request path — handlers accept and enqueue, they must not do network ` +
            `I/O. See the publish-timing contract in platform/webhooks/bus.ts.`,
        );
      }
    }
  }

  /**
   * PF-394 — the id is minted HERE and nowhere else.
   *
   * It is the only idempotency basis downstream: the delivery log's `event_id`
   * (p.4) and the `Idempotency-Key` L15/L16 derive are functions of this field
   * and nothing else. A caller that supplied its own id could supply the same
   * one twice, and TS-8's "original idempotency key intact" across a replay
   * would stop meaning anything.
   *
   * The envelope is validated against the registry before any handler sees it,
   * so a wrong-shaped payload fails at the publish site — where the stack trace
   * still points at the domain code that built it — rather than inside the
   * signer, where it would ship under a valid signature (PF-393).
   */
  private mint(input: PublishInput): EventEnvelope {
    const createdAtMs = this.clock?.nowMs() ?? Date.now();
    const candidate: EventEnvelope = {
      id: this.newId(),
      type: input.type,
      created_at: new Date(createdAtMs).toISOString(),
      workspace_id: input.workspace_id,
      data: input.data,
    };
    return this.registry.parseEnvelope(candidate);
  }
}

/**
 * PF-401/PF-016 — the test double, and a genuine Liskov substitute.
 *
 * It DISPATCHES as well as records: a double that only recorded would pass the
 * shared contract suite for the wrong reason, and every test that subscribes a
 * handler through `testDeps()` would silently observe nothing. Recording is
 * additive behaviour on top of the in-process semantics, which is what makes
 * running the same contract suite against both a real check.
 */
export class RecordingEventBus extends InProcessEventBus {
  /** Every envelope published, in order, exactly as subscribers received it. */
  readonly events: EventEnvelope[] = [];

  constructor(options: EventBusOptions = {}) {
    super(options);
    // Recorded through the ordinary subscription mechanism rather than by
    // overriding `publish`, so recording sees precisely what a subscriber sees
    // — including that the envelope was registry-validated first.
    this.subscribe('*', (event) => {
      this.events.push(event);
    });
  }

  /** The envelopes of one type. */
  ofType(type: string): EventEnvelope[] {
    return this.events.filter((e) => e.type === type);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/**
 * PF-402 — the bus for writers that must NOT publish: seeds and migrations.
 *
 * `pnpm db:seed` inserts 14 documents (`api/src/db/seed.ts`). Those are fixture
 * rows, not events a workspace's integrations should hear about, and a seed run
 * that fanned them out to live subscriptions is a self-inflicted incident. A
 * migration backfilling a column is the same shape of problem, larger.
 *
 * This is a real object rather than `undefined` so the domain service has one
 * code path: `create()` always publishes, and what varies is who is listening.
 * An optional bus means an `if (bus)` at every call site and the one that is
 * missing is a silently unfired event.
 */
export class NoopEventBus implements IEventBus {
  // The parameters are declared and unused on purpose: this is a Liskov
  // substitute, so its signature must be the interface's. A zero-argument
  // `publish()` would still satisfy `IEventBus` structurally while breaking
  // every caller that passes through a concrete `NoopEventBus` reference.
  async publish(_input: PublishInput): Promise<void> {
    /* deliberately nothing — see the class comment */
  }

  subscribe(_type: SubscriptionTarget, _handler: EventHandler): void {
    /* nothing can arrive, so a subscription is not an error, just inert */
  }
}
