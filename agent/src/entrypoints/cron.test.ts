/**
 * The proactive loop, end to end, against a real database.
 *
 * Three claims, and the third is the one that would be easy to believe without
 * checking:
 *
 *   FG-119  a mutated issue is detected by a scan
 *   FG-120  a second immediate scan detects NOTHING — suppression works
 *   FG-121  a run that fails does NOT advance the watermark
 *
 * FG-120 is what separates an agent from a cron job that shouts. FG-121 is what
 * makes the whole design crash-safe with no retry logic: if the watermark moved
 * on a failed run, the window it covered would never be looked at again, and
 * the loss would be silent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { scanWorkspace, listWorkspaces } from './cron.js';
import { closePool } from '../data/pool.js';
import { resetCheckpointer } from '../graph/checkpointer.js';
import { makeJudge, resetLlmBreaker } from '../llm/index.js';
import type { JudgeFn, AnswerFn, ActFn } from '../graph/deps.js';
import { createWorkspace, createUser, createIssue, type Workspace } from '../detectors/fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  const uri = container.getConnectionUri();

  // The cron reads DATABASE_URL through getPool(), same as it will in the
  // container. Pointing it at the test database rather than injecting a pool
  // means the entrypoint's own wiring is under test, not bypassed.
  process.env.DATABASE_URL = uri;

  pool = new Pool({ connectionString: uri });
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
  // Order matters, and getting it wrong produced a green suite that exited 1.
  //
  // `scanWorkspace` calls `getCheckpointer()`, which opens a SECOND pool —
  // PostgresSaver's own, separate from `data/pool.ts`. Stopping the container
  // while it still held connections raised eight unhandled `57P01` errors
  // AFTER the suite reported 146/146 passing, and vitest counts unhandled
  // errors as failures. CI would have read red on a run where every assertion
  // held, which is the kind of red people learn to ignore.
  //
  // Every connection closes before the server goes away.
  await resetCheckpointer();
  await closePool();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  ws = await createWorkspace(pool, `cron-${Date.now()}-${Math.round(performance.now())}`);
});

const judge: JudgeFn = async ({ signals }) =>
  signals.map((s) => ({
    fingerprint: s.fingerprint,
    severity: 'medium' as const,
    recipientUserId: s.accountableUserId,
    worthSurfacing: true,
    phrasing: `${s.type}`,
  }));

const answer: AnswerFn = async () => 'unused';
const act: ActFn = async () => ({ ok: true });

async function watermarkOf(workspaceId: string) {
  const { rows } = await pool.query(
    `SELECT last_scanned_at, last_run_completed_at FROM fleetgraph_watermarks WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

describe('the proactive cron', () => {
  it('FG-119 — detects an issue that has gone idle', async () => {
    const u = await createUser(pool, `cr-${ws.workspaceId.slice(0, 8)}@t.local`, 'Cron');
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20, assigneeId: u });

    const result = await scanWorkspace(ws.workspaceId, { judge, answer, act });

    expect(result.signals).toBeGreaterThan(0);
    expect(result.outcome).toBe('delivered');
    expect(await watermarkOf(ws.workspaceId)).toBeTruthy();
  }, 60_000);

  it('FG-120 — a second immediate scan finds nothing new', async () => {
    // The claim the agent's usefulness rests on. Without suppression this is a
    // cron job that says the same thing 480 times a day, and the first thing a
    // human does about that is mute it.
    const u = await createUser(pool, `cr2-${ws.workspaceId.slice(0, 8)}@t.local`, 'Cron2');
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20, assigneeId: u });

    const first = await scanWorkspace(ws.workspaceId, { judge, answer, act });
    expect(first.signals).toBeGreaterThan(0);

    const second = await scanWorkspace(ws.workspaceId, { judge, answer, act });
    expect(second.signals, 'the same finding must not surface twice').toBe(0);
    expect(second.outcome).toBe('quiet_all_suppressed');
  }, 60_000);

  it('FG-121 — a failed run does NOT advance the watermark', async () => {
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });

    const exploding: JudgeFn = async () => {
      throw new Error('simulated provider outage');
    };

    const result = await scanWorkspace(ws.workspaceId, { judge: exploding, answer, act });

    expect(result.outcome).toBe('ai_unavailable');
    expect(
      await watermarkOf(ws.workspaceId),
      'a window whose signals were never judged must be re-covered next run'
    ).toBeNull();

    // And the proof it is genuinely recoverable rather than merely unrecorded:
    // the next run with a working model finds the same signal.
    const recovered = await scanWorkspace(ws.workspaceId, { judge, answer, act });
    expect(recovered.signals).toBeGreaterThan(0);
    expect(await watermarkOf(ws.workspaceId)).toBeTruthy();
  }, 60_000);

  it('FG-121 holds for the REAL judge, not just a throwing fake', async () => {
    // The original FG-121 passed against a fake judge that throws. The real
    // one did not throw — `makeJudge` flattened every status to
    // `result.findings`, so an unreachable provider arrived at the graph as an
    // empty array, read as "nothing worth surfacing", routed to close_quiet,
    // and ADVANCED THE WATERMARK. A window whose signals were never judged was
    // closed and never looked at again.
    //
    // `closeQuiet` already refused to advance on `ai_unavailable`. It just
    // never saw that outcome, because the status was discarded a layer below.
    //
    // So this drives the real judgeSignals and the real makeJudge, faking only
    // the transport. Without the fix it reports `quiet_nothing_survived_judgment`
    // and writes a watermark.
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });
    resetLlmBreaker();

    const realJudge = makeJudge({
      model: {
        invoke: async () => {
          throw new Error('simulated provider outage');
        },
      },
    });

    const result = await scanWorkspace(ws.workspaceId, {
      judge: realJudge as never,
      answer,
      act,
    });

    expect(result.outcome, 'must not report a quiet workspace').toBe('ai_unavailable');
    expect(
      await watermarkOf(ws.workspaceId),
      'an unjudged window must stay open for the next run'
    ).toBeNull();
  }, 60_000);

  it('a quiet workspace still closes its scan window', async () => {
    await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 0 });

    const result = await scanWorkspace(ws.workspaceId, { judge, answer, act });

    expect(result.outcome).toBe('quiet_no_signals');
    expect(
      await watermarkOf(ws.workspaceId),
      'healthy is not the same as failed — the window is closed'
    ).toBeTruthy();
  }, 60_000);

  it('lists only workspaces that are not archived', async () => {
    const archived = await createWorkspace(pool, `arch-${Math.round(performance.now())}`);
    await pool.query(`UPDATE workspaces SET archived_at = NOW() WHERE id = $1`, [
      archived.workspaceId,
    ]);

    const ids = await listWorkspaces();
    expect(ids).toContain(ws.workspaceId);
    expect(ids).not.toContain(archived.workspaceId);
  }, 60_000);
});
