/**
 * Trigger-state builders for detector tests.
 *
 * Ship's seed data triggers nothing: no issue has sat in `in_progress` for five
 * business days without moving, no sprint is two days from its end with unstarted
 * work. Every detector test therefore has to CONSTRUCT the condition it detects.
 *
 * Built once, here, rather than inline per test, for two reasons. Each detector
 * needs the same primitives, and the Test Cases table due at Early Submission
 * (FG-222..FG-227) needs "the Ship state that should trigger the agent" written
 * down as something executable rather than described in prose.
 *
 * `updated_at` is set explicitly on every insert. It has a default of now(), and
 * the whole point of most of these fixtures is that it is OLD.
 */
import type { Pool } from 'pg';

export interface Workspace {
  workspaceId: string;
  ownerId: string;
}

/** Calendar days back from a reference point, as a timestamp. */
export function daysAgo(n: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - n * 86_400_000);
}

export async function createWorkspace(db: Pool, name: string): Promise<Workspace> {
  const ws = await db.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [name]);
  const workspaceId = ws.rows[0].id;
  const u = await db.query(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`owner-${workspaceId.slice(0, 8)}@test.local`, 'Owner'],
  );
  return { workspaceId, ownerId: u.rows[0].id };
}

export async function createUser(db: Pool, email: string, name: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  return rows[0].id;
}

export interface IssueSpec {
  title?: string;
  state?: 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  assigneeId?: string | null;
  priority?: string;
  /** How long ago it was last touched. This is what the detectors measure. */
  updatedDaysAgo?: number;
  startedDaysAgo?: number | null;
  reopenedDaysAgo?: number | null;
  archived?: boolean;
  deleted?: boolean;
}

export async function createIssue(
  db: Pool,
  ws: Workspace,
  spec: IssueSpec = {},
): Promise<string> {
  const {
    title = 'Test issue',
    state = 'in_progress',
    assigneeId = null,
    priority = 'medium',
    updatedDaysAgo = 0,
    startedDaysAgo = null,
    reopenedDaysAgo = null,
    archived = false,
    deleted = false,
  } = spec;

  const { rows } = await db.query(
    `INSERT INTO documents
       (workspace_id, document_type, title, properties, created_by,
        created_at, updated_at, started_at, reopened_at, archived_at, deleted_at)
     VALUES ($1, 'issue', $2,
             jsonb_build_object('state', $3::text, 'assignee_id', $4::text, 'priority', $5::text),
             $6, $7, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      ws.workspaceId,
      title,
      state,
      assigneeId,
      priority,
      ws.ownerId,
      daysAgo(updatedDaysAgo),
      startedDaysAgo === null ? null : daysAgo(startedDaysAgo),
      reopenedDaysAgo === null ? null : daysAgo(reopenedDaysAgo),
      archived ? new Date() : null,
      deleted ? new Date() : null,
    ],
  );
  return rows[0].id;
}

export interface SprintSpec {
  title?: string;
  /** Negative means the end date is in the past. */
  endsInDays?: number;
  ownerId?: string | null;
  sprintNumber?: number;
}

export async function createSprint(db: Pool, ws: Workspace, spec: SprintSpec = {}): Promise<string> {
  const { title = 'Week 32', endsInDays = 2, ownerId = null, sprintNumber = 32 } = spec;
  const end = new Date(Date.now() + endsInDays * 86_400_000);
  const start = new Date(end.getTime() - 7 * 86_400_000);

  const { rows } = await db.query(
    `INSERT INTO documents
       (workspace_id, document_type, title, properties, created_by, created_at, updated_at)
     VALUES ($1, 'sprint', $2,
             jsonb_build_object(
               'start_date', $3::text,
               'end_date', $4::text,
               'owner_id', $5::text,
               'sprint_number', $6::int
             ),
             $7, NOW(), NOW())
     RETURNING id`,
    [
      ws.workspaceId,
      title,
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
      ownerId,
      sprintNumber,
      ws.ownerId,
    ],
  );
  return rows[0].id;
}

/**
 * Attach an issue to a sprint.
 *
 * Via `document_associations`, never the legacy columns — `sprint_id` was
 * dropped by migration 027 and `program_id`/`project_id` by 029. A detector
 * reading those would find nothing and report a clean sprint.
 */
export async function attachToSprint(
  db: Pool,
  issueId: string,
  sprintId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, 'sprint')`,
    [issueId, sprintId],
  );
}

export async function createProject(
  db: Pool,
  ws: Workspace,
  opts: { title?: string; ownerId?: string | null } = {},
): Promise<string> {
  const { title = 'Platform', ownerId = null } = opts;
  const { rows } = await db.query(
    `INSERT INTO documents
       (workspace_id, document_type, title, properties, created_by, created_at, updated_at)
     VALUES ($1, 'project', $2, jsonb_build_object('owner_id', $3::text), $4, NOW(), NOW())
     RETURNING id`,
    [ws.workspaceId, title, ownerId, ws.ownerId],
  );
  return rows[0].id;
}

export async function attachToProject(
  db: Pool,
  documentId: string,
  projectId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, 'project')`,
    [documentId, projectId],
  );
}

/** A `state` transition in document_history — what rework churn counts. */
export async function recordStateChange(
  db: Pool,
  documentId: string,
  from: string,
  to: string,
  userId: string,
  daysAgoValue = 1,
): Promise<void> {
  await db.query(
    `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by, created_at)
     VALUES ($1, 'state', $2, $3, $4, $5)`,
    [documentId, from, to, userId, daysAgo(daysAgoValue)],
  );
}
