/**
 * L26 — the grader sign-in that migration 076 seeds, and the README that
 * publishes it.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * PRD p.13 requires "a pre-registered OAuth app (read-only scopes) for graders,
 * plus credentials in the README". Those credentials live in exactly two places
 * that have no compiler between them:
 *
 *   · `076_seed_grader_user.sql` — a bcrypt HASH, opaque by construction
 *   · the root `README.md`       — the PLAINTEXT a grader will type
 *
 * Nothing else in the build can notice when those two disagree. Regenerate the
 * hash, or edit the README's password, and both files still parse, the migration
 * still applies, every other test still passes — and the one human who matters
 * gets "Invalid email or password" on a submission deadline.
 *
 * So the test is the only link: it pulls the plaintext out of the README, pulls
 * the hash out of the migration, and runs the same `bcrypt.compare` the login
 * route runs (`routes/auth.ts`). It is deliberately a FILE test rather than a
 * database test — `api/src/test/setup.ts` truncates `users` and
 * `workspace_memberships` before every spec file, so migration-seeded rows are
 * gone by the time any assertion could see them. Asserting against the files is
 * what makes this independent of that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { GRADER_WORKSPACE_ID } from './platformApps.js';

/** Repository root, from `api/src/db`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const MIGRATION = readFileSync(
  join(REPO_ROOT, 'api', 'src', 'db', 'migrations', '076_seed_grader_user.sql'),
  'utf8',
);
const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

/**
 * The migration with its `--` comment lines removed.
 *
 * This file is mostly prose, and the prose discusses the very clauses some of
 * the assertions below count. Counting the raw text made the idempotency check
 * report four `ON CONFLICT`s against three `INSERT`s — the fourth was a sentence
 * explaining the other three. Statements only, so the counts mean what they say.
 */
const MIGRATION_SQL = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const GRADER_EMAIL = 'grader@ship.local';

describe('migration 076 — the grader sign-in', () => {
  it('seeds the grader user into the Grader Sandbox workspace', () => {
    // The workspace id is imported rather than re-typed, so a change to the
    // constant that migration 041 and `platformApps.ts` share cannot leave this
    // migration pointing at a workspace that no longer exists.
    expect(MIGRATION_SQL).toContain(GRADER_WORKSPACE_ID);
    expect(MIGRATION_SQL).toContain(GRADER_EMAIL);
    expect(MIGRATION_SQL).toMatch(/INSERT INTO users/i);
    expect(MIGRATION_SQL).toMatch(/INSERT INTO workspace_memberships/i);
  });

  it('never grants the grader super-admin', () => {
    // A super-admin sees every workspace, which would forfeit exactly the
    // tenant isolation this account exists to preserve (PRD p.18). The column
    // is written explicitly in both the INSERT and the ON CONFLICT branch.
    expect(MIGRATION_SQL).toMatch(/is_super_admin\s*=\s*false/i);
    expect(MIGRATION_SQL).not.toMatch(/is_super_admin\s*=\s*true/i);
  });

  it('is idempotent, so a re-run cannot fail a deploy', () => {
    // `db:migrate` records applied versions, but a database restored from a
    // snapshot taken mid-sequence can legitimately see this file twice.
    //
    // Counted as a RATIO rather than a fixed number, so that adding a fourth
    // seeded row fails this test only if that row forgot its conflict clause.
    // The fixed-number version of this assertion broke the moment the sandbox
    // example documents were added, which is noise rather than signal.
    const inserts = MIGRATION_SQL.match(/INSERT INTO/gi) ?? [];
    const conflicts = MIGRATION_SQL.match(/ON CONFLICT/gi) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    expect(
      conflicts.length,
      'every INSERT in migration 076 needs an ON CONFLICT clause, or a re-run aborts the deploy',
    ).toBe(inserts.length);
  });

  it('publishes the same password in the README that the migration hashes', () => {
    // ── the hash, out of the migration ──────────────────────────────────────
    const hashMatch = MIGRATION_SQL.match(/'(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})'/);
    const hash = hashMatch?.[1];
    if (hash === undefined) {
      throw new Error(
        'migration 076 should contain exactly one bcrypt hash literal for the grader password',
      );
    }

    // ── the plaintext, out of the README ────────────────────────────────────
    // Matches the credentials table row: | **Password** | `grader123` |
    const pwMatch = README.match(/\|\s*\*\*Password\*\*\s*\|\s*`([^`]+)`\s*\|/);
    const password = pwMatch?.[1];
    if (password === undefined) {
      throw new Error(
        'README should publish the grader password in a `| **Password** | `…` |` table row (PRD p.13)',
      );
    }

    // ── the link between them, checked the way the login route checks it ────
    expect(
      bcrypt.compareSync(password, hash),
      `The README publishes "${password}", but migration 076's bcrypt hash does not match it. ` +
        'A grader following the README would get "Invalid email or password". ' +
        'Regenerate the hash from the published password, or correct the README.',
    ).toBe(true);
  });

  it('publishes the grader email alongside the password', () => {
    // The password is useless without the account it opens, and the two are
    // written in different table rows that can drift independently.
    expect(README).toContain(GRADER_EMAIL);
  });

  it('warns the reader that dev@ship.local is the wrong account here', () => {
    // The failure this documents is a 403 on the consent screen, which reads as
    // a broken product rather than as the tenancy guard working. If that
    // warning is ever dropped the next grader re-discovers it the slow way.
    expect(README).toMatch(/Wrong workspace/i);
  });
});
