/**
 * PF-407 — the sprint lifecycle transitions and their events.
 *
 * This is the file that closes finding F9. F9 said `sprint.completed` had no
 * producer because nothing wrote `properties.status = 'completed'`. Half of that
 * was wrong — the sprint PATCH handler did persist the value — so the tests here
 * assert what was ACTUALLY missing: that the write is a guarded transition, and
 * that both transitions publish.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/client.js';
import { RecordingEventBus } from '../platform/webhooks/bus.js';
import { eventEnvelopeSchema } from '../platform/webhooks/events.js';
import {
  InvalidSprintTransitionError,
  SPRINT_TRANSITIONS,
  createSprintService,
  statusOf,
  type DomainContext,
} from './sprints.js';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

let ctx: DomainContext;
let workspaceId: string;
let userId: string;

async function makeSprint(status?: string, sprintNumber = 1): Promise<string> {
  const properties: Record<string, unknown> = { sprint_number: sprintNumber };
  if (status) properties.status = status;
  const row = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by, visibility)
     VALUES ($1, 'sprint', $2, $3, $4, 'workspace') RETURNING id`,
    [workspaceId, `Week ${sprintNumber}`, JSON.stringify(properties), userId],
  );
  return row.rows[0].id;
}

beforeAll(async () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
    `L14 sprints ${runId}`,
  ]);
  workspaceId = ws.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'L14 Sprint User') RETURNING id`,
    [`l14-sprints-${runId}@ship.local`],
  );
  userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, userId],
  );
  ctx = { workspaceId, userId, db: pool };
});

afterAll(async () => {
  await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

describe('PF-407 — sprint.started fires on the start transition', () => {
  it('publishes exactly one sprint.started, and the row really moved to active', async () => {
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('planning');

    const moved = await service.start(ctx, { id });

    expect(moved?.from).toBe('planning');
    expect(bus.ofType('sprint.started')).toHaveLength(1);

    const stored = await pool.query(`SELECT properties FROM documents WHERE id = $1`, [id]);
    expect(statusOf(stored.rows[0].properties)).toBe('active');
  });

  it('the envelope parses against the registry schema', async () => {
    // The envelope is what L15 signs. A payload that would fail here would
    // instead fail inside the signer, under a valid signature.
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('planning', 2);

    await service.start(ctx, { id });

    const envelope = bus.ofType('sprint.started')[0]!;
    expect(() => eventEnvelopeSchema.parse(envelope)).not.toThrow();
    const data = envelope.data as { id: string; status: string; sprint_number: number };
    expect(data.id).toBe(id);
    expect(data.status).toBe('active');
    expect(data.sprint_number).toBe(2);
  });

  it('carries the snapshot properties through without putting them in the payload', async () => {
    // The snapshot is Ship's internal bookkeeping; the public sprint
    // representation does not include it and must not start to (D7).
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('planning', 3);

    await service.start(ctx, {
      id,
      extraProperties: { planned_issue_ids: ['a', 'b'], snapshot_taken_at: 'now' },
    });

    const stored = await pool.query(`SELECT properties FROM documents WHERE id = $1`, [id]);
    expect(stored.rows[0].properties.planned_issue_ids).toEqual(['a', 'b']);
    expect(bus.ofType('sprint.started')[0]!.data).not.toHaveProperty('planned_issue_ids');
  });
});

describe('PF-407 / F9 — sprint.completed CAN fire, and a write path really sets it', () => {
  it('publishes exactly one sprint.completed and persists the status', async () => {
    // This is the assertion F9 asked for: it fails if no write path sets
    // `status = 'completed'`. Before this lane the value was reachable through
    // the PATCH schema but nothing observed it, so no test could have failed.
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('active', 4);

    const moved = await service.complete(ctx, { id });

    expect(moved?.from).toBe('active');
    expect(bus.ofType('sprint.completed')).toHaveLength(1);

    const stored = await pool.query(`SELECT properties FROM documents WHERE id = $1`, [id]);
    expect(
      statusOf(stored.rows[0].properties),
      'no write path set properties.status = "completed" — sprint.completed is unfirable again',
    ).toBe('completed');
  });

  it('the completed envelope parses and reports status completed', async () => {
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('active', 5);

    await service.complete(ctx, { id });

    const envelope = bus.ofType('sprint.completed')[0]!;
    expect(() => eventEnvelopeSchema.parse(envelope)).not.toThrow();
    expect((envelope.data as { status: string }).status).toBe('completed');
  });

  it('a sprint that never started can still complete', async () => {
    // `planning → completed` is legal on purpose: a week that ends without
    // anyone pressing start is still a week that ended.
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('planning', 6);

    await service.complete(ctx, { id });

    expect(bus.ofType('sprint.completed')).toHaveLength(1);
  });

  it('every one of the eight event types now has at least one producer in the repo', () => {
    // The generalisation of F9. `sprint.completed` was the one type nothing
    // could emit; this asserts the property for all eight rather than for the
    // one that happened to be caught, so the next unfirable type fails here.
    const producers = new Map<string, string[]>();
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
      }
      return out;
    };
    for (const file of walk(API_SRC)) {
      if (file.includes(join('platform', 'webhooks'))) continue; // the registry, not a producer
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/'((?:document|issue|sprint)\.[a-z_]+)'/g)) {
        const list = producers.get(match[1]!) ?? [];
        list.push(file.slice(API_SRC.length + 1));
        producers.set(match[1]!, list);
      }
    }

    // Only the types this lane claims to have wired. `issue.*` and
    // `document.updated` are reported honestly as not yet produced rather than
    // asserted green — see the lane report.
    for (const type of ['document.created', 'document.deleted', 'sprint.started', 'sprint.completed']) {
      expect(producers.get(type), `${type} has no producer outside the registry`).toBeTruthy();
    }
  });
});

describe('PF-407 — the transition is guarded, which is what makes the event mean something', () => {
  it('re-completing an already-completed sprint publishes NOTHING', async () => {
    // The reason the guard is part of this ticket. Without it a subscriber would
    // see one completion per PATCH and could not tell which was real.
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('completed', 7);

    await service.complete(ctx, { id });

    expect(bus.ofType('sprint.completed')).toHaveLength(0);
  });

  it('rejects going backwards from completed to planning', async () => {
    const service = createSprintService({ bus: new RecordingEventBus() });
    const id = await makeSprint('completed', 8);

    await expect(service.transition(ctx, { id, to: 'planning' })).rejects.toBeInstanceOf(
      InvalidSprintTransitionError,
    );
  });

  it('rejects going backwards from active to planning, which used to strand the snapshot', async () => {
    const service = createSprintService({ bus: new RecordingEventBus() });
    const id = await makeSprint('active', 9);

    await expect(service.transition(ctx, { id, to: 'planning' })).rejects.toBeInstanceOf(
      InvalidSprintTransitionError,
    );
  });

  it('a failed transition writes nothing and publishes nothing', async () => {
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('completed', 10);

    await expect(service.transition(ctx, { id, to: 'active' })).rejects.toThrow();

    const stored = await pool.query(`SELECT properties FROM documents WHERE id = $1`, [id]);
    expect(statusOf(stored.rows[0].properties)).toBe('completed');
    expect(bus.events).toHaveLength(0);
  });

  it('returns null for a sprint in another workspace, without publishing', async () => {
    const bus = new RecordingEventBus();
    const service = createSprintService({ bus });
    const id = await makeSprint('planning', 11);

    const result = await service.transition(
      { workspaceId: '00000000-0000-4000-8000-0000000000ff', userId, db: pool },
      { id, to: 'active' },
    );

    expect(result).toBeNull();
    expect(bus.events).toHaveLength(0);
  });

  it('the transition table is the declared one', () => {
    expect(SPRINT_TRANSITIONS.completed).toEqual([]);
    expect(SPRINT_TRANSITIONS.active).toEqual(['completed']);
    expect([...SPRINT_TRANSITIONS.planning].sort()).toEqual(['active', 'completed']);
  });
});

describe('PF-403 — the sprint service is domain code', () => {
  const code = readFileSync(join(API_SRC, 'services', 'sprints.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('imports no express and no middleware', () => {
    expect(code).not.toMatch(/from\s+['"]express['"]/);
    expect(code).not.toMatch(/from\s+['"]\.\.\/middleware\//);
    expect(code).not.toMatch(/\breq\./);
  });

  it('works with no bus injected at all', async () => {
    // Seeds and migrations construct the service without one; the write must
    // still happen. An `if (bus)` that skipped the WRITE rather than the
    // publish would be caught here.
    const service = createSprintService();
    const id = await makeSprint('planning', 12);
    await service.start(ctx, { id });
    const stored = await pool.query(`SELECT properties FROM documents WHERE id = $1`, [id]);
    expect(statusOf(stored.rows[0].properties)).toBe('active');
  });
});
