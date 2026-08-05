/**
 * Who is involved, with roles derived from structure (PRESEARCH.md Q5).
 *
 * ── Ship has no role column, and that is the whole design constraint ────────
 * There is no `project_members` table and no `role` field. Membership is
 * expressed by what people are attached to, so role has to be READ OUT of the
 * structure:
 *
 *   assignee       issue.properties->>'assignee_id'
 *   sprint_owner   sprint.properties->>'owner_id'
 *   project_owner  project.properties->>'owner_id'
 *   reports_to     person document -> properties->>'reports_to'
 *
 * The consequence is recorded honestly at Q6: there is no reviewer field, so a
 * review-bottleneck finding cannot route to "the reviewer". It routes to the
 * assignee, because that is the only person the schema actually names. Deriving
 * a fake reviewer from history would be inventing a fact the data does not
 * contain, and the finding would then be delivered to someone with no authority
 * to act on it.
 *
 * ── Why this runs before triage rather than after ───────────────────────────
 * Judging severity needs participants (Q16): a stalled issue owned by someone
 * on leave is a different finding from the same issue owned by someone active.
 * Fetching lazily after the gate would save one query on quiet runs and then
 * serialise it behind the model call on every run that matters.
 */
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate, Participant } from '../state.js';

type Role = Participant['roles'][number];

export function makeFetchParticipants(deps: GraphDeps) {
  return async function fetchParticipants(state: GraphStateType): Promise<GraphUpdate> {
    try {
      // One query, four role sources, unioned. Four round trips would cost more
      // than the union costs to read.
      const { rows } = await deps.db.query(
        `
        -- assignees of live issues
        SELECT (i.properties->>'assignee_id')::uuid AS user_id, 'assignee' AS role
          FROM documents i
         WHERE i.workspace_id = $1
           AND i.document_type = 'issue'
           AND i.archived_at IS NULL
           AND i.deleted_at IS NULL
           AND i.properties->>'assignee_id' IS NOT NULL

        UNION
        SELECT (s.properties->>'owner_id')::uuid, 'sprint_owner'
          FROM documents s
         WHERE s.workspace_id = $1
           AND s.document_type = 'sprint'
           AND s.deleted_at IS NULL
           AND s.properties->>'owner_id' IS NOT NULL

        UNION
        SELECT (p.properties->>'owner_id')::uuid, 'project_owner'
          FROM documents p
         WHERE p.workspace_id = $1
           AND p.document_type = 'project'
           AND p.deleted_at IS NULL
           AND p.properties->>'owner_id' IS NOT NULL

        UNION
        -- anyone named as a reporting line on a person document
        SELECT (pe.properties->>'reports_to')::uuid, 'reports_to'
          FROM documents pe
         WHERE pe.workspace_id = $1
           AND pe.document_type = 'person'
           AND pe.deleted_at IS NULL
           AND pe.properties->>'reports_to' IS NOT NULL
        `,
        [state.scope.workspaceId]
      );

      // Person documents, so a participant can be linked back to one. Separate
      // query because the join direction is the reverse of everything above:
      // there, user ids come out of properties; here we look them up.
      const { rows: personRows } = await deps.db.query(
        `SELECT id, title, (properties->>'user_id')::uuid AS user_id
           FROM documents
          WHERE workspace_id = $1
            AND document_type = 'person'
            AND deleted_at IS NULL
            AND properties->>'user_id' IS NOT NULL`,
        [state.scope.workspaceId]
      );

      const personByUser = new Map<string, { id: string; title: string }>(
        personRows.map((r) => [r.user_id as string, { id: r.id, title: r.title }])
      );

      const { rows: userRows } = await deps.db.query(
        `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
        [[...new Set(rows.map((r) => r.user_id as string))]]
      );
      const nameByUser = new Map<string, string | null>(userRows.map((r) => [r.id, r.name]));

      const byUser = new Map<string, Participant>();
      for (const r of rows) {
        const userId = r.user_id as string;
        if (!userId) continue;
        const person = personByUser.get(userId);
        const entry: Participant = byUser.get(userId) ?? {
          userId,
          personDocumentId: person?.id ?? null,
          name: nameByUser.get(userId) ?? person?.title ?? null,
          roles: [],
        };
        // A person can hold several roles at once, and often does on a small
        // team — the sprint owner is usually also an assignee. Deduped rather
        // than overwritten so the judgment prompt sees both.
        if (!entry.roles.includes(r.role as Role)) entry.roles.push(r.role as Role);
        byUser.set(userId, entry);
      }

      return { participants: [...byUser.values()] };
    } catch (err) {
      // Degrade: judging without participants produces worse severity calls,
      // not no findings. Losing the whole run over the org chart would be the
      // wrong trade.
      return {
        participants: [],
        errors: [`fetchParticipants: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}
