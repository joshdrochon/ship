/**
 * Detectors 4 and 5.
 *
 * These two carry the design decisions most likely to be quietly undone by a
 * later edit: that a load-imbalance finding goes to the sprint owner and NEVER
 * to the overloaded person, and that a small team is deliberately exempt. Both
 * are asserted rather than left to the comment above them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestPool } from '../testing/pool.js';

import { detectLoadImbalance } from './loadImbalance.js';
import { detectReworkChurn } from './reworkChurn.js';
import { THRESHOLDS } from './types.js';
import {
  createWorkspace,
  createUser,
  createIssue,
  createSprint,
  createProject,
  attachToSprint,
  attachToProject,
  recordStateChange,
  type Workspace,
} from './fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;
let owner: string;

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
  ws = await createWorkspace(pool, `m2b-${Date.now()}-${Math.round(performance.now())}`);
  owner = await createUser(pool, `own-${ws.workspaceId.slice(0, 8)}@t.local`, 'Sprint Owner');
});

/**
 * n people on a sprint, each holding `counts[i]` active issues.
 *
 * Emails are keyed on the sprint, not just the workspace: a test that staffs two
 * sprints would otherwise reuse p0/p1/p2 and hit users_email_key.
 */
async function staffSprint(sprintId: string, counts: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (let p = 0; p < counts.length; p++) {
    const uid = await createUser(pool, `p${p}-${sprintId.slice(0, 8)}@t.local`, `Person ${p}`);
    ids.push(uid);
    for (let n = 0; n < counts[p]!; n++) {
      const i = await createIssue(pool, ws, { state: 'in_progress', assigneeId: uid });
      await attachToSprint(pool, i, sprintId);
    }
  }
  return ids;
}

