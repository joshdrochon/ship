/**
 * The flag-on read path — PF-693, PF-694, PF-697.
 *
 * ## The comparison that matters
 *
 * Both readers run the SAME detector code over the SAME fixture workspace, and
 * the emitted `Signal[]` are compared to each other. Not to a golden file: a
 * golden file records what the code did on the day it was written, and both
 * paths could drift together past it without a single assertion turning red.
 *
 * ## What is NOT byte-identical, and why it says so out loud
 *
 * `stalledWork`'s `context.started_at` is a date on the SQL path and `null` on
 * the SDK path, because `issueSchema` carries no `started_at` field. That is a
 * measured shortfall against PF-694's literal wording — recorded as **F143**,
 * asserted below by name, and deliberately NOT hidden by loosening the
 * comparison. Everything the agent acts on — measurement, threshold, bucket,
 * fingerprint, accountable user — is identical, so suppression and delivery are
 * unaffected; what is lost is one line of context in the judgment prompt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createTestPool } from '../testing/pool.js';
import type { ShipClient, ShipIssue } from '@ship/sdk';
import { detectStalledWork } from '../detectors/stalledWork.js';
import { detectReviewBottleneck } from '../detectors/reviewBottleneck.js';
import type { Signal } from '../detectors/types.js';
import {
  createCitizenReader,
  tablesIn,
  AGENT_OWN_TABLES,
  SQL_EXCEPTIONS,
} from './citizenReader.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');
const NOW = new Date('2026-08-14T12:00:00Z');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let workspaceId: string;
let ownerId: string;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

/** The issues both readers see, seeded once. */
const SEED = [
  { title: 'Idle three weeks', state: 'in_progress', updatedDaysAgo: 21, startedDaysAgo: 40, priority: 'high' },
  { title: 'Idle eight days', state: 'in_progress', updatedDaysAgo: 8, startedDaysAgo: 12, priority: 'medium' },
  { title: 'Moved yesterday', state: 'in_progress', updatedDaysAgo: 1, startedDaysAgo: 3, priority: 'low' },
  { title: 'In review a fortnight', state: 'in_review', updatedDaysAgo: 14, startedDaysAgo: 20, priority: 'urgent' },
  { title: 'In review three days', state: 'in_review', updatedDaysAgo: 3, startedDaysAgo: 9, priority: 'medium' },
  { title: 'In review this morning', state: 'in_review', updatedDaysAgo: 0, startedDaysAgo: 2, priority: 'none' },
  { title: 'Done long ago', state: 'done', updatedDaysAgo: 30, startedDaysAgo: 60, priority: 'low' },
];

/**
 * A `ShipClient` stand-in over the SAME rows the SQL path reads.
 *
 * Built from the database rather than from a literal, so the two paths cannot
 * disagree because the fixture was written down twice. Only `issues.iterate()`
 * is implemented; anything else the reader reached for would be a `TypeError`
 * naming the method, which is the failure this test wants.
 */
function fakeShipClient(issues: ShipIssue[]): { client: ShipClient; pages: number } {
  const state = { pages: 0 };
  const client = {
    issues: {
      async *iterate() {
        state.pages += 1;
        for (const issue of issues) yield issue;
      },
    },
  } as unknown as ShipClient;
  return { client, get pages() { return state.pages; } };
}

