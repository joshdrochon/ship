/**
 * PF-427 / PF-421 — the fitness clauses for the subscription store.
 *
 * Three properties that are true today and would rot silently:
 *
 *   1. Each concrete repository is constructed in exactly ONE place, and that
 *      place is the composition root. Same rule PF-037 applies to
 *      `PgOAuthAppRepo` and PF-154 to `PgTokenRepo`.
 *   2. The interface carries no Express and no `pg` in any signature — asserted
 *      by importing it in a context with neither loaded and by scanning the
 *      module's own imports, because a type-only import is invisible at runtime.
 *   3. The keyset index migration 047 ships actually satisfies L08's contract.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { scanTree } from '../../test/sourceScan.js';
import { pool } from '../../db/client.js';
import { assertKeysetIndexed } from '../api/v1/keysetIndex.js';

const SRC = join(process.cwd(), 'src');
const COMPOSITION_ROOT = join('src', 'deps.ts');

describe('PF-427 — one construction site per repository implementation', () => {
  it('constructs PgWebhookSubscriptionRepo nowhere but productionDeps()', () => {
    const offenders = scanTree(SRC)
      .filter((f) => !f.path.endsWith(COMPOSITION_ROOT))
      .filter((f) => f.code.includes('new PgWebhookSubscriptionRepo('))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('constructs InMemoryWebhookSubscriptionRepo nowhere but testDeps()', () => {
    // The in-memory double is held to the SAME rule as the Postgres one, and
    // that is deliberate: a double constructed ad hoc inside a module is a
    // second store the composition root cannot swap, which is the exact
    // failure the pair exists to prevent — just quieter.
    const offenders = scanTree(SRC)
      .filter((f) => !f.path.endsWith(COMPOSITION_ROOT))
      .filter((f) => f.code.includes('new InMemoryWebhookSubscriptionRepo('))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('PF-427 — the interface knows nothing about HTTP or node-postgres', () => {
  it('subscriptions.ts imports neither express nor pg, at type level or otherwise', () => {
    const source = readFileSync(join(SRC, 'platform', 'webhooks', 'subscriptions.ts'), 'utf8');
    // A `import type { Request } from 'express'` is erased at build time and is
    // therefore invisible to a runtime check — which is why this reads the
    // source rather than the module object.
    expect(source).not.toMatch(/from ['"]express['"]/);
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(source).not.toMatch(/from ['"]node:http['"]/);
  });

  it('imports in a bare Node context with no HTTP stack', async () => {
    // If any transitive import reached for Express, this would throw here
    // rather than mysteriously in a lane that only wanted the type.
    const mod = await import('./subscriptions.js');
    expect(typeof mod.DuplicateSubscriptionError).toBe('function');
  });
});

describe('PF-421 / PF-430 — the keyset index migration 047 ships is usable', () => {
  it('the page query on webhook_subscriptions rides an index, with no Sort', async () => {
    // L08's contract, asked of Postgres rather than of the migration file. An
    // index that exists and is not used is the failure this catches, and it is
    // invisible on a fifty-row table without `enable_seqscan = off`.
    const problems = await assertKeysetIndexed(pool, 'webhook_subscriptions');
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
  });

  it('the keyset columns are NOT NULL, so no row can be invisible to a walk', async () => {
    // F15's shape, applied here at write time rather than as a later fix:
    // `(NULL, id) < (x, y)` is NULL and a NULL predicate excludes the row, so a
    // nullable `created_at` makes a subscription vanish after page one.
    const r = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'webhook_subscriptions'
          AND column_name IN ('created_at', 'id')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.is_nullable).toBe('NO');
  });
});

describe('PF-421 — migration 047 comes from L15\'s reserved block', () => {
  it('the file is 047, not "the next free number"', () => {
    // The highest APPLIED migration is 067, so "next free" would have been 068
    // — which RESERVATIONS.md allocates to L10. Six lanes write migrations in
    // parallel against one numbered sequence and this repo already carries a
    // `024_renumber_collision_migrations.sql` from the last time.
    const sql = readFileSync(
      join(process.cwd(), 'src', 'db', 'migrations', '047_webhook_subscriptions.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS webhook_subscriptions');
  });
});
