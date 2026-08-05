/**
 * What happens after a human answers — the half of the loop that decides
 * whether the agent stays installed.
 *
 *   FG-135  a dismissed fingerprint is suppressed on the next run. Permanently.
 *   FG-136  a snoozed finding that self-resolves never returns
 *
 * Both run the REAL graph against a real Postgres, because both claims are
 * about the interaction of three things that only exist together: what the
 * detectors measure, what `loadSuppressionSet` excludes, and where the triage
 * gate terminates. A unit test of any one of them would pass while the loop was
 * broken.
 *
 * ── The assertion that makes these tests worth having ──────────────────────
 * Each test checks BOTH directions. "The agent said nothing" is the expected
 * outcome of a dismissal and also the expected outcome of a broken detector, a
 * dropped workspace id, or a typo in a fingerprint. So every silent run here is
 * paired with a check that the measurement layer is still finding the thing —
 * suppressed, not absent. Without that pairing these tests would keep passing
 * long after the agent stopped working.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { compileGraph } from '../graph/index.js';
import { addBusinessDays } from '../graph/nodes/executeApproved.js';
import type { GraphDeps, JudgeFn, AnswerFn, ActFn } from '../graph/deps.js';
import { loadSuppressionSet, resolveObservation } from '../data/boundary.js';
import { runDetectors } from '../detectors/index.js';
import { createWorkspace, createUser, createIssue, type Workspace } from '../detectors/fixtures.js';

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

beforeEach(async () => {
  ws = await createWorkspace(pool, `supp-${Date.now()}-${Math.round(performance.now())}`);
});

/** Stable fakes for both external services (requirement 3), each counting. */
function fakes() {
  const calls = { judge: 0, answer: 0, act: 0 };

  const judge: JudgeFn = async ({ signals }) => {
    calls.judge++;
    return signals.map((s) => ({
      fingerprint: s.fingerprint,
      severity: 'medium' as const,
      recipientUserId: s.accountableUserId,
      worthSurfacing: true,
      phrasing: `${s.type} on ${s.targetTitle}`,
    }));
  };
  const answer: AnswerFn = async () => {
    calls.answer++;
    return '';
  };
  const act: ActFn = async () => {
    calls.act++;
    return { ok: true };
  };

  return { calls, judge, answer, act };
}

function depsWith(f: ReturnType<typeof fakes>): GraphDeps {
  return { db: pool, judge: f.judge, answer: f.answer, act: f.act };
}