describe('detectLoadImbalance', () => {
  it('flags someone carrying multiples of the team median', async () => {
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    const [, , heavy] = await staffSprint(sprint, [1, 1, 8]);

    const signals = await detectLoadImbalance(ws.workspaceId, pool);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.targetType).toBe('sprint');
    expect(signals[0]!.measurement).toBe(8);
    expect(signals[0]!.context.team_median).toBe(1);
    expect(signals[0]!.context.overloaded_person).toBe('Person 2');
    expect(heavy).toBeTruthy();
  });

  it('routes to the SPRINT OWNER, never the overloaded person', async () => {
    // The central design point (PRESEARCH.md Q6). Telling someone they are
    // overloaded is useless — they cannot fix their own allocation. If this
    // assertion ever fails, the detector has become an alert to the wrong human.
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    const people = await staffSprint(sprint, [1, 1, 8]);
    const overloaded = people[2]!;

    const [s] = await detectLoadImbalance(ws.workspaceId, pool);

    expect(s!.accountableUserId).toBe(owner);
    expect(s!.accountableUserId).not.toBe(overloaded);
  });

  it('stays silent on a team too small for a median to mean anything', async () => {
    // With two people whoever has more is always above the median, so this would
    // fire on every pair forever. A deliberate blind spot: a two-person
    // imbalance is visible without an agent.
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    await staffSprint(sprint, [1, 9]);
    expect(await detectLoadImbalance(ws.workspaceId, pool)).toHaveLength(0);
    expect(THRESHOLDS.LOAD_IMBALANCE_MIN_TEAM).toBeGreaterThan(2);
  });

  it('is quiet on an evenly loaded team', async () => {
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    await staffSprint(sprint, [3, 3, 3, 3]);
    expect(await detectLoadImbalance(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('compares within a sprint, not across the workspace', async () => {
    // A workspace-wide median would include people on other projects, on leave,
    // and long departed.
    const quiet = await createSprint(pool, ws, { title: 'Quiet', ownerId: owner, endsInDays: 5 });
    await staffSprint(quiet, [1, 1, 1]);
    const busy = await createSprint(pool, ws, { title: 'Busy', ownerId: owner, endsInDays: 5 });
    await staffSprint(busy, [4, 4, 4]);

    // Busy is evenly loaded internally, so nothing fires despite 4 > the
    // workspace-wide median of 1.
    expect(await detectLoadImbalance(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('counts in_review as carried work, not just in_progress', async () => {
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    await staffSprint(sprint, [1, 1, 1]);
    const heavy = await createUser(pool, `h-${ws.workspaceId.slice(0, 8)}@t.local`, 'Heavy');
    for (let n = 0; n < 6; n++) {
      const i = await createIssue(pool, ws, {
        state: n % 2 === 0 ? 'in_progress' : 'in_review',
        assigneeId: heavy,
      });
      await attachToSprint(pool, i, sprint);
    }
    const [s] = await detectLoadImbalance(ws.workspaceId, pool);
    expect(s!.measurement).toBe(6);
  });

  it('gives two simultaneously overloaded people distinct fingerprints', async () => {
    // Same sprint, same bucket. Without the assignee in the key they would
    // suppress each other and only one would ever be surfaced.
    const sprint = await createSprint(pool, ws, { ownerId: owner, endsInDays: 5 });
    await staffSprint(sprint, [1, 1, 1, 8, 8]);
    const signals = await detectLoadImbalance(ws.workspaceId, pool);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.fingerprint).not.toBe(signals[1]!.fingerprint);
  });
});

describe('detectReworkChurn', () => {
  it('flags a project where several issues came back from done', async () => {
    const project = await createProject(pool, ws, { title: 'Platform', ownerId: owner });
    for (const t of ['Fix login', 'Fix export', 'Fix sync']) {
      const i = await createIssue(pool, ws, { title: t, state: 'in_progress' });
      await attachToProject(pool, i, project);
      await recordStateChange(pool, i, 'done', 'in_progress', ws.ownerId, 3);
    }

    const signals = await detectReworkChurn(ws.workspaceId, pool);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.targetType).toBe('project');
    expect(signals[0]!.measurement).toBe(3);
    expect(signals[0]!.accountableUserId).toBe(owner);
  });

  it('aggregates to ONE signal per project, not one per issue', async () => {
    // A single reopened issue is noise. A project where several bounce back is a
    // definition-of-done problem — a Director conversation, not a per-issue nudge.
    const project = await createProject(pool, ws, { ownerId: owner });
    for (let n = 0; n < 6; n++) {
      const i = await createIssue(pool, ws, { title: `Issue ${n}` });
      await attachToProject(pool, i, project);
      await recordStateChange(pool, i, 'done', 'in_progress', ws.ownerId, 2);
    }
    const signals = await detectReworkChurn(ws.workspaceId, pool);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.measurement).toBe(6);
  });

  it('stays quiet below the threshold', async () => {
    const project = await createProject(pool, ws, { ownerId: owner });
    const i = await createIssue(pool, ws);
    await attachToProject(pool, i, project);
    await recordStateChange(pool, i, 'done', 'in_progress', ws.ownerId, 2);
    expect(await detectReworkChurn(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('also catches reopened_at, for write paths that skip history', async () => {
    // The second, independent source. document_history has known coverage holes;
    // reopened_at is a column written by getTimestampUpdates() on the
    // done -> in_progress transition and survives paths that skip history.
    const project = await createProject(pool, ws, { ownerId: owner });
    for (let n = 0; n < 2; n++) {
      const i = await createIssue(pool, ws, { reopenedDaysAgo: 4 });
      await attachToProject(pool, i, project);
    }
    const signals = await detectReworkChurn(ws.workspaceId, pool);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.measurement).toBe(2);
  });

  it('does not double-count an issue present in both sources', async () => {
    const project = await createProject(pool, ws, { ownerId: owner });
    const a = await createIssue(pool, ws, { title: 'Both', reopenedDaysAgo: 3 });
    await attachToProject(pool, a, project);
    await recordStateChange(pool, a, 'done', 'in_progress', ws.ownerId, 3);
    const b = await createIssue(pool, ws, { title: 'History only' });
    await attachToProject(pool, b, project);
    await recordStateChange(pool, b, 'done', 'in_progress', ws.ownerId, 3);

    const signals = await detectReworkChurn(ws.workspaceId, pool);
    expect(signals[0]!.measurement).toBe(2);
  });

  it('ignores churn outside the lookback window', async () => {
    const project = await createProject(pool, ws, { ownerId: owner });
    for (let n = 0; n < 4; n++) {
      const i = await createIssue(pool, ws);
      await attachToProject(pool, i, project);
      await recordStateChange(pool, i, 'done', 'in_progress', ws.ownerId, 120);
    }
    expect(await detectReworkChurn(ws.workspaceId, pool)).toHaveLength(0);
  });

  it('ignores forward transitions into done', async () => {
    const project = await createProject(pool, ws, { ownerId: owner });
    for (let n = 0; n < 4; n++) {
      const i = await createIssue(pool, ws, { state: 'done' });
      await attachToProject(pool, i, project);
      await recordStateChange(pool, i, 'in_progress', 'done', ws.ownerId, 2);
    }
    expect(await detectReworkChurn(ws.workspaceId, pool)).toHaveLength(0);
  });
});
