/**
 * Boundary tests against a real Postgres, provisioned by testcontainers.
 *
 * Real database rather than a mock, because two of these assertions are about
 * things only Postgres can tell you: that the unique index actually rejects a
 * duplicate fingerprint, and that ON CONFLICT reports insert-versus-update
 * correctly. A mock would let both regress silently.
 *
 * testcontainers rather than the dev database, because engineering requirement 3
 * says the suite must be independently reproducible in CI regardless of network
 * or local state — and because `pnpm test` truncates the dev database, which
 * would destroy whatever was being worked on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestPool } from '../testing/pool.js';

import {
  getWatermark,
  setWatermark,
  loadSuppressionSet,
  recordObservation,
  resolveObservation,
  createNotification,
  listOpenNotifications,
  acknowledgeNotification,
} from './boundary.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let workspaceId: string;
let userId: string;
let documentId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = createTestPool(container.getConnectionUri());

  // Exactly migrate.ts's order: schema.sql, then the tracking table, then every
  // migration in sorted order. The tracking table is not incidental — 024
  // rewrites rows in it, and skipping it fails with "relation
  // schema_migrations does not exist".
  await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  const migrations = readdirSync(join(API_DB, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of migrations) {
    await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f.replace('.sql', '')]);
  }

  const ws = await pool.query(
    `INSERT INTO workspaces (name) VALUES ('Boundary Test') RETURNING id`
  );
  workspaceId = ws.rows[0].id;

  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('b@test.local', 'B') RETURNING id`
  );
  userId = u.rows[0].id;

  const d = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, created_by)
     VALUES ($1, 'issue', 'Stalled issue', $2) RETURNING id`,
    [workspaceId, userId]
  );
  documentId = d.rows[0].id;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('watermark', () => {
  it('reports null before the first scan, so callers can bound by lookback', async () => {
    const wm = await getWatermark(workspaceId, pool);
    expect(wm.lastScannedAt).toBeNull();
    expect(wm.lastRunCompletedAt).toBeNull();
  });

  it('round-trips and then overwrites on the next completed run', async () => {
    const first = new Date('2026-08-01T10:00:00Z');
    await setWatermark(workspaceId, first, 3, pool);
    expect((await getWatermark(workspaceId, pool)).lastScannedAt).toEqual(first);

    const second = new Date('2026-08-02T10:00:00Z');
    await setWatermark(workspaceId, second, 0, pool);
    expect((await getWatermark(workspaceId, pool)).lastScannedAt).toEqual(second);
  });
});

describe('observations', () => {
  it('records a finding once and reports it as new', async () => {
    const r = await recordObservation(
      {
        workspaceId,
        fingerprint: 'stalled:doc-a:5d',
        signalType: 'stalled_work',
        targetId: documentId,
        targetType: 'issue',
      },
      pool
    );
    expect(r.isNew).toBe(true);
  });

  it('SUPPRESSION: the same fingerprint upserts rather than duplicating', async () => {
    // The cost cliff from PRESEARCH.md Q32. Without the unique index this
    // inserts a second row, the finding is re-judged every run, and one finding
    // becomes 480 model calls a day with a cost graph as the only symptom.
    const again = await recordObservation(
      {
        workspaceId,
        fingerprint: 'stalled:doc-a:5d',
        signalType: 'stalled_work',
        targetId: documentId,
        targetType: 'issue',
      },
      pool
    );
    expect(again.isNew).toBe(false);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM fleetgraph_observations
        WHERE workspace_id = $1 AND fingerprint = 'stalled:doc-a:5d'`,
      [workspaceId]
    );
    expect(rows[0].n).toBe(1);
  });

  it('the unique constraint exists and rejects a raw duplicate insert', async () => {
    // Asserted at the database level too: the upsert above would still pass if
    // someone dropped the index, because ON CONFLICT would simply never fire.
    await expect(
      pool.query(
        `INSERT INTO fleetgraph_observations
           (workspace_id, fingerprint, signal_type, target_id, target_type)
         VALUES ($1, 'stalled:doc-a:5d', 'stalled_work', $2, 'issue')`,
        [workspaceId, documentId]
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('a different threshold bucket is a different finding', async () => {
    const r = await recordObservation(
      {
        workspaceId,
        fingerprint: 'stalled:doc-a:20d',
        signalType: 'stalled_work',
        targetId: documentId,
        targetType: 'issue',
      },
      pool
    );
    expect(r.isNew).toBe(true);
  });

  it('open and dismissed findings suppress; resolved ones do not', async () => {
    const open = await recordObservation(
      { workspaceId, fingerprint: 'fp:open', signalType: 'stalled_work', targetId: documentId, targetType: 'issue' },
      pool
    );
    const dismissed = await recordObservation(
      { workspaceId, fingerprint: 'fp:dismissed', signalType: 'stalled_work', targetId: documentId, targetType: 'issue' },
      pool
    );
    const resolved = await recordObservation(
      { workspaceId, fingerprint: 'fp:resolved', signalType: 'stalled_work', targetId: documentId, targetType: 'issue' },
      pool
    );

    await resolveObservation(dismissed.id, 'dismissed', null, pool);
    await resolveObservation(resolved.id, 'resolved', null, pool);

    const set = await loadSuppressionSet(workspaceId, pool);
    expect(set.has('fp:open')).toBe(true);
    // Permanent — a dismissed finding coming back is what gets an agent disabled.
    expect(set.has('fp:dismissed')).toBe(true);
    // Resolved means the underlying condition went away; it may legitimately recur.
    expect(set.has('fp:resolved')).toBe(false);
    expect(open.isNew).toBe(true);
  });

  it('a snooze suppresses until its horizon and not after', async () => {
    const future = await recordObservation(
      { workspaceId, fingerprint: 'fp:snoozed-future', signalType: 'review_bottleneck', targetId: documentId, targetType: 'issue' },
      pool
    );
    const past = await recordObservation(
      { workspaceId, fingerprint: 'fp:snoozed-past', signalType: 'review_bottleneck', targetId: documentId, targetType: 'issue' },
      pool
    );

    await resolveObservation(future.id, 'snoozed', new Date(Date.now() + 86_400_000), pool);
    await resolveObservation(past.id, 'snoozed', new Date(Date.now() - 86_400_000), pool);

    const set = await loadSuppressionSet(workspaceId, pool);
    expect(set.has('fp:snoozed-future')).toBe(true);
    expect(set.has('fp:snoozed-past')).toBe(false);
  });

  it('the suppression set carries the target title from the join', async () => {
    const set = await loadSuppressionSet(workspaceId, pool);
    expect(set.get('fp:open')?.targetTitle).toBe('Stalled issue');
  });
});

describe('notifications', () => {
  it('creates, lists with the joined document, and acknowledges', async () => {
    const obs = await recordObservation(
      { workspaceId, fingerprint: 'fp:notify', signalType: 'sprint_miss_risk', targetId: documentId, targetType: 'issue' },
      pool
    );
    const id = await createNotification(
      {
        workspaceId,
        observationId: obs.id,
        recipientUserId: userId,
        title: 'Issue idle 7 business days',
        body: 'No movement since 2026-07-25.',
        targetId: documentId,
      },
      pool
    );

    const open = await listOpenNotifications(userId, workspaceId, pool);
    const mine = open.find((n) => n.id === id);
    expect(mine?.title).toBe('Issue idle 7 business days');
    expect(mine?.targetTitle).toBe('Stalled issue');
    expect(mine?.targetType).toBe('issue');

    await acknowledgeNotification(id, pool);
    expect((await listOpenNotifications(userId, workspaceId, pool)).some((n) => n.id === id)).toBe(false);
  });

  it('acknowledging twice is harmless', async () => {
    const obs = await recordObservation(
      { workspaceId, fingerprint: 'fp:ack-twice', signalType: 'rework_churn', targetId: documentId, targetType: 'issue' },
      pool
    );
    const id = await createNotification(
      { workspaceId, observationId: obs.id, recipientUserId: userId, title: 'Churn' },
      pool
    );
    await acknowledgeNotification(id, pool);
    await expect(acknowledgeNotification(id, pool)).resolves.toBeUndefined();
  });
});
