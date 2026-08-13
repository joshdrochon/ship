/**
 * The event registry's tests — PF-391, PF-392, PF-393, PF-396, PF-397.
 *
 * PF-394 (id minted at publish) and PF-395 (a ninth type needs no bus edit) are
 * properties of `publish()`, so they live in `bus.test.ts` beside the thing that
 * has to hold them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  EVENT_TYPES,
  EventRegistry,
  UnknownEventTypeError,
  assertEventType,
  defaultEventRegistry,
  eventEnvelopeSchema,
  eventPayloadSchemas,
  isEventType,
  type EventType,
} from './events.js';
import { internalPathFor } from '../api/v1/resource-map.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..', '..');

/** The eight, written out again ON PURPOSE — see the PF-391 test. */
const P3_EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('PF-391 — EVENT_TYPES is the eight types of PRD p.3, as data', () => {
  it('set-equals the p.3 list exactly, and has length 8', () => {
    // Set equality in BOTH directions: a missing entry and an extra entry are
    // different bugs and the ticket asks for both to fail.
    expect([...EVENT_TYPES].sort()).toEqual([...P3_EVENT_TYPES].sort());
    expect(EVENT_TYPES).toHaveLength(8);
  });

  it('is frozen, so a stray push is a TypeError and not a silent ninth type', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
    expect(() => (EVENT_TYPES as unknown as string[]).push('plugin.installed')).toThrow();
  });

  it('has no duplicate entries', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('is the ONLY hand-written union of these strings in the repo', () => {
    // The registry is what L13's OpenAPI webhooks section and L17's SDK event
    // types generate FROM. A second list is the drift both lanes exist to
    // prevent, and it would not fail any other test in this file.
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      if (file.endsWith(join('webhooks', 'events.ts'))) continue;
      if (file.endsWith(join('webhooks', 'events.test.ts'))) continue;
      const source = readFileSync(file, 'utf8');
      // A file that names four or more of the eight is restating the set;
      // one or two are a legitimate reference to a specific event.
      const hits = P3_EVENT_TYPES.filter((t) => source.includes(`'${t}'`) || source.includes(`"${t}"`));
      if (hits.length >= 4) offenders.push(`${file.slice(API_SRC.length + 1)} (${hits.length} types)`);
    }
    expect(
      offenders,
      'These files restate the event-type set. Import EVENT_TYPES from ' +
        'platform/webhooks/events.ts instead — a second copy is what drifts.',
    ).toEqual([]);
  });
});

