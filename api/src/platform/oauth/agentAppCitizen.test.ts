/**
 * L23 S1 — the agent's app, as a CONSUMER of L02's seed. PF-689, PF-690, PF-691.
 *
 * Nothing here registers an app, mints a secret, or writes a row. That is the
 * whole point of PF-689: p.17 asks *"How is the agent's app seeded … what
 * guarantees it exists in deployed environments?"*, L02 answered it with
 * `seedPlatformApps()` running on every `db:migrate`, and a second seeding path
 * anywhere is how a deployed environment ends up with two agent apps and an
 * audit trail split across both.
 *
 * The run-time half of PF-691 — that a real scan produces rows under this
 * `client_id` and that no other caller does — is the fitness test in S5
 * (PF-709). This file covers the parts that are true before anything runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_CLIENT_ID,
  PLATFORM_APP_SEEDS,
  resolvePlatformAppSeeds,
} from '../../db/platformApps.js';
import { scopeRegistry } from '../scopes/scopes.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AGENT_SRC = join(REPO_ROOT, 'agent/src');

/** Every `.ts` file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const agentSources = walk(AGENT_SRC).map((path) => ({
  name: relative(REPO_ROOT, path),
  code: readFileSync(path, 'utf8'),
}));

const agentSeed = PLATFORM_APP_SEEDS.find((s) => s.clientId === AGENT_CLIENT_ID);

describe('PF-689 — the agent consumes the seeded app and adds no second path', () => {
  it('finds the agent app in L02 seed set, so there is something to consume', () => {
    expect(agentSeed).toBeDefined();
  });

  /**
   * The grep the ticket asks for, and the reason it is a grep rather than a code
   * review: a second seeding path is invisible in every functional test. Both
   * apps would work. Only the audit trail would be wrong, and only in
   * production.
   */
  it('nothing under agent/ inserts into oauth_apps', () => {
    const offenders = agentSources
      .filter((f) => /INSERT\s+INTO\s+oauth_apps/i.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('nothing under agent/ generates a client_id or a client_secret', () => {
    const offenders = agentSources
      .filter((f) => /generateClient(Id|Secret)\s*\(/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  /**
   * The positive half. The agent resolves its credentials from the two
   * environment variables L02's seed reads from, and from nothing else — a
   * hard-coded `client_id` would work in dev and point at a row that does not
   * exist anywhere the seed did not run.
   */
  it('the agent reads AGENT_CLIENT_ID and AGENT_CLIENT_SECRET from the environment', () => {
    const readers = agentSources.filter((f) => f.code.includes('AGENT_CLIENT_SECRET'));
    expect(readers.length).toBeGreaterThan(0);

    /**
     * And whichever file holds the secret does not hash it or log it.
     *
     * Scoped to the READERS rather than to the whole package, deliberately.
     * `createHash` appears legitimately in `detectors/fingerprint.ts` and
     * `llm/judge.ts` — a package-wide grep for it would fail on work that has
     * nothing to do with credentials, which is the shape of grep that gets
     * deleted rather than fixed (L99 F113).
     *
     * The agent verifies nothing: it PRESENTS the secret to `/oauth/token` and
     * the server compares. A hash appearing beside the secret would mean a
     * second comparison site, which is what PF-034's one-site rule forbids.
     */
    const offenders = readers
      .filter((f) => /hashClientSecret|createHash\(|console\.(log|error)\(.*CLIENT_SECRET/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('the env var the agent reads is the env var the seed writes from', () => {
    expect(agentSeed!.secretEnvVar).toBe('AGENT_CLIENT_SECRET');
  });
});

describe('PF-690 — exactly three scopes, and each one is defensible', () => {
  /**
   * The list, exactly. Not `toContain` — a write scope added to this row would
   * pass a containment check forever, which is precisely how `issues:write` sat
   * on this app until 2026-08-12 under a comment saying "least privilege".
   */
  it('requests exactly documents:read, issues:read and sprints:read', () => {
    expect([...agentSeed!.requestedScopes].sort()).toEqual([
      'documents:read',
      'issues:read',
      'sprints:read',
    ]);
  });

  it('holds no write scope, named by the assertion when it fails', () => {
    const writes = agentSeed!.requestedScopes.filter((s) => s.endsWith(':write'));
    expect(writes, `the agent is read-only under D5b; found ${writes.join(', ')}`).toEqual([]);
  });

  it('holds no manage scope either — webhooks:manage is a write in every sense', () => {
    expect(agentSeed!.requestedScopes.filter((s) => s.endsWith(':manage'))).toEqual([]);
  });

  it('every scope it requests is one this server actually registers', () => {
    for (const scope of agentSeed!.requestedScopes) {
      expect(scopeRegistry.has(scope), `${scope} is not a registered scope`).toBe(true);
    }
  });

  /**
   * PF-690's defence is MEASURED from the detectors rather than asserted in
   * prose. Each of the three scopes is here because a named detector reads the
   * corresponding `document_type`; if a detector stopped reading one, the scope
   * would be dead weight on the agent's blast radius and this test says so.
   */
  it.each([
    ['issues:read', /document_type\s*=\s*'issue'/],
    ['sprints:read', /document_type\s*=\s*'sprint'/],
    ['documents:read', /document_type\s*(=|IN)\s*\(?'(project|person)'/],
  ])('%s is earned — some detector or fetch node reads that document_type', (scope, pattern) => {
    const readers = agentSources.filter((f) => pattern.test(f.code)).map((f) => f.name);
    expect(readers.length, `${scope} is requested but nothing reads it`).toBeGreaterThan(0);
  });
});

describe('PF-691 — the agent app is distinguishable, and B11 does not apply', () => {
  /**
   * L99's B11 records that portal traffic cannot be told apart from a
   * developer's own in the audit trail, because both run under the developer's
   * app. The agent does not have that problem — it has its OWN app — and
   * `docs/architecture.md`'s claim is literally *"under the agent app's
   * `client_id`"*, so it is worth checking rather than assuming.
   */
  it('the client_id is a FIXED constant, not generated per environment', () => {
    expect(AGENT_CLIENT_ID).toBe('ship_app_firstparty_fleetgraph_agent');
    // A generated id would make PF-710's demo query unportable: the query a
    // reader runs on stage would have to be edited per deployment.
    expect(AGENT_CLIENT_ID).not.toMatch(/\d{6,}/);
  });

  it('no other seeded app shares that client_id', () => {
    const matching = PLATFORM_APP_SEEDS.filter((s) => s.clientId === AGENT_CLIENT_ID);
    expect(matching).toHaveLength(1);
  });

  /**
   * F100's pin, restated from this lane's side because this lane is the reason
   * it matters. `client_id` is printed in the README for graders; a public agent
   * app plus the client-credentials grant would let any reader mint agent
   * tokens with no human in the loop.
   *
   * `clientCredentials.test.ts` case (f) is the enforcement; this is the
   * registration that makes the enforcement unnecessary in the first place.
   */
  it('is CONFIDENTIAL and FIRST-PARTY — the two properties the grant requires', () => {
    expect(agentSeed!.isPublic).toBe(false);
    expect(agentSeed!.isFirstParty).toBe(true);
  });

  it('resolves with the same fixed client_id when a secret is present', () => {
    const resolved = resolvePlatformAppSeeds({ AGENT_CLIENT_SECRET: 'test-secret-value' });
    expect(resolved.map((r) => r.client_id)).toEqual([AGENT_CLIENT_ID]);
    expect(resolved[0]!.is_public).toBe(false);
    expect(resolved[0]!.is_first_party).toBe(true);
  });
});
