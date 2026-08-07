/**
 * Escalation: FLEETGRAPH.md's "not acknowledged after 2 business days escalates
 * one level up `reports_to`, at most once" (PRESEARCH.md Q6), asserted.
 *
 * ── Why a real Postgres and not a fake `Queryable` ─────────────────────────
 * The whole "at most once" guarantee lives in one SQL predicate —
 * `WHERE escalation_count = 0` inside the statement that also inserts the
 * notification. A fake db that pattern-matches on query text would assert that
 * the node called something, which is not the claim. The claim is that a second
 * run writes nothing, and only Postgres can say whether that is true.
 *
 * That matters more here than usual because the watermark model GUARANTEES
 * reruns: `deliver` only advances the mark on completion, so any crash means
 * the next scan re-covers the same window (Q24). A non-idempotent escalation
 * would not be an edge case, it would be the normal failure mode.
 *
 * Time is pinned through `deps.now` rather than by dating rows relative to the
 * real clock, so a suite run on a Monday and a suite run on a Saturday measure
 * the same number of business days.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { makeEscalate, ESCALATION_BUSINESS_DAYS } from './escalate.js';
import { acknowledgeNotification, createNotification, recordObservation, resolveObservation } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType } from '../state.js';
import { createUser, createWorkspace, type Workspace } from '../../detectors/fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;

/** Engineer, their manager, the issue, and the finding already on the engineer's desk. */
let engineerId: string;
let managerId: string;
let issueId: string;
let observationId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`
  );
  for (const f of readdirSync(join(API_DB, 'migrations'))
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/**
 * Wednesday. Chosen so that "two days ago" is Monday and no weekend falls
 * inside the window — the business-day rule is exercised by its own test below
 * rather than being an accident of which day the suite runs on.
 */
const NOW = new Date('2026-08-05T09:00:00Z');

/** Notified on this date, `businessDays` business days before NOW. */
async function notifyOn(isoDate: string, recipientUserId: string): Promise<string> {
  const id = await createNotification(
    {
      workspaceId: ws.workspaceId,
      observationId,
      recipientUserId,
      title: 'Issue idle 7 business days',
      body: 'No movement since 2026-07-24.',
      targetId: issueId,
    },
    pool
  );
  // created_at defaults to NOW(); the escalation clock reads it, so it has to
  // be backdated explicitly rather than left to the wall clock.
  await pool.query(`UPDATE fleetgraph_notifications SET created_at = $2 WHERE id = $1`, [
    id,
    isoDate,
  ]);
  return id;
}

/** Point a person document's `reports_to` at someone. */
async function setReportsTo(personUserId: string, managerUserId: string | null): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET properties = CASE
              WHEN $3::text IS NULL THEN properties - 'reports_to'
              ELSE properties || jsonb_build_object('reports_to', $3::text)
            END
      WHERE workspace_id = $1
        AND document_type = 'person'
        AND properties->>'user_id' = $2::text`,
    [ws.workspaceId, personUserId, managerUserId]
  );
}

