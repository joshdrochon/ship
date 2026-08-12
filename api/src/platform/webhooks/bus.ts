/**
 * IEventBus — the internal wire between domain writes and webhook delivery.
 *
 * DOMAIN code publishes (the moment the write commits), never the route layer:
 * non-HTTP writers (the FleetGraph agent, seeds, migrations) must emit too.
 *
 * InProcessEventBus is the must-ship implementation: synchronous handler
 * dispatch = deterministic tests, zero sleeps. A queue-backed bus (BullMQ/SQS)
 * is a Liskov drop-in behind this same interface — a composition-root change.
 */
import type { EventEnvelope, EventType } from './events.js';

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface IEventBus {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(type: EventType | '*', handler: EventHandler): void;
}

export class InProcessEventBus implements IEventBus {
  private handlers = new Map<string, EventHandler[]>();

  subscribe(type: EventType | '*', handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async publish(event: EventEnvelope): Promise<void> {
    const targeted = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get('*') ?? [];
    for (const handler of [...targeted, ...wildcard]) {
      // Sequential + awaited: deterministic ordering under test. A handler
      // error must not swallow later handlers.
      try {
        await handler(event);
      } catch (err) {
        console.error(`[webhooks] handler failed for ${event.type} (${event.id}):`, err);
      }
    }
  }
}