async function issuesFromDb(): Promise<ShipIssue[]> {
  const { rows } = await pool.query(
    `SELECT id, title, updated_at, created_at,
            properties->>'state'       AS state,
            properties->>'priority'    AS priority,
            properties->>'assignee_id' AS assignee_id
       FROM documents
      WHERE workspace_id = $1 AND document_type = 'issue'`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    document_type: 'issue',
    title: r.title,
    ticket_number: null,
    state: r.state,
    priority: r.priority,
    assignee_id: r.assignee_id,
    belongs_to: [],
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
    created_by: ownerId,
  })) as ShipIssue[];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = createTestPool(container.getConnectionUri());

  await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`,
  );
  for (const f of readdirSync(join(API_DB, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f.replace('.sql', '')]);
  }

  workspaceId = (await pool.query(`INSERT INTO workspaces (name) VALUES ('L23') RETURNING id`)).rows[0].id;
  ownerId = (
    await pool.query(`INSERT INTO users (email, name) VALUES ('l23@test.local', 'L') RETURNING id`)
  ).rows[0].id;

  for (const spec of SEED) {
    await pool.query(
      `INSERT INTO documents
         (workspace_id, document_type, title, properties, created_by,
          created_at, updated_at, started_at)
       VALUES ($1, 'issue', $2,
               jsonb_build_object('state', $3::text, 'assignee_id', $4::text, 'priority', $5::text),
               $6::uuid, $7, $7, $8)`,
      [
        workspaceId,
        spec.title,
        spec.state,
        ownerId,
        spec.priority,
        ownerId,
        daysAgo(spec.updatedDaysAgo),
        daysAgo(spec.startedDaysAgo),
      ],
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** Both readers, over the same rows. */
async function bothReaders() {
  const issues = await issuesFromDb();
  const fake = fakeShipClient(issues);
  const sdk = createCitizenReader({ client: fake.client, ownState: pool });
  return { sql: pool, sdk, fake };
}

/** Everything a Signal carries except the one field F143 names. */
function withoutStartedAt(signals: Signal[]) {
  return signals.map((s) => {
    const { started_at: _dropped, ...context } = s.context;
    return { ...s, context };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-694 — the two detectors the public surface fully covers.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-694 — reviewBottleneck through client.issues', () => {
  it('produces BYTE-IDENTICAL Signal[] from both readers', async () => {
    const { sql, sdk } = await bothReaders();
    const fromSql = await detectReviewBottleneck(workspaceId, sql, NOW);
    const fromSdk = await detectReviewBottleneck(workspaceId, sdk, NOW);

    // Non-vacuous: the fixture really does trip the detector.
    expect(fromSql.length).toBeGreaterThan(0);
    expect(fromSdk).toEqual(fromSql);
  });

  it('and it is the FULL Signal, fingerprint included', async () => {
    const { sql, sdk } = await bothReaders();
    const fromSql = await detectReviewBottleneck(workspaceId, sql, NOW);
    const fromSdk = await detectReviewBottleneck(workspaceId, sdk, NOW);
    expect(fromSdk.map((s) => s.fingerprint)).toEqual(fromSql.map((s) => s.fingerprint));
    expect(fromSdk.map((s) => s.measurement)).toEqual(fromSql.map((s) => s.measurement));
    expect(fromSdk.map((s) => s.accountableUserId)).toEqual(fromSql.map((s) => s.accountableUserId));
  });
});

describe('PF-694 — stalledWork through client.issues', () => {
  it('matches on everything except context.started_at', async () => {
    const { sql, sdk } = await bothReaders();
    const fromSql = await detectStalledWork(workspaceId, sql, NOW);
    const fromSdk = await detectStalledWork(workspaceId, sdk, NOW);

    expect(fromSql.length).toBeGreaterThan(0);
    expect(withoutStartedAt(fromSdk)).toEqual(withoutStartedAt(fromSql));
  });

  /**
   * ⚑ **F143, asserted rather than hidden.**
   *
   * `issueSchema` carries no `started_at`, so the SDK path cannot supply it. The
   * assertion is written the way it is — the SQL path HAS a date, the SDK path
   * has null — so that the day L10 adds the field, this test goes red and
   * somebody deletes it, rather than the shortfall persisting unnoticed behind a
   * comparison that had been loosened.
   */
  it('F143: `started_at` is a date on the SQL path and null on the SDK path', async () => {
    const { sql, sdk } = await bothReaders();
    const fromSql = await detectStalledWork(workspaceId, sql, NOW);
    const fromSdk = await detectStalledWork(workspaceId, sdk, NOW);

    expect(fromSql[0]!.context.started_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fromSdk[0]!.context.started_at).toBeNull();
    // And the four fields the agent actually acts on are untouched.
    expect(fromSdk[0]!.fingerprint).toBe(fromSql[0]!.fingerprint);
    expect(fromSdk[0]!.measurement).toBe(fromSql[0]!.measurement);
    expect(fromSdk[0]!.bucket).toBe(fromSql[0]!.bucket);
    expect(fromSdk[0]!.accountableUserId).toBe(fromSql[0]!.accountableUserId);
  });

  it('preserves ORDER BY updated_at ASC — oldest first', async () => {
    const { sdk } = await bothReaders();
    const signals = await detectStalledWork(workspaceId, sdk, NOW);
    const measurements = signals.map((s) => s.measurement);
    expect([...measurements].sort((a, b) => b - a)).toEqual(measurements);
  });

  it('walks the COLLECTION once per detector, through iterate()', async () => {
    const { sdk, fake } = await bothReaders();
    await detectStalledWork(workspaceId, sdk, NOW);
    // PF-698's raw number: one collection walk per detector query, not one
    // request per issue. The absolute request count is what the SDK's own
    // paginator decides, and this pins that the reader adds no loop of its own.
    expect(fake.pages).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-693 — the seam. Detectors do not know which path they are on.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-693 — the injection point', () => {
  it('takes the SAME `db: Queryable` parameter both detectors already had', async () => {
    const { sdk } = await bothReaders();
    // Compiles and runs with no cast and no second argument. That is the whole
    // assertion: if the seam had moved, this file would not type-check.
    expect(await detectStalledWork(workspaceId, sdk, NOW)).toBeInstanceOf(Array);
    expect(await detectReviewBottleneck(workspaceId, sdk, NOW)).toBeInstanceOf(Array);
  });

  it('serves both statements from the SDK and touches no table over SQL', async () => {
    const { sdk } = await bothReaders();
    await detectStalledWork(workspaceId, sdk, NOW);
    await detectReviewBottleneck(workspaceId, sdk, NOW);

    expect(sdk.statements.map((s) => s.servedBy)).toEqual(['sdk', 'sdk']);
    expect(sdk.tablesTouchedBySql()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-697 — the invariant that makes "for every action" checkable.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-697 — the table invariant', () => {
  it('passes the agent`s OWN tables through and records them', async () => {
    const { sdk } = await bothReaders();
    await sdk.query('SELECT 1 FROM fleetgraph_watermarks WHERE workspace_id = $1', [workspaceId]);

    expect(sdk.tablesTouchedBySql()).toEqual(['fleetgraph_watermarks']);
    expect(sdk.invariantViolations()).toEqual([]);
  });

  /**
   * The loud failure, and it is the point of the whole design.
   *
   * A silent drop-back to SQL would make the front-door claim unfalsifiable:
   * every future detector edit would quietly widen the exception surface and
   * nothing would say so.
   */
  it('THROWS on a Ship table it cannot serve, naming the table and the way forward', async () => {
    const { sdk } = await bothReaders();
    await expect(
      sdk.query('SELECT name FROM workspaces WHERE id = $1', [workspaceId]),
    ).rejects.toThrow(/tried to read workspaces over SQL/);
  });

  it('names `documents` too — the most likely accident', async () => {
    const { sdk } = await bothReaders();
    await expect(
      sdk.query("SELECT id FROM documents WHERE document_type = 'program'"),
    ).rejects.toThrow(/tried to read documents over SQL/);
  });

  /**
   * PF-696 — `workspaces` must never appear on the flag-on path.
   *
   * `sprintMissRisk` joins it today to derive the sprint's calendar window.
   * `workspaces` is tenant CONFIGURATION: it has no public route and should
   * never have one, and PF-289 already resolves this from the other side by
   * computing `start_date`/`end_date` server-side onto `sprintSchema`.
   */
  it('PF-696: workspaces is not in the allowed set and cannot be added by accident', () => {
    expect([...AGENT_OWN_TABLES]).not.toContain('workspaces');
    expect(SQL_EXCEPTIONS.map((e) => e.table)).not.toContain('workspaces');
  });

  /** The exception array is a bound, so it has to be short and reasoned. */
  it('every exception carries a reason and a named reader', () => {
    expect(SQL_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exception of SQL_EXCEPTIONS) {
      expect(exception.reason.length).toBeGreaterThan(40);
      expect(exception.readers.length).toBeGreaterThan(0);
    }
    // If this ever reads zero, PF-695 chose (a)/(b) everywhere and the
    // architecture document's bounded claim should become an absolute one.
    expect(SQL_EXCEPTIONS.map((e) => e.table).sort()).toEqual([
      'document_associations',
      'document_history',
      'users',
    ]);
  });

  it('extracts tables from the four shapes it claims to', () => {
    expect(tablesIn('SELECT * FROM documents d WHERE 1=1').sort()).toEqual(['documents']);
    expect(tablesIn('SELECT * FROM a JOIN b ON a.id = b.a_id').sort()).toEqual(['a', 'b']);
    expect(tablesIn('INSERT INTO fleetgraph_notifications (x) VALUES (1)')).toEqual([
      'fleetgraph_notifications',
    ]);
    expect(tablesIn('UPDATE fleetgraph_observations SET x = 1')).toEqual([
      'fleetgraph_observations',
    ]);
  });
});
