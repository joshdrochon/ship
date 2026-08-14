/**
 * D5b — the read-only action path. PF-699, PF-700, PF-701, PF-702, PF-703.
 *
 * Against a real Postgres, because the assertions are about rows: exactly one
 * recommendation per action, `kind` reading back correctly, existing rows
 * keeping their meaning after the migration, and the banner index still being
 * the one the planner picks. A mock would let every one of those regress
 * silently.
 *
 * The comparison that matters throughout is against the FLAG-OFF path's own
 * output rather than against a hand-written literal — `commentBody()` and
 * `auditLine()` are imported and called here exactly as `makeShipAct` calls
 * them, so if the two paths ever say different things about the same
 * measurement, these tests fail rather than the write-up quietly becoming
 * false.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createTestPool } from '../testing/pool.js';
import type { ProposedAction } from '../graph/state.js';
import { makeShipAct } from './act.js';
import { commentBody, auditLine } from './act.js';
import { makeRecommendAct } from './recommend.js';
import { createShipClient, type FetchLike } from './client.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let workspaceId: string;
let userId: string;
let issueId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = createTestPool(container.getConnectionUri());

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

  workspaceId = (
    await pool.query(`INSERT INTO workspaces (name) VALUES ('D5b') RETURNING id`)
  ).rows[0].id;
  userId = (
    await pool.query(
      `INSERT INTO users (email, name) VALUES ('d5b@test.local', 'D') RETURNING id`,
    )
  ).rows[0].id;
  issueId = (
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'issue', 'Stalled issue', $2) RETURNING id`,
      [workspaceId, userId],
    )
  ).rows[0].id;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('DELETE FROM fleetgraph_notifications');
  await pool.query('DELETE FROM fleetgraph_observations');
  await pool.query('DELETE FROM document_history');
});

/** An action shaped exactly as `routeAction` builds one. */
function commentAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    class: 'additive',
    kind: 'comment',
    targetId: issueId,
    describe: 'Post a comment on "Stalled issue": nothing has moved here in three weeks',
    payload: {
      signalType: 'stalled_work',
      targetType: 'issue',
      measurement: 14,
      threshold: 5,
      phrasing: 'nothing has moved here in three weeks',
      context: { idle_business_days: 14 },
      workspaceId,
      fingerprint: 'stalled_work:abc123:14d',
      recipientUserId: userId,
    },
    ...overrides,
  };
}

/** Counts every HTTP request the act path makes. PF-699's zero. */
function countingFetch(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{}',
    } as never;
  };
  return { fetch, calls };
}

