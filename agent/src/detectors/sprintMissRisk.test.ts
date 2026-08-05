/**
 * Detectors 2 and 3, against a real Postgres.
 *
 * Detector 2's association join is the part most likely to be silently wrong:
 * `sprint_id` was dropped by migration 027, so a query reading it would compile,
 * run, and report every sprint as clean forever. That failure mode — a detector
 * that is quiet because it is broken — is indistinguishable from a healthy
 * project, which is why these tests assert positives rather than only negatives.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { detectSprintMissRisk } from './sprintMissRisk.js';
import { detectReviewBottleneck } from './reviewBottleneck.js';
import { THRESHOLDS } from './types.js';
import {
  createWorkspace,
  createUser,
  createIssue,
  createSprint,
  attachToSprint,
  type Workspace,
} from './fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;
let owner: string;
let dev: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
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
  ws = await createWorkspace(pool, `m2-${Date.now()}-${Math.round(performance.now())}`);
  owner = await createUser(pool, `own-${ws.workspaceId.slice(0, 8)}@t.local`, 'Owner');
  dev = await createUser(pool, `dev-${ws.workspaceId.slice(0, 8)}@t.local`, 'Dev');
});

describe('detectSprintMissRisk', () => {
  it('flags a sprint ending soon with unstarted work', async () => {
    const sprint = await createSprint(pool, ws, { title: 'Week 32', endsInDays: 1, ownerId: owner });
    for (const state of ['todo', 'todo', 'backlog'] as const) {
      const i = await createIssue(pool, ws, { state });
      await attachToSprint(pool, i, sprint);
    }
    const done = await createIssue(pool, ws, { state: 'done' });
    await attachToSprint(pool, done, sprint);

    const signals = await detectSprintMissRisk(ws.workspaceId, pool);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.targetId).toBe(sprint);
    expect(signals[0]!.targetType).toBe('sprint');
    expect(signals[0]!.measurement).toBe(3);
    expect(signals[0]!.context.total_issues).toBe(4);
    // The sprint owner, not any assignee — the issues here have none, which is
    // frequently the point (PRESEARCH.md Q6).
    expect(signals[0]!.accountableUserId).toBe(owner);
  });

  it('emits ONE signal per sprint, not one per unstarted issue', async () => {
    // Nine unstarted issues is one decision for one person, not nine notifications.
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    for (let n = 0; n < 9; n++) {
      const i = await createIssue(pool, ws, { state: 'todo' });
      await attachToSprint(pool, i, sprint);
    }
    const signals = await detectSprintMissRisk(ws.workspaceId, pool);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.measurement).toBe(9);
  });

  it('is quiet when everything has been started', async () => {
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    for (const state of ['in_progress', 'in_review', 'done'] as const) {
      const i = await createIssue(pool, ws, { state });
      await attachToSprint(pool, i, sprint);
    }
    expect(await detectSprintMissRisk(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('is quiet for a sprint that ends far away', async () => {
    const sprint = await createSprint(pool, ws, { endsInDays: 10, ownerId: owner });
    const i = await createIssue(pool, ws, { state: 'todo' });
    await attachToSprint(pool, i, sprint);
    expect(await detectSprintMissRisk(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('is quiet for an empty sprint', async () => {
    await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    expect(await detectSprintMissRisk(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('ignores archived and deleted issues when counting', async () => {
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    const live = await createIssue(pool, ws, { state: 'todo' });
    const gone = await createIssue(pool, ws, { state: 'todo', archived: true });
    const dead = await createIssue(pool, ws, { state: 'todo', deleted: true });
    for (const i of [live, gone, dead]) await attachToSprint(pool, i, sprint);

    const signals = await detectSprintMissRisk(ws.workspaceId, pool);
    expect(signals[0]!.measurement).toBe(1);
  });

  it('does not count issues that are not attached to the sprint', async () => {
    // The association join is the thing most likely to be silently wrong.
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    const attached = await createIssue(pool, ws, { state: 'todo' });
    await attachToSprint(pool, attached, sprint);
    await createIssue(pool, ws, { state: 'todo' }); // loose in the workspace

    const signals = await detectSprintMissRisk(ws.workspaceId, pool);
    expect(signals[0]!.measurement).toBe(1);
  });

  it('carries a null owner rather than dropping the sprint', async () => {
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: null });
    const i = await createIssue(pool, ws, { state: 'todo' });
    await attachToSprint(pool, i, sprint);
    const signals = await detectSprintMissRisk(ws.workspaceId, pool);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.accountableUserId).toBeNull();
  });
});

describe('detectReviewBottleneck', () => {
  it('flags an issue sitting in review past the threshold', async () => {
    const id = await createIssue(pool, ws, {
      title: 'Add the retry wrapper',
      state: 'in_review',
      assigneeId: dev,
      updatedDaysAgo: 9,
    });

    const signals = await detectReviewBottleneck(ws.workspaceId, pool);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.targetId).toBe(id);
    expect(signals[0]!.measurement).toBeGreaterThanOrEqual(THRESHOLDS.REVIEW_BOTTLENECK_DAYS);
    expect(signals[0]!.accountableUserId).toBe(dev);
  });

  it('states that the reviewer is unknown, so the prompt cannot imply blame', async () => {
    // Ship has no reviewer field. The assignee is told their work is stuck; they
    // are not the blocker, and the signal says so rather than leaving the model
    // to guess.
    await createIssue(pool, ws, { state: 'in_review', assigneeId: dev, updatedDaysAgo: 9 });
    const [s] = await detectReviewBottleneck(ws.workspaceId, pool);
    expect(s!.context.reviewer_known).toBe(0);
  });

  it('is quiet for a review touched today', async () => {
    await createIssue(pool, ws, { state: 'in_review', updatedDaysAgo: 0 });
    expect(await detectReviewBottleneck(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('does not fire on in_progress — that is detector 1', async () => {
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 30 });
    expect(await detectReviewBottleneck(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('uses a lower threshold than stalled work', async () => {
    // A review is a handoff: someone is waiting. Two days of silence there means
    // something different from two days on work in progress.
    expect(THRESHOLDS.REVIEW_BOTTLENECK_DAYS).toBeLessThan(THRESHOLDS.STALLED_WORK_DAYS);
  });

  it('scopes to its own workspace', async () => {
    const other = await createWorkspace(pool, `other-${Date.now()}`);
    await createIssue(pool, other, { state: 'in_review', updatedDaysAgo: 9 });
    expect(await detectReviewBottleneck(ws.workspaceId, pool)).toHaveLength(0);
  });
});
