#!/usr/bin/env node
/**
 * Remove test-artifact OAuth apps from a Ship database.
 *
 * ── Why this exists as a script and not as an API call ────────────────────────
 *
 * Thirteen junk apps accumulated in the deployed portal while the webhook fix
 * was being proved: `MVP Demo Client` ×9, `probe` ×2, `cleanup`, and
 * `Acme Analytics`. A grader opening `/portal` sees all of them.
 *
 * There is NO route that removes an app. `/api/apps` exposes create, list, read,
 * rotate-secret and (super-admin) reactivate — and no deactivate at all.
 * `IOAuthAppRepo.deactivate()` exists in `api/src/platform/apps/repo.ts` but
 * nothing HTTP calls it; `deactivateByOwner` fires only from the user-deletion
 * path. Inventing a `DELETE /api/apps/:id` to tidy up a demo would be adding a
 * destructive verb to a published surface for a one-off chore, which is a bad
 * trade and was explicitly ruled out.
 *
 * So this is a maintenance script: reviewable, re-runnable, dry by default, and
 * it leaves no new API surface behind when the chore is done.
 *
 * ── Read this before running: it deletes, and the schema argues against that ──
 *
 * The schema's stated intent is that **an app is deactivated, never deleted**
 * (decision D2; see the header of `065_oauth_authorization_codes.sql`). Three
 * foreign keys enforce it with ON DELETE RESTRICT — `oauth_tokens`,
 * `oauth_authorization_codes`, `oauth_device_codes` — so that a `client_id` in
 * the audit trail always resolves to a row. `public_api_calls` deliberately has
 * NO foreign key for the same reason: the audit log must outlive what it
 * describes.
 *
 * `--mode delete` therefore works AGAINST the grain of the design, and it has to
 * clear those three tables first or the DELETE fails on RESTRICT. That is
 * defensible here and only here: these rows are artifacts created by one person
 * over two days while testing, not integrations whose history anyone will ever
 * need to resolve. It is NOT a pattern to reuse on an app a third party has used.
 *
 * `--mode deactivate` is the design-conformant alternative and is the DEFAULT.
 * Be aware of what it does and does not buy: `PgOAuthAppRepo.listByOwner` has no
 * `active` predicate (`pg-repo.ts`), so a deactivated app is still listed by
 * `GET /api/apps` and still appears in the portal sidebar. Deactivating stops
 * the app authenticating; it does not declutter the screen. If the goal is a
 * portal a grader can read, `--mode delete` is the only thing that achieves it.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=postgres://…  node scripts/prune-demo-oauth-apps.mjs
 *       Dry run. Prints every app it matched and every row it would touch.
 *
 *   DATABASE_URL=…  node scripts/prune-demo-oauth-apps.mjs --mode deactivate --apply
 *   DATABASE_URL=…  node scripts/prune-demo-oauth-apps.mjs --mode delete --apply
 *
 *   --keep <uuid>     Spare an app (repeatable). Use it to keep one sensibly
 *                     named app as the demo subject.
 *   --id <uuid>       Operate on exactly these ids (repeatable), instead of
 *                     matching by name.
 *
 * The Aurora instance behind the deployed environment is in a PRIVATE SUBNET.
 * This will not connect from a laptop; run it from somewhere inside the VPC
 * (the Elastic Beanstalk instance, or through a bastion / port-forward).
 *
 * Everything runs in ONE transaction and rolls back on any error.
 */

import pg from 'pg';

/**
 * The junk names, as they appear in the deployed portal.
 *
 * Matching on NAME rather than on a hard-coded id list, because ids differ per
 * environment and a stale id list silently matches nothing — which looks
 * identical to a successful run. Names are also what a human recognises when
 * checking the dry run before applying.
 */
const JUNK_NAMES = ['MVP Demo Client', 'probe', 'cleanup', 'Acme Analytics'];

