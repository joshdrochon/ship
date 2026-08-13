import { beforeAll, afterAll } from 'vitest'
import { pool } from '../db/client.js'

// Test setup for API integration tests
// This runs before all tests in each test file

beforeAll(async () => {
  // Ensure test environment
  process.env.NODE_ENV = 'test'

  // Clean up test data from previous runs to prevent duplicate key errors
  // Use TRUNCATE CASCADE which is faster and bypasses row-level triggers
  // (audit_logs has AU-9 compliance triggers preventing DELETE)
  // `oauth_apps` (migration 039) is named EXPLICITLY rather than left to the
  // CASCADE from `users`. It would in fact be truncated either way — TRUNCATE
  // CASCADE reaches dependent tables regardless of ON DELETE — but this table's
  // FKs are ON DELETE RESTRICT by design (D2, PF-031), so the implicit reach is
  // the one behaviour that does not follow from reading the schema. Naming it
  // means a reader does not have to know that TRUNCATE and DELETE differ here.
  await pool.query(`TRUNCATE TABLE
    workspace_invites, sessions, files, document_links, document_history,
    comments, document_associations, document_snapshots, sprint_iterations,
    issue_iterations, documents, audit_logs, workspace_memberships,
    oauth_authorization_codes, oauth_tokens, oauth_apps, client_secret_auth_log,
    users, workspaces,
    public_api_calls, public_api_call_daily,
    webhook_subscriptions, webhook_deliveries
    CASCADE`)
})

afterAll(async () => {
  // PF-030. This used to be empty, with a comment saying vitest closed the pool
  // "at the very end ... via globalTeardown". There is no globalTeardown in
  // `api/vitest.config.ts` and there never was, so nothing closed anything.
  //
  // Vitest isolates modules per file, so each of the 145 test files builds its
  // OWN `Pool` and left it open. Postgres keeps those backends alive for
  // `idleTimeoutMillis` (30 s), and an idle backend can still hold locks. The
  // TRUNCATE in `beforeAll` above needs ACCESS EXCLUSIVE on twenty tables, so it
  // queues behind the previous files' leftovers — and when that queue outlasts
  // vitest's 10 s default hook timeout, the hook fails and takes the whole FILE
  // with it. Not one test: the file never runs.
  //
  // That is the failure that has been read as flake for days. It explains every
  // part of the shape that made it confusing: it strikes a BATCH of files at
  // once (23 in one observed run, 32 in another) because once the lock queue is
  // deep every following file inherits it; it never reproduces on a single file
  // because one file has no predecessor to queue behind; and it gets much worse
  // under load because slower teardown means more overlapping live backends.
  //
  // Closing the pool at the file boundary makes the release deterministic rather
  // than a race against a 30 s idle timer.
  await pool.end()
})
