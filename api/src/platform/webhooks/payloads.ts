/**
 * Domain row → event payload. The one place a `documents` row becomes an event.
 *
 * Tickets: PF-404, PF-406, PF-407, PF-408 (D7), PF-409.
 *
 * ## Why this is a module and not four inline object literals
 *
 * Five write paths publish events — document create/update/delete, the issue
 * PATCH diff, and the two sprint transitions. If each built its own payload,
 * "what a `document.created` contains" would be a fact stored in five places,
 * and D7 would be re-decided by whoever wrote the fifth. The builders here are
 * the only thing that reads a row and produces `data`, so the decision has one
 * home and the registry's schemas validate one shape.
 *
 * ## The document-type gate, which is load-bearing
 *
 * `documentService.create` serves BOTH surfaces, and the internal one creates
 * every `document_type` Ship has — `wiki`, `issue`, `sprint`, `program`,
 * `project`, `person`. The public `documents` resource serves only the narrative
 * subset (`PUBLIC_DOCUMENT_TYPES`, L09's PF-250, finding F16).
 *
 * So `document.created` fires for a document on the public `documents` resource
 * and not for every row that lands in the table. An `issue` gets `issue.created`
 * — a different event with a different producer and its own scope. A `program`,
 * `project` or `person` gets nothing, because there is no public resource for it
 * this week and a subscriber could not `GET` it either. Publishing an event a
 * subscriber cannot resolve is the failure F10 is about, arrived at from the
 * other direction.
 *
 * This is enforced rather than documented: `documentEventPayload` returns `null`
 * for a type outside the set, and the caller skips the publish. Without the gate
 * the internal create of an issue would fail registry validation and take the
 * write down with it — `document_type` in the payload schema is
 * `z.enum(PUBLIC_DOCUMENT_TYPES)`, so it would not merely be wrong, it would
 * throw.
 */
import {
  PUBLIC_DOCUMENT_TYPES,
  type PublicDocumentType,
} from '../api/v1/documents/documents.schema.js';

/** A row as the domain hands it back — wide, and read defensively here. */
export interface EventSourceRow {
  id: string;
  document_type: string;
  title: string;
  parent_id?: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  created_by?: string | null;
  visibility?: string | null;
  ticket_number?: number | null;
  properties?: Record<string, unknown> | null;
  [column: string]: unknown;
}

/** Whether a `document_type` belongs to the public `documents` resource. */
export function isPublicDocumentType(documentType: string): documentType is PublicDocumentType {
  return (PUBLIC_DOCUMENT_TYPES as readonly string[]).includes(documentType);
}

/**
 * Timestamps go out as ISO-8601 strings.
 *
 * `created_at`/`updated_at` are NOT NULL as of migration 060 (finding F15), so a
 * null here is a domain bug rather than a data condition — but an event builder
 * is the wrong place to throw, because that would fail a write that already
 * committed. It falls back to the current instant and the schema still passes;
 * the row-level guarantee is the projection's job to enforce, not this one's.
 */
function iso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  return new Date().toISOString();
}

function visibilityOf(row: EventSourceRow): 'private' | 'workspace' {
  // The column defaults to 'workspace' (`schema.sql`), and anything unexpected
  // is treated as private. Failing CLOSED matters here: this field is what
  // L15's matcher gates delivery on, and a row whose visibility we could not
  // read is exactly the row not to fan out.
  return row.visibility === 'private' ? 'private' : row.visibility === 'workspace' ? 'workspace' : 'private';
}

/**
 * `document.created` / `document.updated` data — the public API representation
 * plus `visibility`. See the D7 note in `events.ts`.
 *
 * Returns `null` when the row is not on the public `documents` resource, which
 * the caller reads as "no event for this write".
 */
export function documentEventPayload(row: EventSourceRow): Record<string, unknown> | null {
  if (!isPublicDocumentType(row.document_type)) return null;
  return {
    id: row.id,
    document_type: row.document_type,
    title: row.title,
    parent_id: row.parent_id ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by ?? null,
    visibility: visibilityOf(row),
  };
}

/**
 * `document.deleted` data — PF-409, and the reason D7 could never have been
 * "ids only" universally.
 *
 * `DELETE FROM documents … RETURNING id` is a HARD delete (finding F10). The
 * row is gone the instant the statement returns, so a subscriber's follow-up
 * `GET` returns 404 forever and **this envelope is the only surviving record of
 * the document**. Every field must therefore be captured from the row read
 * BEFORE the delete — which is what the `row` argument is, and why the domain
 * service does a `SELECT` it would not otherwise need.
 *
 * `deletedAt` is the moment the domain observed the deletion. It is a parameter
 * rather than a column read because there is no `deleted_at` value to read: this
 * path does not use the soft-delete column.
 */
export function documentDeletedPayload(
  row: EventSourceRow,
  deletedAt: string,
): Record<string, unknown> | null {
  const base = documentEventPayload(row);
  if (!base) return null;
  return { ...base, deleted_at: deletedAt };
}

/**
 * `issue.*` data. Issues live in `documents` with `document_type='issue'` and
 * carry `state`/`priority`/`assignee_id` in the `properties` JSONB.
 */
export function issueEventPayload(row: EventSourceRow): Record<string, unknown> {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    id: row.id,
    document_type: 'issue',
    title: row.title,
    ticket_number: typeof row.ticket_number === 'number' ? row.ticket_number : null,
    state: str(props.state),
    priority: str(props.priority),
    assignee_id: str(props.assignee_id),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by ?? null,
    visibility: visibilityOf(row),
  };
}

/** `sprint.*` data. Sprints are `documents` rows with `document_type='sprint'`. */
export function sprintEventPayload(
  row: EventSourceRow,
  status: 'planning' | 'active' | 'completed',
): Record<string, unknown> {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const sprintNumber = props.sprint_number;
  return {
    id: row.id,
    document_type: 'sprint',
    title: row.title,
    sprint_number: typeof sprintNumber === 'number' ? sprintNumber : null,
    status,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by ?? null,
    visibility: visibilityOf(row),
  };
}