/** One proactive scan of the workspace, with fresh counters. */
async function scan() {
  const f = fakes();
  const final = await compileGraph(depsWith(f)).invoke(
    { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
    { recursionLimit: 50 }
  );
  return { final, calls: f.calls };
}

/** A stalled issue: idle 20 days, well past the 5-business-day threshold. */
async function stalledIssue(): Promise<string> {
  const assignee = await createUser(pool, `u-${ws.workspaceId.slice(0, 8)}@t.local`, 'U');
  return createIssue(pool, ws, {
    title: 'Fix the login redirect',
    state: 'in_progress',
    updatedDaysAgo: 20,
    assigneeId: assignee,
  });
}

async function observationFor(fingerprint: string) {
  const { rows } = await pool.query(
    `SELECT id, resolution, snooze_until FROM fleetgraph_observations
      WHERE workspace_id = $1 AND fingerprint = $2`,
    [ws.workspaceId, fingerprint]
  );
  return rows[0] as { id: string; resolution: string | null; snooze_until: Date | null } | undefined;
}

async function notificationCount(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM fleetgraph_notifications WHERE workspace_id = $1`,
    [ws.workspaceId]
  );
  return rows[0].n as number;
}

describe('FG-135 — a dismissed fingerprint is suppressed on the next run', () => {
  it('never fires again, and the measurement is still there underneath', async () => {
    const issueId = await stalledIssue();

    // Run 1: the agent finds it and says something.
    const first = await scan();
    expect(first.final.outcome).toBe('delivered');
    expect(first.calls.judge).toBe(1);
    expect(first.final.signals).toHaveLength(1);

    const fingerprint = first.final.signals[0]!.fingerprint;
    const obs = await observationFor(fingerprint);
    expect(obs, 'deliver must record the observation').toBeTruthy();
    expect(obs!.resolution).toBeNull();

    // The human dismisses it. Q23: the agent was wrong, or the human has
    // context the agent lacks. Either way, re-asking is worse than useless.
    await resolveObservation(obs!.id, 'dismissed', null, pool);

    // Run 2.
    const second = await scan();

    // Silent — and silent for the RIGHT reason. `quiet_all_suppressed` rather
    // than `quiet_no_signals` is the whole distinction: one means everything
    // wrong is already on someone's desk, the other means nothing is wrong.
    expect(second.final.outcome).toBe('quiet_all_suppressed');
    expect(second.calls.judge, 'a suppressed finding costs zero tokens').toBe(0);
    expect(second.calls.act).toBe(0);

    // The other direction. Without this the test would pass if the detector
    // had simply stopped working.
    const measured = await runDetectors(ws.workspaceId, pool);
    expect(measured.signals, 'the condition is suppressed, not gone').toHaveLength(1);
    expect(measured.signals[0]!.fingerprint).toBe(fingerprint);
    expect(measured.signals[0]!.targetId).toBe(issueId);

    // And the suppression set is where the exclusion comes from.
    const suppressed = await loadSuppressionSet(ws.workspaceId, pool);
    expect(suppressed.has(fingerprint)).toBe(true);
  }, 90_000);

  it('stays dismissed on the run after that, and the one after that', async () => {
    // "Permanently" is the claim, not "for one run". A dismissal with an
    // accidental TTL would pass the test above and fail the users.
    await stalledIssue();

    const first = await scan();
    const fingerprint = first.final.signals[0]!.fingerprint;
    await resolveObservation((await observationFor(fingerprint))!.id, 'dismissed', null, pool);

    const notificationsAfterFirst = await notificationCount();

    for (let run = 0; run < 3; run++) {
      const later = await scan();
      expect(later.final.outcome, `run ${run + 2}`).toBe('quiet_all_suppressed');
      expect(later.calls.judge, `run ${run + 2}`).toBe(0);
    }

    expect(await notificationCount(), 'no further notifications').toBe(notificationsAfterFirst);
  }, 120_000);
});

describe('FG-136 — a snoozed finding that self-resolves never returns', () => {
  it('is silent while snoozed, and stays silent once the condition is gone', async () => {
    const issueId = await stalledIssue();

    const first = await scan();
    expect(first.final.outcome).toBe('delivered');
    const fingerprint = first.final.signals[0]!.fingerprint;
    const obs = await observationFor(fingerprint);

    // Snooze for 3 business days — the default horizon (Q23). Business days,
    // not hours: every threshold the detectors use is in business days, so an
    // hours-scale snooze would wake before the state could plausibly change.
    const until = addBusinessDays(new Date(), 3);
    await resolveObservation(obs!.id, 'snoozed', until, pool);

    const stored = await observationFor(fingerprint);
    expect(stored!.resolution).toBe('snoozed');
    expect(stored!.snooze_until).toBeTruthy();
    // At least 3 calendar days, because N business days always span at least N
    // calendar days and never fewer.
    expect(stored!.snooze_until!.getTime() - Date.now()).toBeGreaterThan(2.5 * 86_400_000);

    // While snoozed: silent, and suppressed rather than unmeasured.
    const during = await scan();
    expect(during.final.outcome).toBe('quiet_all_suppressed');
    expect(during.calls.judge).toBe(0);
    expect((await loadSuppressionSet(ws.workspaceId, pool)).has(fingerprint)).toBe(true);

    // The condition resolves itself: someone moves the issue on. This is the
    // ordinary case for a snooze — the human snoozed it because they were
    // about to deal with it.
    await pool.query(`UPDATE documents SET updated_at = NOW() WHERE id = $1`, [issueId]);

    // The horizon passes. Moved by hand rather than waited out, which is the
    // only difference between this and three real days.
    await pool.query(
      `UPDATE fleetgraph_observations SET snooze_until = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [obs!.id]
    );

    // The snooze has expired, so nothing suppresses it any more...
    const suppressedNow = await loadSuppressionSet(ws.workspaceId, pool);
    expect(suppressedNow.has(fingerprint), 'the horizon has passed').toBe(false);

    // ...and yet it does not come back, because the DETECTOR is re-run rather
    // than the stored finding replayed (Q23/FG-134). No code detects that the
    // condition resolved. The absence of a signal does the work.
    const measured = await runDetectors(ws.workspaceId, pool);
    expect(measured.signals).toHaveLength(0);

    const notificationsBefore = await notificationCount();
    const after = await scan();

    // `quiet_no_signals`, NOT `quiet_all_suppressed` — the reason it is silent
    // has genuinely changed, and the trace says so.
    expect(after.final.outcome).toBe('quiet_no_signals');
    expect(after.calls.judge, 'nothing to judge').toBe(0);
    expect(after.calls.act).toBe(0);
    expect(await notificationCount(), 'nobody is told about a fixed problem').toBe(
      notificationsBefore
    );
  }, 120_000);

  it('but a snoozed finding that did NOT resolve does come back', async () => {
    // The control. Without it, a detector that had simply stopped measuring
    // would pass the test above with flying colours.
    await stalledIssue();

    const first = await scan();
    const fingerprint = first.final.signals[0]!.fingerprint;
    const obs = await observationFor(fingerprint);
    await resolveObservation(obs!.id, 'snoozed', addBusinessDays(new Date(), 3), pool);

    expect((await scan()).final.outcome).toBe('quiet_all_suppressed');

    // Horizon passes; nobody touched the issue.
    await pool.query(
      `UPDATE fleetgraph_observations SET snooze_until = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [obs!.id]
    );

    const woken = await scan();
    expect(woken.final.outcome, 'still stalled, so it surfaces again').toBe('delivered');
    expect(woken.calls.judge).toBe(1);
    expect(woken.final.signals[0]!.fingerprint).toBe(fingerprint);
  }, 120_000);
});
