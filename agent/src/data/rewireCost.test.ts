/**
 * PF-698 and PF-711 — what the rewire actually cost, measured.
 *
 * ## Why these two numbers had no test until now
 *
 * Both tickets were `⚑` on `tickets/plugforge/lane-23-agent-rewire.md` with one
 * shared reason, recorded as **F149**: L99's **F80** measured per-route P95
 * spreads of up to **6.0×** on a single commit while the agent fleet was
 * running, against a +10% budget — so any number taken on a loaded box is
 * worthless.
 *
 * **That reason is correct for timings and wrong for counts.** F80 is a
 * contention finding: it says a stopwatch on this hardware reads whatever the
 * other processes are doing. It says nothing about a REQUEST COUNT or a PROMPT
 * SIZE, both of which are functions of the code and the fixture and produce the
 * same value on an idle box and a melting one. Two of the three numbers those
 * tickets ask for are counts. They are measured here.
 *
 * What stays unmeasured, and stays honest:
 *
 * | Ticket | Number | State |
 * |---|---|---|
 * | PF-698 | requests per scan, flag-on | **measured here** — deterministic |
 * | PF-698 | wall-clock per scan, flag-off vs flag-on | still open; a stopwatch, and there is no server in this suite to time against |
 * | PF-711 | prompt volume per turn, flag-off vs flag-on | **measured here** — deterministic |
 *
 * ## PF-711 is measured in prompt CHARACTERS, and the reason matters
 *
 * There is no tokenizer in this repo and adding a model-specific one to count
 * bytes we already have would be a dependency bought for a rounding error. The
 * agent makes **one** LLM call per turn (p.11) and its input is exactly the
 * string `renderJudgeInput` returns, so the input volume per turn IS that
 * string. Characters are reported rather than tokens because characters are what
 * was actually counted; a tokenizer would move the absolute number by its own
 * ratio and would not change the DELTA's sign or its cause, which is what p.9
 * asks to confirm.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ShipClient, type ShipIssue } from '@ship/sdk';
import type { HttpClient, HttpRequest, HttpResponse } from '@ship/sdk';
import { createTestPool } from '../testing/pool.js';
import { detectStalledWork } from '../detectors/stalledWork.js';
import { detectReviewBottleneck } from '../detectors/reviewBottleneck.js';
import { renderJudgeInput } from '../llm/prompts/judge.js';
import type { Signal } from '../detectors/types.js';
import { createCitizenReader } from './citizenReader.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');
const NOW = new Date('2026-08-14T12:00:00Z');

/**
 * The shipped per-app and per-token ceilings, transcribed from
 * `api/src/deps.ts`'s `RATE_LIMIT_DEFAULTS`.
 *
 * Copied by value rather than imported: PF-692 fences `agent/**` off from
 * `api/src/**` and a test is not an exemption from a one-way door. The numbers
 * are asserted against the reported requests-per-scan below, and if `deps.ts`
 * changes them this file states a stale ceiling — which is why the row it
 * produces names its source.
 *
 * ⚑ **PF-698 names the per-APP capacity, and the per-TOKEN bucket is tighter.**
 * The agent authenticates once per scan and drives every request on one access
 * token, so both buckets apply and 100/min binds first. The ticket's stated
 * comparison would have passed against a limit the agent never reaches.
 */
const PER_APP_PER_MINUTE = 600;
const PER_TOKEN_PER_MINUTE = 100;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let workspaceId: string;
let ownerId: string;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

/**
 * The fixture workspace, sized so the walk pages more than once.
 *
 * `citizenReader.test.ts`'s seven-row fixture fits in one page and therefore
 * cannot show what the request count does as a workspace grows — which is the
 * whole of PF-698's first number. Forty-two rows across three states pages three
 * times at the SDK's 20-row request size, so the arithmetic is visible rather
 * than assumed.
 */
const SEED_SIZE = 42;

const SEED = Array.from({ length: SEED_SIZE }, (_, i) => ({
  title: `Issue ${String(i).padStart(2, '0')}`,
  state: (['in_progress', 'in_review', 'done'] as const)[i % 3]!,
  updatedDaysAgo: 5 + (i % 25),
  startedDaysAgo: 40 + (i % 25),
  priority: (['urgent', 'high', 'medium', 'low', 'none'] as const)[i % 5]!,
}));

// ─────────────────────────────────────────────────────────────────────────────
// A counting HTTP layer under the REAL ShipClient.
//
// Not a fake `client.issues.iterate()`: the number under test is how many HTTP
// requests the SDK's own paginator issues, so replacing the paginator would
// measure this file's arithmetic instead of the SDK's. Everything above the
// socket is real — transport, retry policy, cursor handling, `iterate()`.
// ─────────────────────────────────────────────────────────────────────────────

interface CountingHttp extends HttpClient {
  readonly requests: HttpRequest[];
  readonly apiRequests: HttpRequest[];
}

