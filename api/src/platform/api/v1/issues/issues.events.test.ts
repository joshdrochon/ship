/**
 * PF-292 / PF-293 — the three `issue.*` events, published from the DOMAIN
 * service and hung off the diff the history loop already walks.
 *
 * PRD p.3 registers eight event types. Before this slice, three of them had no
 * producer at all: `.publish(` had exactly two call sites repo-wide, in
 * `services/documents.ts` and `services/sprints.ts`. `issue.created`,
 * `issue.assigned` and `issue.status_changed` existed only in the registry.
 *
 * The rule these tests enforce is PRD p.3's: *"Domain layer publishes on writes
 * — never the route layer."* The route-level grep lives in
 * `issues.fitness.test.ts`; this file asserts the behaviour.
 *
 * ## Why the diff is the subject rather than the outcome
 *
 * `issue.status_changed` could be produced by comparing the row before and after
 * the write. It is not: the events read the SAME `changes[]` array that
 * `logDocumentChange` writes to `document_history`. That is what makes the
 * envelope's `{from, to}` equal to the history row's `old_value`/`new_value` by
 * construction rather than by coincidence — a second comparison would be a
 * second implementation, and the one nobody remembers is the one that drifts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../../db/client.js';
import { createIssueService } from '../../../../services/issues.js';
import { RecordingEventBus } from '../../../webhooks/bus.js';

describe('issue.* events publish from the domain service', () => {
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L10 issue events ${runId}`,
    ]);
    workspaceId = ws.rows[0].id;
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Events User') RETURNING id`,
      [`l10-events-${runId}@ship.local`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM document_history WHERE document_id IN
        (SELECT id FROM documents WHERE workspace_id = $1)`,
      [workspaceId],
    );
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  const ctx = () => ({ workspaceId, userId, db: pool });

  it('PF-292 — create publishes exactly one issue.created, and its id resolves', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    expect(service.bus, 'the injected bus must reach the service').toBe(bus);

    const row = await service.create(ctx(), { title: 'Bus seam', priority: 'high' });

    expect(bus.ofType('issue.created')).toHaveLength(1);
    const data = bus.ofType('issue.created')[0]!.data as {
      id: string;
      document_type: string;
      title: string;
      priority: string;
    };
    expect(data.id).toBe(row.id);
    expect(data.document_type).toBe('issue');
    expect(data.title).toBe('Bus seam');
    expect(data.priority).toBe('high');

    // The COMMITTED row is really there under the id the event advertised. That
    // round trip is the property that matters: an event published inside the
    // transaction would name an id a subscriber's follow-up GET cannot resolve,
    // and asserting the id is merely truthy would not catch it.
    const persisted = await pool.query(`SELECT id FROM documents WHERE id = $1`, [data.id]);
    expect(persisted.rows).toHaveLength(1);
  });

  it('a service with no bus creates the issue and publishes nothing', async () => {
    // The internal surface predates the bus and must keep working without one.
    const service = createIssueService();
    const row = await service.create(ctx(), { title: 'No bus' });
    expect(row.id).toBeTruthy();
  });

  it('a failed create publishes nothing — the rollback case', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    // A `belongs_to` pointing at an id that is not a document violates the FK,
    // so the INSERT into `document_associations` fails inside the transaction.
    await expect(
      service.create(ctx(), {
        title: 'Doomed',
        belongsTo: [{ id: '00000000-0000-4000-8000-000000000000', type: 'sprint' }],
      }),
    ).rejects.toThrow();

    expect(
      bus.ofType('issue.created'),
      'an event fired for a row that was rolled back',
    ).toHaveLength(0);
  });

  it('PF-293 — a state change emits exactly one issue.status_changed matching the history row', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    // Created through a BUS-LESS service so the assertions below are about the
    // update path alone — `RecordingEventBus` has no reset, and filtering after
    // the fact would hide a create that published the wrong thing.
    const row = await createIssueService().create(ctx(), { title: 'Moving', state: 'todo' });

    const result = await service.update(ctx(), {
      id: row.id,
      patch: { state: 'in_progress' },
    });
    expect(result).not.toBeNull();

    const events = bus.ofType('issue.status_changed');
    expect(events).toHaveLength(1);
    const data = events[0]!.data as { id: string; from: string; to: string; state: string };
    expect(data.id).toBe(row.id);

    // The envelope's from/to equal the HISTORY row's old_value/new_value. Read
    // out of the table rather than restated, so the two cannot agree by having
    // both been typed from the same expectation.
    const history = await pool.query<{ old_value: string; new_value: string }>(
      `SELECT old_value, new_value FROM document_history
        WHERE document_id = $1 AND field = 'state'`,
      [row.id],
    );
    expect(history.rows).toHaveLength(1);
    expect(data.from).toBe(history.rows[0]!.old_value);
    expect(data.to).toBe(history.rows[0]!.new_value);
    expect(data.to).toBe('in_progress');
  });

  it('PF-293 — a PATCH changing state AND assignee emits both events, once each', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    // Created through a BUS-LESS service so the assertions below are about the
    // update path alone — `RecordingEventBus` has no reset, and filtering after
    // the fact would hide a create that published the wrong thing.
    const row = await createIssueService().create(ctx(), { title: 'Two fields', state: 'todo' });

    await service.update(ctx(), {
      id: row.id,
      patch: { state: 'done', assigneeId: userId },
    });

    expect(bus.ofType('issue.status_changed')).toHaveLength(1);
    expect(bus.ofType('issue.assigned')).toHaveLength(1);

    // L14's registry shape (PF-406): the NEW assignee rides the base payload's
    // `assignee_id` and the old one is `previous_assignee_id`, so a subscriber
    // needs no prior state. The schema is `.strict()`, so a publish carrying an
    // invented `{from,to}` pair throws at the bus rather than being delivered —
    // which is how this shape was discovered rather than assumed.
    const assigned = bus.ofType('issue.assigned')[0]!.data as {
      assignee_id: string;
      previous_assignee_id: string | null;
    };
    expect(assigned.assignee_id).toBe(userId);
    expect(assigned.previous_assignee_id).toBeNull();
  });

  it('PF-293 — a NO-OP patch emits nothing and writes no history', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    // Created through a BUS-LESS service so the assertions below are about the
    // update path alone — `RecordingEventBus` has no reset, and filtering after
    // the fact would hide a create that published the wrong thing.
    const row = await createIssueService().create(ctx(), { title: 'Still', state: 'todo', priority: 'low' });

    // Every value re-asserted at what it already is. An unguarded implementation
    // would write the row, log a history entry and emit an event, and a
    // subscriber would see N status changes for a status that never changed.
    const result = await service.update(ctx(), {
      id: row.id,
      patch: { state: 'todo', priority: 'low', title: 'Still' },
    });

    expect(result?.changes).toEqual([]);
    expect(bus.ofType('issue.status_changed')).toHaveLength(0);
    expect(bus.ofType('issue.assigned')).toHaveLength(0);

    const history = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM document_history WHERE document_id = $1`,
      [row.id],
    );
    expect(history.rows[0]!.n).toBe(0);
  });

  it('a title-only patch emits no issue event, but does write history', async () => {
    // The negative that proves the events are keyed on the FIELD rather than on
    // "an update happened".
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });

    // Created through a BUS-LESS service so the assertions below are about the
    // update path alone — `RecordingEventBus` has no reset, and filtering after
    // the fact would hide a create that published the wrong thing.
    const row = await createIssueService().create(ctx(), { title: 'Before' });

    await service.update(ctx(), { id: row.id, patch: { title: 'After' } });

    expect(bus.ofType('issue.status_changed')).toHaveLength(0);
    expect(bus.ofType('issue.assigned')).toHaveLength(0);

    const history = await pool.query<{ field: string }>(
      `SELECT field FROM document_history WHERE document_id = $1`,
      [row.id],
    );
    expect(history.rows.map((r) => r.field)).toEqual(['title']);
  });

  it('updating an issue in another workspace returns null and publishes nothing', async () => {
    const bus = new RecordingEventBus();
    const service = createIssueService({ bus });
    // Created through a BUS-LESS service so the assertions below are about the
    // update path alone — `RecordingEventBus` has no reset, and filtering after
    // the fact would hide a create that published the wrong thing.
    const row = await createIssueService().create(ctx(), { title: 'Mine' });

    const other = await pool.query(
      `INSERT INTO workspaces (name) VALUES ('L10 events elsewhere') RETURNING id`,
    );
    try {
      const result = await service.update(
        { workspaceId: other.rows[0].id, userId, db: pool },
        { id: row.id, patch: { state: 'done' } },
      );
      expect(result).toBeNull();
      expect(bus.ofType('issue.status_changed')).toHaveLength(0);
    } finally {
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [other.rows[0].id]);
    }
  });
});
