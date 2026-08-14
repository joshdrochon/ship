/**
 * PF-054, PF-055, PF-056, PF-057 — the seeded first-party apps.
 * Lane L02, slice S5.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { pool } from '../db/client.js';
import {
  AGENT_CLIENT_ID,
  DEMO_CLIENT_ID,
  GRADER_CLIENT_ID,
  GRADER_WORKSPACE_ID,
  PLATFORM_APP_SEEDS,
  PLATFORM_OWNER_USER_ID,
  assertPlatformAppSecrets,
  missingPlatformAppSecrets,
  resolvePlatformAppSeeds,
  seedPlatformApps,
} from './platformApps.js';
import { PgOAuthAppRepo } from '../platform/apps/pg-repo.js';
import { verifyClientSecret } from '../platform/apps/repo.js';

const AGENT_SECRET = 'ship_secret_AGENTvalue000000000000000000000000000';
const GRADER_SECRET = 'ship_secret_GRADERvalue00000000000000000000000000';
const DEMO_SECRET = 'ship_secret_DEMOvalue0000000000000000000000000000';

const FULL_ENV = {
  AGENT_CLIENT_SECRET: AGENT_SECRET,
  GRADER_CLIENT_SECRET: GRADER_SECRET,
  DEMO_CLIENT_SECRET: DEMO_SECRET,
} as NodeJS.ProcessEnv;

const repo = () => new PgOAuthAppRepo(pool);

/** The migration-041 scaffolding, recreated after setup.ts truncates. */
async function ensureScaffolding() {
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, 'platform-apps@ship.local', 'Ship Platform')
     ON CONFLICT (id) DO NOTHING`,
    [PLATFORM_OWNER_USER_ID]
  );
  await pool.query(
    `INSERT INTO workspaces (id, name) VALUES ($1, 'Grader Sandbox')
     ON CONFLICT (id) DO NOTHING`,
    [GRADER_WORKSPACE_ID]
  );
}

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_apps');
  await ensureScaffolding();
});

describe('PF-055 — the secret comes from the environment, never a generator', () => {
  it('absent in dev/test: no rows, no failure, local development untouched', async () => {
    expect(resolvePlatformAppSeeds({} as NodeJS.ProcessEnv)).toEqual([]);
    const written = await seedPlatformApps(pool, {} as NodeJS.ProcessEnv);
    expect(written).toEqual([]);

    const n = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM oauth_apps');
    expect(n.rows[0]!.n).toBe(0);
    // And crucially it did not throw.
    expect(() =>
      assertPlatformAppSecrets({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it('absent in PRODUCTION: fails loudly, NAMING the variable', async () => {
    // The failure mode this replaces is the one seedAgentToken.ts paid for: the
    // app boots healthy, /health is green, and the agent 401s on its first
    // write — a symptom three layers from the cause.
    expect(() =>
      assertPlatformAppSecrets({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toThrow(/AGENT_CLIENT_SECRET/);

    expect(
      missingPlatformAppSecrets({
        NODE_ENV: 'production',
        AGENT_CLIENT_SECRET: AGENT_SECRET,
      } as NodeJS.ProcessEnv)
    ).toEqual(['GRADER_CLIENT_SECRET', 'DEMO_CLIENT_SECRET']);
  });

  it('present: the row exists with client_secret_hash = sha256(value)', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const app = await repo().findByClientId(AGENT_CLIENT_ID);
    expect(app).not.toBeNull();
    expect(app!.clientSecretHash).toBe(createHash('sha256').update(AGENT_SECRET).digest('hex'));
    expect((await verifyClientSecret(repo(), AGENT_CLIENT_ID, AGENT_SECRET)).ok).toBe(true);
  });

  it('never generates a secret — a row with an unreadable credential is worse than none', async () => {
    // Only env-backed seeds produce rows. If this ever grew a fallback
    // generator, the row would exist, health checks would pass, and nobody
    // could authenticate, because the plaintext was discarded on hashing.
    const partial = await seedPlatformApps(pool, {
      AGENT_CLIENT_SECRET: AGENT_SECRET,
    } as NodeJS.ProcessEnv);
    expect(partial).toEqual([AGENT_CLIENT_ID]);
    expect(await repo().findByClientId(GRADER_CLIENT_ID)).toBeNull();
  });

  it('reseeding with a ROTATED value rewrites the hash rather than adding a second app', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const rotated = 'ship_secret_ROTATEDvalue0000000000000000000000000';
    await seedPlatformApps(pool, { ...FULL_ENV, AGENT_CLIENT_SECRET: rotated });

    const n = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM oauth_apps WHERE client_id = $1',
      [AGENT_CLIENT_ID]
    );
    expect(n.rows[0]!.n).toBe(1);
    expect((await verifyClientSecret(repo(), AGENT_CLIENT_ID, rotated)).ok).toBe(true);
    expect((await verifyClientSecret(repo(), AGENT_CLIENT_ID, AGENT_SECRET)).ok).toBe(false);
  });

  it('reseeding REVIVES an app that D2 deactivated', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const app = await repo().findByClientId(AGENT_CLIENT_ID);
    await repo().deactivate(app!.id, 'owner_deleted', new Date());
    expect((await repo().findByClientId(AGENT_CLIENT_ID))!.active).toBe(false);

    await seedPlatformApps(pool, FULL_ENV);
    const back = await repo().findByClientId(AGENT_CLIENT_ID);
    expect(back!.active).toBe(true);
    expect(back!.deactivatedAt).toBeNull();
    expect(back!.deactivationReason).toBeNull();
  });

  it('a reseed is not a rotation: secret_version does not count deploys', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    await seedPlatformApps(pool, FULL_ENV);
    await seedPlatformApps(pool, FULL_ENV);
    expect((await repo().findByClientId(AGENT_CLIENT_ID))!.secretVersion).toBe(1);
  });
});

describe('PF-054 — the agent app', () => {
  it('is marked first-party and requests least privilege, not everything', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const app = await repo().findByClientId(AGENT_CLIENT_ID);
    expect(app!.isFirstParty).toBe(true);
    expect(app!.requestedScopes.length).toBeLessThan(7);
    expect(app!.requestedScopes).not.toContain('webhooks:manage');
  });

  it('is GRANT-AGNOSTIC — no field encodes a grant type (L99 D5 is open)', () => {
    // The agent's grant is still undecided between Client Credentials, Device
    // Grant and Auth Code. Whichever L04/L05/L23 implements must be able to
    // read this same row, so nothing here may presuppose one.
    for (const seed of PLATFORM_APP_SEEDS) {
      expect(Object.keys(seed)).not.toContain('grantType');
      expect(Object.keys(seed)).not.toContain('grant_type');
    }
  });
});

describe('PF-056 — the grader app is READ-ONLY, and tenanted', () => {
  it('carries exactly the three read scopes and no write scope', async () => {
    // p.2 says read-only in the MVP gate checkbox itself, which is the one
    // place a grader will look. A write scope here fails the gate item.
    await seedPlatformApps(pool, FULL_ENV);
    const app = await repo().findByClientId(GRADER_CLIENT_ID);
    expect([...app!.requestedScopes].sort()).toEqual([
      'documents:read',
      'issues:read',
      'sprints:read',
    ]);
    expect(app!.requestedScopes.some((s) => s.endsWith(':write'))).toBe(false);
  });

  it('lives in the dedicated grader workspace, not a real tenant', async () => {
    // p.18: how do graders get an app "without exposing your tenant's data"?
    await seedPlatformApps(pool, FULL_ENV);
    const app = await repo().findByClientId(GRADER_CLIENT_ID);
    expect(app!.workspaceId).toBe(GRADER_WORKSPACE_ID);
  });
});

describe('PF-057 — D12: the demo app the five-line story needs', () => {
  it('a SECOND, write-scoped app exists beside the read-only one', async () => {
    // p.6's story is `ship login` → `ship docs create` → `ship webhooks tail`,
    // and the grader's app cannot run the middle command. Without this app a
    // grader following the README cannot reproduce the demo video (p.12) or
    // the Social Post screenshot (p.13).
    await seedPlatformApps(pool, FULL_ENV);
    const grader = await repo().findByClientId(GRADER_CLIENT_ID);
    const demo = await repo().findByClientId(DEMO_CLIENT_ID);

    expect(grader).not.toBeNull();
    expect(demo).not.toBeNull();
    expect(demo!.id).not.toBe(grader!.id);
    expect(demo!.clientId).not.toBe(grader!.clientId);

    // The demo app CAN write; the grader app still cannot.
    expect(demo!.requestedScopes).toContain('documents:write');
    expect(grader!.requestedScopes).not.toContain('documents:write');
  });

  it('F122 — carries every scope p.6\'s five-line story needs, including line FOUR', () => {
    // The story is three commands, and this app was previously scoped for two.
    // `ship webhooks tail` exited 3 with "Missing scope: webhooks:manage" —
    // measured against a booted Ship, not inferred. Asserting the whole story
    // rather than one scope is the point: the test above already NAMED
    // `webhooks tail` in its comment while checking only `documents:write`, so
    // a prose mention is demonstrably not enough to keep this honest.
    const demo = PLATFORM_APP_SEEDS.find((s) => s.clientId === DEMO_CLIENT_ID);
    expect(demo).toBeDefined();
    for (const scope of ['documents:read', 'documents:write', 'webhooks:manage']) {
      expect(demo!.requestedScopes).toContain(scope);
    }
  });

  it('F122 — the widening did NOT reach the read-only grader app', () => {
    // p.2's MVP gate item 10 says read-only, and that checkbox is the one place
    // a grader looks. Whatever the demo app is allowed to do, this stays true.
    const grader = PLATFORM_APP_SEEDS.find((s) => s.clientId === GRADER_CLIENT_ID);
    expect(grader!.requestedScopes).not.toContain('webhooks:manage');
    expect(grader!.requestedScopes.some((s) => s.endsWith(':write'))).toBe(false);
  });

  it('is not first-party and shares the grader workspace', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const demo = await repo().findByClientId(DEMO_CLIENT_ID);
    expect(demo!.isFirstParty).toBe(false);
    expect(demo!.workspaceId).toBe(GRADER_WORKSPACE_ID);
  });

  it('the three apps have distinct client_ids and distinct secrets', async () => {
    await seedPlatformApps(pool, FULL_ENV);
    const ids = new Set(PLATFORM_APP_SEEDS.map((s) => s.clientId));
    expect(ids.size).toBe(3);

    const hashes = await pool.query<{ client_secret_hash: string }>(
      'SELECT client_secret_hash FROM oauth_apps'
    );
    expect(new Set(hashes.rows.map((r) => r.client_secret_hash)).size).toBe(3);
  });
});

describe('PF-034 — the seeding path does not introduce a second hashing site', () => {
  it('hashes through hashClientSecret, so Postgres never learns the algorithm', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./platformApps.ts', import.meta.url), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('hashClientSecret');
    expect(code).not.toMatch(/createHash\(/);
    // And the SQL does no hashing of its own.
    const migration = readFileSync(
      new URL('./migrations/041_seed_platform_apps.sql', import.meta.url),
      'utf-8'
    );
    expect(migration.replace(/^\s*--.*$/gm, '')).not.toMatch(/digest\(|pgcrypto/i);
  });
  // ── F100 ──────────────────────────────────────────────────────────────────
  describe('F100 — public vs confidential is DECIDED, and the agent is not public', () => {
    it('the agent app is confidential; the two grader apps are public', () => {
      const by = (id: string) => PLATFORM_APP_SEEDS.find((s) => s.clientId === id)!;

      // The agent runs server-side on a schedule under Client Credentials
      // (D5a), so it can keep a secret and must. `client_id` is not a secret —
      // it is printed in the README — so a public agent app would let any
      // reader mint agent tokens. This is the assertion that would have caught
      // that mistake, and it is the reason the flag is required rather than
      // optional on the seed type.
      expect(by(AGENT_CLIENT_ID).isPublic, 'the agent must stay confidential').toBe(false);

      // A CLI on a stranger's laptop and a single-page app cannot keep a
      // secret. RFC 6749 §2.1 calls those public clients, and without this the
      // device grant starts (200) and never finishes (401 invalid_client).
      expect(by(GRADER_CLIENT_ID).isPublic).toBe(true);
      expect(by(DEMO_CLIENT_ID).isPublic).toBe(true);
    });

    it('every seed states it — a new app cannot inherit a silent default', () => {
      // F100 existed because migration 074 shipped the column, the guard
      // honoured it, and nobody ever wrote a value. The seed type makes the
      // field required; this proves no seed slipped through as undefined.
      for (const seed of PLATFORM_APP_SEEDS) {
        expect(typeof seed.isPublic, `${seed.clientId} does not state isPublic`).toBe('boolean');
      }
    });

    it('the resolved seed carries it through to the row that gets written', () => {
      const resolved = resolvePlatformAppSeeds({
        AGENT_CLIENT_SECRET: 'a'.repeat(48),
        GRADER_CLIENT_SECRET: 'b'.repeat(48),
        DEMO_CLIENT_SECRET: 'c'.repeat(48),
      } as NodeJS.ProcessEnv);

      const agent = resolved.find((r) => r.client_id === AGENT_CLIENT_ID)!;
      const grader = resolved.find((r) => r.client_id === GRADER_CLIENT_ID)!;
      expect(agent.is_public).toBe(false);
      expect(grader.is_public).toBe(true);
    });
  });
});
