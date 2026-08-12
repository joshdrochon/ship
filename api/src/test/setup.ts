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
    oauth_tokens, oauth_apps, client_secret_auth_log, users, workspaces
    CASCADE`)
})

afterAll(async () => {
  // Close pool only at the very end - vitest handles this via globalTeardown
})