describe('PF-392 — one Zod payload schema per event type, exhaustive by construction', () => {
  it('every event type has a schema', () => {
    // `Record<EventType, ZodTypeAny>` makes a DELETED entry a type error; this
    // covers the other direction and the runtime.
    for (const type of EVENT_TYPES) {
      expect(eventPayloadSchemas[type], `no schema registered for ${type}`).toBeDefined();
    }
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('every schema is .strict() — an unknown key is a parse failure', () => {
    for (const type of EVENT_TYPES) {
      const schema = eventPayloadSchemas[type] as z.ZodTypeAny;
      const withJunk = { ...validPayloadFor(type), __unexpected__: 'x' };
      const result = schema.safeParse(withJunk);
      expect(result.success, `${type} accepted an unknown key — it is not .strict()`).toBe(false);
    }
  });

  it('every schema rejects {}', () => {
    for (const type of EVENT_TYPES) {
      expect(
        (eventPayloadSchemas[type] as z.ZodTypeAny).safeParse({}).success,
        `${type} accepted an empty payload`,
      ).toBe(false);
    }
  });

  it('D7 — no schema admits `content` or `properties`', () => {
    // The decision is "the public API representation", and that projection
    // (PF-252) contains neither. This asserts the property rather than the
    // wording: if someone extends a payload with a document body, this fails.
    for (const type of EVENT_TYPES) {
      const schema = eventPayloadSchemas[type] as z.ZodTypeAny;
      for (const forbidden of ['content', 'properties', 'yjs_state']) {
        const probe = { ...validPayloadFor(type), [forbidden]: { any: 'thing' } };
        expect(
          schema.safeParse(probe).success,
          `${type} accepted a "${forbidden}" key. D7 ships the public projection, ` +
            `which is metadata only — see the module header in events.ts.`,
        ).toBe(false);
      }
    }
  });

  it('D7 — every document/issue/sprint payload carries `visibility` for L15\'s matcher', () => {
    // PF-410's replacement. The matcher cannot gate a private document without
    // this field, and for `document.deleted` there is no row left to read it
    // from (finding F10).
    for (const type of EVENT_TYPES) {
      const valid = validPayloadFor(type) as Record<string, unknown>;
      expect(valid.visibility, `${type} has no visibility field`).toBeDefined();
      const { visibility: _dropped, ...withoutVisibility } = valid;
      expect(
        (eventPayloadSchemas[type] as z.ZodTypeAny).safeParse(withoutVisibility).success,
        `${type} parsed without visibility — the matcher would have to guess`,
      ).toBe(false);
    }
  });
});

describe('PF-393 — the envelope dispatches `data` on `type`', () => {
  it('accepts a well-formed envelope', () => {
    const result = eventEnvelopeSchema.safeParse(envelopeFor('document.created'));
    expect(result.success, JSON.stringify((result as { error?: unknown }).error)).toBe(true);
  });

  it('REJECTS an issue.assigned envelope whose data has no assignee_id', () => {
    // The ticket's named case. The sketch typed `data` as `z.record(z.unknown())`,
    // which accepted this. The envelope is what gets signed (L15), so a
    // wrong-shaped payload that parses here ships under a valid signature.
    const bad = { ...envelopeFor('issue.assigned'), data: { id: crypto.randomUUID() } };
    expect(eventEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a payload belonging to a DIFFERENT registered type', () => {
    const mismatched = {
      ...envelopeFor('sprint.started'),
      data: validPayloadFor('document.created'),
    };
    expect(eventEnvelopeSchema.safeParse(mismatched).success).toBe(false);
  });

  it('is .strict() at the envelope level too', () => {
    const extra = { ...envelopeFor('document.created'), tenant: 'sneaky' };
    expect(eventEnvelopeSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects an unregistered type', () => {
    const unknown = { ...envelopeFor('document.created'), type: 'document.exploded' };
    expect(eventEnvelopeSchema.safeParse(unknown).success).toBe(false);
  });

  it('reports the failing path under `data`, so a signer log names the field', () => {
    const bad = { ...envelopeFor('issue.assigned'), data: { id: crypto.randomUUID() } };
    const result = eventEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'data')).toBe(true);
    }
  });
});

describe('PF-397 — an unknown event type is rejected by the registry, not by a route', () => {
  it('assertEventType throws, and the message enumerates all eight', () => {
    expect(() => assertEventType('document.exploded')).toThrow(UnknownEventTypeError);
    let message = '';
    try {
      assertEventType('document.exploded');
    } catch (err) {
      message = (err as Error).message;
    }
    for (const type of EVENT_TYPES) {
      expect(message, `the error does not name ${type}`).toContain(type);
    }
  });

  it('assertEventType accepts every registered type', () => {
    for (const type of EVENT_TYPES) expect(() => assertEventType(type)).not.toThrow();
  });

  it('isEventType is the guard', () => {
    expect(isEventType('sprint.started')).toBe(true);
    expect(isEventType('sprint.exploded')).toBe(false);
  });
});

describe('PF-395 — the registry is open for extension', () => {
  it('a fresh registry takes a ninth type and validates it', () => {
    const registry = new EventRegistry({ 'plugin.installed': z.object({ id: z.string() }).strict() });
    expect(registry.types()).toEqual(['plugin.installed']);
    expect(registry.has('plugin.installed')).toBe(true);
    expect(() => registry.parseEnvelope({
      id: crypto.randomUUID(),
      type: 'plugin.installed',
      created_at: new Date().toISOString(),
      workspace_id: crypto.randomUUID(),
      data: { id: 'app_1' },
    })).not.toThrow();
  });

  it('registering the same type twice throws rather than silently winning on load order', () => {
    const registry = new EventRegistry();
    registry.register('plugin.installed', z.object({ id: z.string() }));
    expect(() => registry.register('plugin.installed', z.object({ other: z.string() }))).toThrow(
      /already registered/,
    );
  });

  it('the default registry holds exactly the eight', () => {
    expect(defaultEventRegistry.types().sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe('PF-396 — sprint events resolve through L03\'s resource map, never a local copy', () => {
  it('no file under platform/webhooks/ contains a `weeks` literal', () => {
    // The trap: the public event is `sprint.started`, the `document_type` is
    // already `'sprint'`, but the INTERNAL route is `/api/weeks`. That
    // divergence is route-path-and-vocabulary only, and L03's resource-map.ts
    // is the one sanctioned place to know it.
    const offenders: string[] = [];
    for (const file of walk(join(API_SRC, 'platform', 'webhooks'))) {
      if (file.endsWith('events.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (/['"`]weeks['"`]|\/api\/weeks/.test(source)) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(
      offenders,
      'platform/webhooks/** must not name Ship\'s internal `weeks` vocabulary. ' +
        'Resolve it through internalPathFor(\'sprints\') in platform/api/v1/resource-map.ts.',
    ).toEqual([]);
  });

  it('the resource map is what knows sprints/weeks, and it still does', () => {
    // Guards the other direction: if the map stopped carrying the mapping, the
    // grep above would pass vacuously.
    expect(internalPathFor('sprints')).toBe('/api/weeks');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function validPayloadFor(type: EventType): Record<string, unknown> {
  const iso = new Date().toISOString();
  const uuid = () => crypto.randomUUID();
  const base = {
    id: uuid(),
    title: 'A title',
    created_at: iso,
    updated_at: iso,
    created_by: uuid(),
    visibility: 'workspace' as const,
  };
  switch (type) {
    case 'document.created':
    case 'document.updated':
      return { ...base, document_type: 'wiki', parent_id: null };
    case 'document.deleted':
      return { ...base, document_type: 'wiki', parent_id: null, deleted_at: iso };
    case 'issue.created':
      return { ...base, document_type: 'issue', ticket_number: 7, state: 'backlog', priority: 'p2', assignee_id: null };
    case 'issue.assigned':
      return { ...base, document_type: 'issue', ticket_number: 7, state: 'backlog', priority: 'p2', assignee_id: uuid(), previous_assignee_id: null };
    case 'issue.status_changed':
      return { ...base, document_type: 'issue', ticket_number: 7, state: 'in_progress', priority: 'p2', assignee_id: null, from: 'backlog', to: 'in_progress' };
    case 'sprint.started':
      return { ...base, document_type: 'sprint', sprint_number: 3, status: 'active' };
    case 'sprint.completed':
      return { ...base, document_type: 'sprint', sprint_number: 3, status: 'completed' };
  }
}

function envelopeFor(type: EventType) {
  return {
    id: crypto.randomUUID(),
    type,
    created_at: new Date().toISOString(),
    workspace_id: crypto.randomUUID(),
    data: validPayloadFor(type),
  };
}
