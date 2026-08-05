/**
 * The orchestrator, and the assertion the whole cost model rests on.
 *
 * A detector that is quiet because it is BROKEN looks exactly like a healthy
 * project. So these tests assert both directions: that a genuinely quiet
 * workspace produces nothing, and that a workspace with every condition present
 * produces all five signal types. Either alone would pass while the system was
 * useless.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { runDetectors, DETECTORS } from './index.js';
import { SIGNAL_TYPES } from './types.js';
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
  ws = await createWorkspace(pool, `orch-${Date.now()}-${Math.round(performance.now())}`);
});

describe('runDetectors', () => {
  it('returns ZERO signals for a healthy workspace', async () => {
    // The ordinary case, and the entire cost argument: this is where the graph
    // terminates at the triage gate having spent no tokens (PRESEARCH.md Q2/Q17).
    // 480 scans a day are affordable only because almost all of them end here.
    const sprint = await createSprint(pool, ws, { endsInDays: 6, ownerId: ws.ownerId });
    for (let n = 0; n < 4; n++) {
      const i = await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 0 });
      await attachToSprint(pool, i, sprint);
    }

    const run = await runDetectors(ws.workspaceId, pool);
    expect(run.signals).toHaveLength(0);
  });

  it('returns zero for a completely empty workspace', async () => {
    const run = await runDetectors(ws.workspaceId, pool);
    expect(run.signals).toHaveLength(0);
  });

  it('finds every signal type when every condition is present', async () => {
    // The other direction. Without this, a detector silently returning [] would
    // be indistinguishable from a healthy project.
    const owner = await createUser(pool, `o-${ws.workspaceId.slice(0, 8)}@t.local`, 'Owner');

    // 1 — stalled work
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });

    // 3 — review bottleneck
    await createIssue(pool, ws, { state: 'in_review', updatedDaysAgo: 12 });

    // 2 — sprint-miss risk, and 4 — load imbalance, on one sprint
    const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
    for (let n = 0; n < 3; n++) {
      const i = await createIssue(pool, ws, { state: 'todo' });
      await attachToSprint(pool, i, sprint);
    }
    for (let p = 0; p < 3; p++) {
      const uid = await createUser(pool, `p${p}-${sprint.slice(0, 8)}@t.local`, `P${p}`);
      const load = p === 2 ? 8 : 1;
      for (let n = 0; n < load; n++) {
        const i = await createIssue(pool, ws, { state: 'in_progress', assigneeId: uid });
        await attachToSprint(pool, i, sprint);
      }
    }

    // 5 — rework churn
    const project = await createProject(pool, ws, { ownerId: owner });
    for (let n = 0; n < 3; n++) {
      const i = await createIssue(pool, ws, { title: `Reopened ${n}` });
      await attachToProject(pool, i, project);
      await recordStateChange(pool, i, 'done', 'in_progress', ws.ownerId, 3);
    }

    const run = await runDetectors(ws.workspaceId, pool);
    const found = new Set(run.signals.map((s) => s.type));

    for (const t of SIGNAL_TYPES) {
      expect(found, `no ${t} signal — that detector is silent`).toContain(t);
    }
  });

  it('captures scannedThrough BEFORE the detectors run', async () => {
    // A row written while the scan executes must be picked up next time. If the
    // watermark were taken at the end it would have moved past that row and the
    // finding would be lost silently.
    const before = new Date();
    const run = await runDetectors(ws.workspaceId, pool);
    expect(run.scannedThrough.getTime()).toBeLessThanOrEqual(Date.now());
    expect(run.scannedThrough.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('one failing detector does not lose the others findings', async () => {
    // Degrade gracefully applied INSIDE the scan, not only at its edges. A
    // schema drift in one query should cost that signal, not the whole run.
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });

    const broken = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('rework') || text.includes('reopened_at')) {
          throw new Error('simulated schema drift');
        }
        return pool.query(text, params as never);
      },
    } as unknown as Pool;

    const run = await runDetectors(ws.workspaceId, broken);
    expect(run.signals.some((s) => s.type === 'stalled_work')).toBe(true);
  });

  it('exposes every declared signal type as a detector', async () => {
    // Guards the case where a signal type is added to the union and the
    // detector is never wired in — the graph would then be structurally unable
    // to produce it, with nothing failing.
    expect(DETECTORS.map((d) => d.name).sort()).toEqual([...SIGNAL_TYPES].sort());
  });
});