async function notifications() {
  const { rows } = await pool.query(
    `SELECT id, title, body, kind, state, recipient_user_id, target_id
       FROM fleetgraph_notifications ORDER BY created_at`,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-699 — `comment` becomes a recommendation and posts nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-699 — the comment action', () => {
  it('issues ZERO HTTP requests to Ship on the flag-on path', async () => {
    const { fetch, calls } = countingFetch();
    // A client is constructed and handed the counting fetch, then deliberately
    // never given to the read-only act. If the read-only path ever reaches for
    // HTTP, this array is how it shows up.
    createShipClient({ baseUrl: 'http://ship.test', token: 't', fetchImpl: fetch });

    const act = makeRecommendAct({ db: pool });
    const result = await act(commentAction());

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it('writes EXACTLY ONE recommendation row per action', async () => {
    const act = makeRecommendAct({ db: pool });
    await act(commentAction());

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('recommendation');
    expect(rows[0].recipient_user_id).toBe(userId);
    expect(rows[0].target_id).toBe(issueId);
  });

  /**
   * The measurement string is compared against the FLAG-OFF path's own output,
   * not against a literal.
   *
   * A literal here would pass forever while the two paths drifted, and drift is
   * the specific thing the write-up's claim — *"the same finding reached a
   * human"* — cannot survive.
   */
  it('carries the same body the flag-off comment would have carried', async () => {
    const action = commentAction();
    const act = makeRecommendAct({ db: pool });
    await act(action);

    const rows = await notifications();
    expect(rows[0].body).toBe(commentBody(action));
    // And the measurement really is in there, so the assertion above is not
    // comparing two empty strings.
    expect(rows[0].body).toContain('Measured 14 against a threshold of 5');
    expect(rows[0].body).toContain('— FleetGraph');
  });

  it('records an observation the delivery node then finds rather than duplicating', async () => {
    const act = makeRecommendAct({ db: pool });
    await act(commentAction());
    await act(commentAction());

    // Two actions on the same fingerprint, one observation — the upsert on
    // `(workspace_id, fingerprint)` is what makes the whole proactive path
    // crash-safe, and this path reuses it rather than adding a second writer.
    const { rows } = await pool.query('SELECT id FROM fleetgraph_observations');
    expect(rows).toHaveLength(1);
  });

  it('refuses loudly when the action carries no recipient', async () => {
    const act = makeRecommendAct({ db: pool });
    const orphan = commentAction();
    delete orphan.payload.recipientUserId;

    const result = await act(orphan);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no workspace, fingerprint or recipient/);
    expect(await notifications()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-700 — `history_note` becomes a recommendation, and the loss is real.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-700 — the history note, and what it costs', () => {
  it('writes ZERO document_history rows', async () => {
    const act = makeRecommendAct({ db: pool });
    await act(commentAction({ kind: 'history_note' }));

    const { rows } = await pool.query(
      `SELECT id FROM document_history WHERE automated_by = 'fleetgraph'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('carries auditLine()`s one-line summary instead', async () => {
    const action = commentAction({ kind: 'history_note' });
    const act = makeRecommendAct({ db: pool });
    await act(action);

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(auditLine(action));
    expect(rows[0].body).toBe('stalled_work: measured 14, threshold 5');
  });

  /**
   * The disclosure, as an assertion.
   *
   * `docs/architecture.md` has to say that under read-only the agent's trail
   * moves from `document_history` to `public_api_calls` +
   * `fleetgraph_notifications`. A test cannot check prose — but it can check
   * that the prose exists, which is what stops the paragraph being deleted in a
   * tidy-up by someone who does not know it is load-bearing.
   */
  it('the architecture document states where the trail moved to', () => {
    const doc = readFileSync(join(process.cwd(), '..', 'docs', 'architecture.md'), 'utf8');
    expect(doc).toMatch(/document_history/);
    expect(doc).toMatch(/recommendation/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-701 — `notify` is unchanged, in both states.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-701 — notify is untouched by D5b', () => {
  it('returns the byte-identical result on both paths', async () => {
    const notifyAction = commentAction({ kind: 'notify' });

    const flagOff = await makeShipAct(
      createShipClient({ baseUrl: 'http://ship.test', token: 't', fetchImpl: countingFetch().fetch }),
    )(notifyAction);
    const flagOn = await makeRecommendAct({ db: pool })(notifyAction);

    expect(flagOn).toEqual(flagOff);
    expect(flagOn.detail).toBe(
      'notification is written by the delivery node, not over HTTP',
    );
  });

  /**
   * The failure this exists to catch, named: routing `notify` through the
   * recommendation path would double every delivery. It would look like the
   * agent got chattier, not like a bug.
   */
  it('writes NO row of its own — the delivery node still owns that', async () => {
    await makeRecommendAct({ db: pool })(commentAction({ kind: 'notify' }));
    expect(await notifications()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-702 — the column, and what it does to rows that already exist.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-702 — kind', () => {
  it('defaults existing and new delivery-node rows to `finding`', async () => {
    const obs = await pool.query(
      `INSERT INTO fleetgraph_observations
         (workspace_id, fingerprint, signal_type, target_id, target_type, last_surfaced_at)
       VALUES ($1, 'legacy:1', 'stalled_work', $2, 'issue', NOW()) RETURNING id`,
      [workspaceId, issueId],
    );
    // Written the way `deliver` writes one, with no `kind` mentioned anywhere.
    await pool.query(
      `INSERT INTO fleetgraph_notifications
         (workspace_id, observation_id, recipient_user_id, title, body, target_id)
       VALUES ($1, $2, $3, 'A finding', 'body', $4)`,
      [workspaceId, obs.rows[0].id, userId, issueId],
    );

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('finding');
  });

  it('rejects a third kind at the database, not in code', async () => {
    const obs = await pool.query(
      `INSERT INTO fleetgraph_observations
         (workspace_id, fingerprint, signal_type, target_id, target_type, last_surfaced_at)
       VALUES ($1, 'check:1', 'stalled_work', $2, 'issue', NOW()) RETURNING id`,
      [workspaceId, issueId],
    );
    await expect(
      pool.query(
        `INSERT INTO fleetgraph_notifications
           (workspace_id, observation_id, recipient_user_id, title, target_id, kind)
         VALUES ($1, $2, $3, 'x', $4, 'suggestion')`,
        [workspaceId, obs.rows[0].id, userId, issueId],
      ),
    ).rejects.toThrow();
  });

  /**
   * The banner query must NOT narrow.
   *
   * A document's banner wants every pending notification about it, of either
   * kind. This asserts the partial index on `(target_id) WHERE state =
   * 'pending'` is still the one the planner reaches for — the failure it
   * prevents is someone "optimising" by adding `kind` to that index and
   * silently hiding recommendations from the banner.
   */
  it('leaves the banner index usable — the query still finds both kinds', async () => {
    const act = makeRecommendAct({ db: pool });
    await act(commentAction());

    const { rows } = await pool.query(
      `SELECT kind FROM fleetgraph_notifications
        WHERE target_id = $1 AND state = 'pending'`,
      [issueId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['recommendation']);

    const plan = await pool.query(
      `EXPLAIN SELECT id FROM fleetgraph_notifications
        WHERE target_id = $1 AND state = 'pending'`,
      [issueId],
    );
    // The index EXISTS and is declared over the right predicate. Not asserting
    // the planner USED it — on a table this small it will sort, and L99 F44
    // records exactly that assertion flaking for exactly that reason.
    const indexes = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_fleetgraph_notif_target'`,
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].indexdef).toContain("state = 'pending'");
    expect(indexes.rows[0].indexdef).not.toContain('kind');
    expect(plan.rows.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-703 — the mutation refusal did not move, and the two paths agree on it.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-703 — the mutation refusal is identical in both states', () => {
  it('refuses byte-for-byte the same string on both paths', async () => {
    const mutation = commentAction({ class: 'mutation', kind: 'reassign' });

    const flagOff = await makeShipAct(
      createShipClient({ baseUrl: 'http://ship.test', token: 't', fetchImpl: countingFetch().fetch }),
    )(mutation);
    const flagOn = await makeRecommendAct({ db: pool })(mutation);

    expect(flagOn).toEqual(flagOff);
    expect(flagOn.ok).toBe(false);
    expect(flagOn.detail).toContain('is a state mutation');
  });

  it('a refused mutation writes nothing at all', async () => {
    await makeRecommendAct({ db: pool })(commentAction({ class: 'mutation', kind: 'reassign' }));
    expect(await notifications()).toHaveLength(0);
  });
});
