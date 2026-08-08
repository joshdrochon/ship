/**
 * Detector 1 — stalled work.
 *
 * Against a real Postgres with the real schema, because the thing most likely to
 * break here is the SQL: `state` lives inside a JSONB column, soft-deletes are
 * two separate nullable columns, and the business-day rule is applied in JS after
 * a calendar-day SQL filter. A mocked query would test none of that.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestPool } from '../testing/pool.js';

import { detectStalledWork } from './stalledWork.js';
import { THRESHOLDS } from './types.js';
import { createWorkspace, createIssue, createUser, type Workspace } from './fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;
let assignee: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = createTestPool(container.getConnectionUri());

  await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`
  );
  for (const f of readdirSync(join(API_DB, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // A fresh workspace per test. Cheaper and less brittle than truncating, and it
  // also proves the detector scopes by workspace_id rather than scanning
  // everything — earlier tests' rows stay in the table.
  ws = await createWorkspace(pool, `stalled-${Date.now()}-${Math.round(performance.now())}`);
  assignee = await createUser(pool, `a-${ws.workspaceId.slice(0, 8)}@test.local`, 'Assignee');
});

describe('detectStalledWork', () => {
  it('finds an in_progress issue untouched past the threshold', async () => {
    const id = await createIssue(pool, ws, {
      title: 'Migrate the auth adapter',
      state: 'in_progress',
      assigneeId: assignee,
      updatedDaysAgo: 21,
      startedDaysAgo: 30,
    });

    const signals = await detectStalledWork(ws.workspaceId, pool);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.targetId).toBe(id);
    expect(signals[0]!.type).toBe('stalled_work');
    expect(signals[0]!.targetTitle).toBe('Migrate the auth adapter');
    expect(signals[0]!.measurement).toBeGreaterThanOrEqual(THRESHOLDS.STALLED_WORK_DAYS);
    expect(signals[0]!.threshold).toBe(THRESHOLDS.STALLED_WORK_DAYS);
    expect(signals[0]!.accountableUserId).toBe(assignee);
  });

  it('is quiet for an issue touched today', async () => {
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 0 });
    expect(await detectStalledWork(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('is quiet just under the threshold', async () => {
    // 3 calendar days is at most 3 business days — under 5 however the weekend falls.
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 3 });
    expect(await detectStalledWork(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('ignores states that are not in_progress', async () => {
    // The signal is "claims to be active but is not". A backlog issue sitting
    // untouched for a month is not stalled, it is a backlog issue.
    for (const state of ['todo', 'backlog', 'in_review', 'done', 'cancelled'] as const) {
      await createIssue(pool, ws, { state, updatedDaysAgo: 40 });
    }
    expect(await detectStalledWork(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('ignores archived and soft-deleted issues', async () => {
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 40, archived: true });
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 40, deleted: true });
    expect(await detectStalledWork(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('scopes to its own workspace', async () => {
    const other = await createWorkspace(pool, `other-${Date.now()}`);
    await createIssue(pool, other, { state: 'in_progress', updatedDaysAgo: 40 });
    expect(await detectStalledWork(ws.workspaceId, pool)).toHaveLength(0);
    expect(await detectStalledWork(other.workspaceId, pool)).toHaveLength(1);
  });

  it('carries an unassigned issue with a null accountable user rather than dropping it', async () => {
    // Routing decides what to do with this (PRESEARCH.md Q6 falls back to the
    // sprint owner). Dropping it here would make an unassigned stalled issue
    // invisible, which is the worst kind to lose.
    await createIssue(pool, ws, { state: 'in_progress', assigneeId: null, updatedDaysAgo: 30 });
    const signals = await detectStalledWork(ws.workspaceId, pool);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.accountableUserId).toBeNull();
  });

  it('gives the same fingerprint on a re-run, and a different one once it worsens', async () => {
    // Stability is what makes suppression work at all; the bucket change is what
    // lets a materially worse situation be surfaced again (PRESEARCH.md Q20/Q32).
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 8 });
    const a = await detectStalledWork(ws.workspaceId, pool);
    const b = await detectStalledWork(ws.workspaceId, pool);
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);

    const worse = await detectStalledWork(
      ws.workspaceId,
      pool,
      new Date(Date.now() + 30 * 86_400_000)
    );
    expect(worse[0]!.fingerprint).not.toBe(a[0]!.fingerprint);
  });

  it('reports measurements the judgment prompt can use without re-querying', async () => {
    await createIssue(pool, ws, {
      state: 'in_progress',
      assigneeId: assignee,
      updatedDaysAgo: 14,
      startedDaysAgo: 25,
      priority: 'high',
    });
    const [s] = await detectStalledWork(ws.workspaceId, pool);
    expect(s!.context.priority).toBe('high');
    expect(s!.context.idle_business_days).toBe(s!.measurement);
    expect(s!.context.last_touched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s!.context.started_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