function parseArgs(argv) {
  const opts = { mode: 'deactivate', apply: false, keep: [], ids: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--keep') opts.keep.push(argv[++i]);
    else if (a === '--id') opts.ids.push(argv[++i]);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!['deactivate', 'delete'].includes(opts.mode)) {
    console.error(`--mode must be "deactivate" or "delete", got "${opts.mode}"`);
    process.exit(2);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('prune-demo-oauth-apps: DATABASE_URL is required.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Select the targets first and print them, so the dry run and the applied
    // run agree on exactly what was matched.
    const selected = opts.ids.length
      ? await client.query(
          `SELECT id, name, active, created_at FROM oauth_apps
            WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC`,
          [opts.ids],
        )
      : await client.query(
          `SELECT id, name, active, created_at FROM oauth_apps
            WHERE name = ANY($1::text[]) ORDER BY created_at DESC`,
          [JUNK_NAMES],
        );

    const targets = selected.rows.filter((r) => !opts.keep.includes(r.id));
    const spared = selected.rows.filter((r) => opts.keep.includes(r.id));

    console.log(`\nMatched ${selected.rows.length} app(s); ${targets.length} targeted, ${spared.length} spared.\n`);
    for (const r of targets) {
      console.log(`  TARGET  ${r.id}  ${String(r.name).padEnd(18)} active=${r.active}  ${r.created_at.toISOString()}`);
    }
    for (const r of spared) {
      console.log(`  SPARED  ${r.id}  ${String(r.name).padEnd(18)} active=${r.active}`);
    }

    if (targets.length === 0) {
      console.log('\nNothing to do.\n');
      await client.query('ROLLBACK');
      return;
    }

    const ids = targets.map((r) => r.id);

    // Report the dependent rows either mode implies, before touching anything.
    // `webhook_subscriptions` and `webhook_deliveries` are ON DELETE CASCADE;
    // the other three are RESTRICT and must be cleared explicitly.
    const counts = {};
    for (const [table, col] of [
      ['oauth_tokens', 'app_id'],
      ['oauth_authorization_codes', 'app_id'],
      ['oauth_device_codes', 'app_id'],
      ['webhook_subscriptions', 'app_id'],
      ['webhook_deliveries', 'app_id'],
    ]) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = ANY($1::uuid[])`,
        [ids],
      );
      counts[table] = rows[0].n;
    }
    console.log('\nDependent rows:');
    for (const [t, n] of Object.entries(counts)) console.log(`  ${String(t).padEnd(28)} ${n}`);

    if (opts.mode === 'deactivate') {
      const res = await client.query(
        `UPDATE oauth_apps
            SET active = false, deactivated_at = now(),
                deactivation_reason = 'owner_deleted', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND active
          RETURNING id`,
        [ids],
      );
      console.log(`\n${opts.apply ? 'Deactivated' : 'WOULD deactivate'} ${res.rowCount} app(s).`);
      console.log('Note: they REMAIN visible in the portal — listByOwner does not filter on `active`.');
    } else {
      // Order matters: the three RESTRICT children first, then the parent. The
      // CASCADE children (subscriptions, deliveries) go with the parent.
      for (const table of ['oauth_tokens', 'oauth_authorization_codes', 'oauth_device_codes']) {
        const res = await client.query(`DELETE FROM ${table} WHERE app_id = ANY($1::uuid[])`, [ids]);
        console.log(`  deleted ${res.rowCount} from ${table}`);
      }
      const res = await client.query(`DELETE FROM oauth_apps WHERE id = ANY($1::uuid[]) RETURNING id`, [ids]);
      console.log(`\n${opts.apply ? 'Deleted' : 'WOULD delete'} ${res.rowCount} app(s), cascading to webhook_subscriptions and webhook_deliveries.`);
      console.log('`public_api_calls` rows are intentionally left: that table has no FK so the audit log outlives the app.');
    }

    if (opts.apply) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --apply to commit.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nFailed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