function countingHttp(issues: ShipIssue[], pageSize: number): CountingHttp {
  const requests: HttpRequest[] = [];

  function respond(request: HttpRequest): HttpResponse {
    const url = new URL(request.url);
    const offset = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
    const limit = Number.parseInt(url.searchParams.get('limit') ?? String(pageSize), 10);
    const slice = issues.slice(offset, offset + limit);
    const next = offset + limit < issues.length ? String(offset + limit) : null;
    const body = JSON.stringify({ data: slice, next_cursor: next });
    return {
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: () => Promise.resolve(body),
    };
  }

  return {
    requests,
    get apiRequests() {
      return requests.filter((r) => !r.url.includes('/oauth/token'));
    },
    send(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
  };
}

async function issuesFromDb(): Promise<ShipIssue[]> {
  const { rows } = await pool.query(
    `SELECT id, title, updated_at, created_at,
            properties->>'state'       AS state,
            properties->>'priority'    AS priority,
            properties->>'assignee_id' AS assignee_id
       FROM documents
      WHERE workspace_id = $1 AND document_type = 'issue'
      ORDER BY updated_at DESC`,
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

  workspaceId = (await pool.query(`INSERT INTO workspaces (name) VALUES ('L23-cost') RETURNING id`))
    .rows[0].id;
  ownerId = (
    await pool.query(`INSERT INTO users (email, name) VALUES ('l23cost@test.local', 'C') RETURNING id`)
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
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** A citizen reader over the real SDK, with every request counted. */
async function countingReader(pageSize = 20) {
  const issues = await issuesFromDb();
  const http = countingHttp(issues, pageSize);
  const client = new ShipClient({
    baseUrl: 'https://ship.test',
    token: 'test-access-token',
    http,
  });
  return { sdk: createCitizenReader({ client, ownState: pool }), http, issueCount: issues.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-698 — requests per scan, flag-on. A COUNT, so F80's contention veto
// does not apply and the number is the same on any box.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-698 — requests per scan under flag-on, measured', () => {
  it('two SDK-served detectors issue one FULL COLLECTION WALK each', async () => {
    const { sdk, http, issueCount } = await countingReader(20);

    await detectStalledWork(workspaceId, sdk, NOW);
    const afterFirst = http.apiRequests.length;
    await detectReviewBottleneck(workspaceId, sdk, NOW);
    const total = http.apiRequests.length;

    const pagesPerWalk = Math.ceil(issueCount / 20);
    expect(issueCount).toBe(SEED_SIZE);
    expect(pagesPerWalk).toBe(3);

    // The measurement, stated as the ticket asks: requests-per-scan is
    // `detectorsServedBySdk × ceil(issues / pageSize)`. Two detectors, 42
    // issues, 20 per request → 3 + 3 = 6.
    expect(afterFirst).toBe(pagesPerWalk);
    expect(total).toBe(2 * pagesPerWalk);

    // Every request is the issues collection. Nothing else is fetched, so the
    // count is a function of the collection size alone.
    expect(http.apiRequests.every((r) => r.url.includes('/api/v1/issues'))).toBe(true);
  });

  it('the count scales with the COLLECTION, not with the issue count per request', async () => {
    // Same rows, a smaller request size: the walk pages more, which is the only
    // lever the agent has if it ever needs to sit further under the ceiling.
    const { sdk, http, issueCount } = await countingReader(7);
    await detectStalledWork(workspaceId, sdk, NOW);
    expect(http.apiRequests.length).toBe(Math.ceil(issueCount / 7));
  });

  it('sits inside BOTH rate-limit buckets, and the per-token one is the binding constraint', async () => {
    const { sdk, http } = await countingReader(20);
    await detectStalledWork(workspaceId, sdk, NOW);
    await detectReviewBottleneck(workspaceId, sdk, NOW);

    const perScan = http.apiRequests.length;
    expect(perScan).toBe(6);

    // PF-698 asks for the comparison against the per-APP capacity. Both apply:
    // the agent drives one token, so the per-token bucket is what it actually
    // spends against, and it is six times tighter.
    expect(perScan).toBeLessThan(PER_TOKEN_PER_MINUTE);
    expect(perScan).toBeLessThan(PER_APP_PER_MINUTE);

    // The headroom, as a number rather than an adjective: at 20 rows per
    // request the per-token bucket is not reached until the workspace holds
    // 100/2 × 20 = 1000 issues in one scan. The fixture is 42.
    const issuesAtWhichPerTokenBinds = (PER_TOKEN_PER_MINUTE / 2) * 20;
    expect(issuesAtWhichPerTokenBinds).toBe(1000);
    expect(SEED_SIZE).toBeLessThan(issuesAtWhichPerTokenBinds);
  });

  it('the flag-OFF path issues ZERO HTTP requests — the comparison is one-sided by construction', async () => {
    const { http } = await countingReader(20);
    await detectStalledWork(workspaceId, pool, NOW);
    await detectReviewBottleneck(workspaceId, pool, NOW);
    // Flag-off reads SQL directly, so "requests per scan" has no flag-off value
    // to compare against — the honest before/after is 0 → 6, not a ratio.
    expect(http.apiRequests.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-711 — prompt volume per turn, flag-off vs flag-on.
// ─────────────────────────────────────────────────────────────────────────────

function promptFor(signals: Signal[]): string {
  return renderJudgeInput({
    signals,
    participants: [{ userId: ownerId, roles: ['assignee'] }],
    scope: { workspaceId },
  });
}

describe('PF-711 — the token-volume claim, confirmed or refuted with the delta', () => {
  it('both paths emit the SAME NUMBER of signals — the prompt is comparable at all', async () => {
    const { sdk } = await countingReader(20);
    const sqlSignals = [
      ...(await detectStalledWork(workspaceId, pool, NOW)),
      ...(await detectReviewBottleneck(workspaceId, pool, NOW)),
    ];
    const sdkSignals = [
      ...(await detectStalledWork(workspaceId, sdk, NOW)),
      ...(await detectReviewBottleneck(workspaceId, sdk, NOW)),
    ];

    // Non-vacuous: the fixture really does trip both detectors.
    expect(sqlSignals.length).toBeGreaterThan(0);
    expect(sdkSignals.length).toBe(sqlSignals.length);
  });

  it('p.9 REFUTED, and by exactly the mechanism PF-711 named in advance', async () => {
    const { sdk } = await countingReader(20);
    const sqlSignals = [
      ...(await detectStalledWork(workspaceId, pool, NOW)),
      ...(await detectReviewBottleneck(workspaceId, pool, NOW)),
    ];
    const sdkSignals = [
      ...(await detectStalledWork(workspaceId, sdk, NOW)),
      ...(await detectReviewBottleneck(workspaceId, sdk, NOW)),
    ];

    const before = promptFor(sqlSignals).length;
    const after = promptFor(sdkSignals).length;

    // p.9's hypothesis is *"confirm the rewire does not change token volume"*.
    // It DOES change it, and PF-711 named the only mechanism that could in
    // advance: *"a non-zero delta means a detector's inputs changed shape"*.
    // That is F143 — `issueSchema` carries no `started_at`, so `stalledWork`'s
    // `context.started_at` renders as `null` on the SDK path and as an ISO date
    // on the SQL path. The delta is the difference between those renderings and
    // nothing else.
    expect(after).not.toBe(before);
    expect(after).toBeLessThan(before);

    // The delta is asserted EXACTLY rather than against a threshold somebody
    // picked. `renderSignal` drops null-valued context entries, so the flag-on
    // prompt is the flag-off prompt with one `started_at` line removed per
    // stalled-work signal — and the arithmetic below reconstructs precisely
    // that from the signals themselves. A guessed "< 2%" bound would have been
    // a number this test invented; this one is a number it derived.
    const missingLines = sqlSignals
      .filter((s) => s.context.started_at !== null && s.context.started_at !== undefined)
      .map((s) => `\n    started_at: ${String(s.context.started_at)}`.length);
    const predicted = missingLines.reduce((a, b) => a + b, 0);

    expect(missingLines.length).toBeGreaterThan(0);
    expect(before - after).toBe(predicted);

    // Reported so the number lands in the run log rather than only in an
    // assertion, per p.13's "what did this cost you".
    const deltaPct = (after - before) / before;
    console.log(
      `[PF-711] judge prompt, same fixture, ${sqlSignals.length} signals — ` +
        `flag-off ${before} chars, flag-on ${after} chars, ` +
        `delta ${after - before} chars (${(deltaPct * 100).toFixed(2)}%). ` +
        `Cause: F143 — ${missingLines.length} started_at lines dropped, ` +
        `${predicted} chars, which is the WHOLE delta.`,
    );
  });

  it('the delta is ENTIRELY F143 — normalise that one field and the prompts are byte-identical', async () => {
    const { sdk } = await countingReader(20);
    const sqlSignals = await detectStalledWork(workspaceId, pool, NOW);
    const sdkSignals = await detectStalledWork(workspaceId, sdk, NOW);

    const drop = (signals: Signal[]): Signal[] =>
      signals.map((s) => {
        const { started_at: _dropped, ...context } = s.context;
        return { ...s, context };
      });

    // With `started_at` removed from BOTH sides the rendered prompts are the
    // same string. So the whole measured delta is that one field, and the claim
    // "the reader swap does not touch the prompt" is true of every other byte.
    expect(promptFor(drop(sdkSignals))).toBe(promptFor(drop(sqlSignals)));
  });

  it('reviewBottleneck alone costs the SAME on both paths — zero delta where F143 does not reach', async () => {
    const { sdk } = await countingReader(20);
    const fromSql = await detectReviewBottleneck(workspaceId, pool, NOW);
    const fromSdk = await detectReviewBottleneck(workspaceId, sdk, NOW);

    expect(fromSql.length).toBeGreaterThan(0);
    // The control. `reviewBottleneck` reads no field `issueSchema` lacks, and
    // its prompt is byte-identical — which is what makes the stalledWork delta
    // attributable rather than ambient.
    expect(promptFor(fromSdk)).toBe(promptFor(fromSql));
  });
});