async function escalationCount(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT escalation_count FROM fleetgraph_observations WHERE id = $1`,
    [observationId]
  );
  return rows[0].escalation_count;
}

async function notificationsFor(userId: string) {
  const { rows } = await pool.query(
    `SELECT title, body FROM fleetgraph_notifications
      WHERE observation_id = $1 AND recipient_user_id = $2
      ORDER BY created_at`,
    [observationId, userId]
  );
  return rows;
}

function deps(): GraphDeps {
  return {
    db: pool,
    judge: async () => [],
    answer: async () => '',
    act: async () => ({ ok: true }),
    now: () => NOW,
  };
}

function state(): GraphStateType {
  return { scope: { workspaceId: ws.workspaceId } } as GraphStateType;
}

beforeEach(async () => {
  ws = await createWorkspace(pool, `escalate-${Date.now()}-${Math.round(performance.now())}`);
  engineerId = await createUser(pool, `eng-${ws.workspaceId.slice(0, 8)}@test.local`, 'Dana Reed');
  managerId = await createUser(pool, `mgr-${ws.workspaceId.slice(0, 8)}@test.local`, 'Sam Okoro');

  const issue = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, created_by, properties)
     VALUES ($1, 'issue', 'Migrate the billing job', $2, jsonb_build_object('state','in_progress'))
     RETURNING id`,
    [ws.workspaceId, ws.ownerId]
  );
  issueId = issue.rows[0].id;

  // Person documents are how roles are derived (Q5) — `reports_to` hangs off
  // the person doc, not the user row.
  for (const [userId, title] of [
    [engineerId, 'Dana Reed'],
    [managerId, 'Sam Okoro'],
  ] as const) {
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, properties)
       VALUES ($1, 'person', $2, $3, jsonb_build_object('user_id', $4::text))`,
      [ws.workspaceId, title, ws.ownerId, userId]
    );
  }
  await setReportsTo(engineerId, managerId);

  const obs = await recordObservation(
    {
      workspaceId: ws.workspaceId,
      fingerprint: `stalled:${issueId}:5-9d`,
      signalType: 'stalled_work',
      targetId: issueId,
      targetType: 'issue',
    },
    pool
  );
  observationId = obs.id;
});

describe('escalation', () => {
  it('escalates a finding unanswered for 2 business days, one hop up reports_to', async () => {
    // Monday to Wednesday: 2 business days, no weekend involved.
    await notifyOn('2026-08-03T09:00:00Z', engineerId);

    const out = await makeEscalate(deps())(state());

    expect(out.escalated).toHaveLength(1);
    expect(out.escalated![0]).toMatchObject({
      observationId,
      fromUserId: engineerId,
      toUserId: managerId,
      silentBusinessDays: ESCALATION_BUSINESS_DAYS,
    });

    // The hop resolved through the person document, not through anything the
    // model chose — this is the assertion that the org chart was actually read.
    const managerNotifications = await notificationsFor(managerId);
    expect(managerNotifications).toHaveLength(1);
    expect(managerNotifications[0].title).toBe('Escalated: Issue idle 7 business days');
    // Names who did not answer and for how long. Same finding, different desk.
    expect(managerNotifications[0].body).toContain('Dana Reed');
    expect(managerNotifications[0].body).toContain('2 business days');
    expect(managerNotifications[0].body).toContain('No movement since 2026-07-24.');

    expect(await escalationCount()).toBe(1);
  });

  it('AT MOST ONCE: a second run over the same window escalates nothing', async () => {
    await notifyOn('2026-08-03T09:00:00Z', engineerId);

    const escalate = makeEscalate(deps());
    await escalate(state());
    // The watermark only advances on completion, so re-covering a window is the
    // designed behaviour after any crash (Q24). It must be a no-op here.
    const second = await escalate(state());

    expect(second.escalated).toHaveLength(0);
    expect(await escalationCount()).toBe(1);
    expect(await notificationsFor(managerId)).toHaveLength(1);
  });

  it('does not escalate before 2 business days have passed', async () => {
    // Tuesday to Wednesday: one business day.
    await notifyOn('2026-08-04T09:00:00Z', engineerId);

    const out = await makeEscalate(deps())(state());

    expect(out.escalated).toHaveLength(0);
    expect(await escalationCount()).toBe(0);
    expect(await notificationsFor(managerId)).toHaveLength(0);
  });

  it('BUSINESS DAYS, NOT CALENDAR DAYS: a weekend does not start the clock', async () => {
    // Friday 2026-07-31 to Wednesday 2026-08-05 is 5 calendar days but only 3
    // business days; Monday 2026-08-03 to Wednesday is 2. So a notification
    // sent LATE ON FRIDAY is past the threshold on Wednesday and a Tuesday one
    // is not — the pair below is what a calendar-day implementation gets wrong.
    const tuesday = await notifyOn('2026-08-04T09:00:00Z', engineerId);
    expect((await makeEscalate(deps())(state())).escalated).toHaveLength(0);

    await pool.query(`UPDATE fleetgraph_notifications SET created_at = $2 WHERE id = $1`, [
      tuesday,
      '2026-08-01T09:00:00Z', // Saturday — the weekend contributes zero
    ]);
    // Saturday to Wednesday: Mon, Tue, Wed = 3 business days.
    const out = await makeEscalate(deps())(state());
    expect(out.escalated).toHaveLength(1);
    expect(out.escalated![0].silentBusinessDays).toBe(3);
  });

  it('TOP OF THE CHAIN: a null reports_to records the attempt and writes nothing', async () => {
    // The engineer is now the root of the org chart, like `dev@ship.local` in
    // seed.ts. There is no hop to make.
    await setReportsTo(engineerId, null);
    await notifyOn('2026-08-03T09:00:00Z', engineerId);

    const out = await makeEscalate(deps())(state());

    // Recorded as due-but-unescalatable rather than silently skipped, so the
    // trace distinguishes it from the node never having looked.
    expect(out.escalated).toHaveLength(1);
    expect(out.escalated![0].toUserId).toBeNull();
    expect(out.escalated![0].fromUserId).toBe(engineerId);

    // Nothing written: no notification, and the counter stays at 0 so the
    // finding escalates properly if an admin sets `reports_to` later.
    expect(await escalationCount()).toBe(0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM fleetgraph_notifications WHERE observation_id = $1`,
      [observationId]
    );
    expect(rows[0].n).toBe(1); // the original only
  });

  it('a person with no person document is treated as top of the chain', async () => {
    // `reports_to` lives on the person document; without one there is nothing
    // to walk. Same outcome as a null value, and it must not throw.
    await pool.query(
      `DELETE FROM documents
        WHERE workspace_id = $1 AND document_type = 'person' AND properties->>'user_id' = $2::text`,
      [ws.workspaceId, engineerId]
    );
    await notifyOn('2026-08-03T09:00:00Z', engineerId);

    const out = await makeEscalate(deps())(state());

    expect(out.escalated).toHaveLength(1);
    expect(out.escalated![0].toUserId).toBeNull();
    expect(await escalationCount()).toBe(0);
  });

  it('an acknowledged finding does not escalate', async () => {
    // The whole point of the clock: "no response" is the notification still
    // being pending, not merely time having passed.
    const notificationId = await notifyOn('2026-08-03T09:00:00Z', engineerId);
    await acknowledgeNotification(notificationId, pool);

    const out = await makeEscalate(deps())(state());

    expect(out.escalated).toHaveLength(0);
    expect(await escalationCount()).toBe(0);
  });

  it('a dismissed or snoozed finding does not escalate', async () => {
    await notifyOn('2026-08-03T09:00:00Z', engineerId);
    await resolveObservation(observationId, 'dismissed', null, pool);

    const out = await makeEscalate(deps())(state());

    expect(out.escalated).toHaveLength(0);
    expect(await escalationCount()).toBe(0);
  });

  it('degrades rather than failing the run when the escalation query errors', async () => {
    // A scan that cannot read its own state should still measure the project.
    // The alternative is losing the window's detection over the org chart.
    const broken: GraphDeps = {
      ...deps(),
      db: {
        query: async () => {
          throw new Error('connection terminated');
        },
      },
    };

    const out = await makeEscalate(broken)(state());

    expect(out.escalated).toHaveLength(0);
    expect(out.errors?.[0]).toContain('connection terminated');
  });
});
