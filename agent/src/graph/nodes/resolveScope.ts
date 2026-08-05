/**
 * Turn the invocation into a concrete scope the fetch nodes can query.
 *
 * ── Proactive: the scope is already the answer ──────────────────────────────
 * A workspace id is all the detectors need; they find their own targets. This
 * node passes it through and captures `scannedThrough`.
 *
 * ── Why scannedThrough is captured HERE, at the top ─────────────────────────
 * It is the upper bound of the window this run covers, and it must be taken
 * BEFORE any detector query runs. Taking it at `deliver` instead would move it
 * past every row written while the run executed, and those rows would be
 * skipped forever with nothing to show they were missed. Same reasoning as
 * `runDetectors`, hoisted a level so the value that gets committed to the
 * watermark is provably the one the scan used (Q24).
 *
 * ── On-demand: resolve the document and its neighbourhood ───────────────────
 * The chat endpoint sends a document id, a type, and the active tab — route
 * params, never rendered content (Q7). So this node has to turn that id into
 * the context an answer needs: the document itself, what it is associated with,
 * what recently happened to it, and who is involved.
 *
 * That last part is why this node exists rather than letting the answer prompt
 * do a lookup: the model receives facts, never a query interface (Q31).
 */
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export interface ResolvedDocument {
  id: string;
  title: string;
  documentType: string;
  properties: Record<string, unknown>;
  associations: Array<{ relatedId: string; relationshipType: string; title: string | null }>;
  recentHistory: Array<{ field: string; from: string | null; to: string | null; at: Date }>;
}

export function makeResolveScope(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function resolveScope(state: GraphStateType): Promise<GraphUpdate> {
    // Before anything is queried. See the header.
    const scannedThrough = now();

    if (state.mode !== 'on_demand') {
      return { scannedThrough };
    }

    const documentId = state.scope.documentId!;

    // The document itself.
    const { rows: docRows } = await deps.db.query(
      `SELECT id, title, document_type, properties
         FROM documents
        WHERE id = $1
          AND workspace_id = $2
          AND deleted_at IS NULL`,
      [documentId, state.scope.workspaceId]
    );

    if (docRows.length === 0) {
      // Not an exception: a user can navigate to a document they cannot read,
      // or one that was just deleted. The answer node degrades to saying so.
      return {
        scannedThrough,
        errors: [`document ${documentId} not found in workspace ${state.scope.workspaceId}`],
      };
    }

    const doc = docRows[0];

    // What it is attached to. Both directions — a sprint's issues and an
    // issue's sprint are the same row read from opposite ends, and a question
    // about either needs the other.
    const { rows: assocRows } = await deps.db.query(
      `SELECT da.related_id, da.relationship_type, d.title
         FROM document_associations da
         LEFT JOIN documents d ON d.id = da.related_id
        WHERE da.document_id = $1
        UNION ALL
       SELECT da.document_id, da.relationship_type, d.title
         FROM document_associations da
         LEFT JOIN documents d ON d.id = da.document_id
        WHERE da.related_id = $1`,
      [documentId]
    );

    // Recent history. Bounded deliberately: an answer grounded in the last ten
    // changes is useful, one grounded in four hundred is a token bill.
    //
    // Absence here proves nothing. `document_history` has coverage holes — some
    // write paths do not log, and `POST /api/issues/bulk` bypasses it entirely
    // (Q4). An empty result means "no recorded changes", never "no changes".
    const { rows: histRows } = await deps.db.query(
      // The column is `field`, not `field_name` (schema.sql:228).
      `SELECT field, old_value, new_value, created_at
         FROM document_history
        WHERE document_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [documentId]
    );

    const resolved: ResolvedDocument = {
      id: doc.id,
      title: doc.title,
      documentType: doc.document_type,
      properties: doc.properties ?? {},
      associations: assocRows.map((r) => ({
        relatedId: r.related_id ?? r.document_id,
        relationshipType: r.relationship_type,
        title: r.title,
      })),
      recentHistory: histRows.map((r) => ({
        field: r.field,
        from: r.old_value,
        to: r.new_value,
        at: r.created_at,
      })),
    };

    return {
      scannedThrough,
      scope: { ...state.scope, documentType: resolved.documentType },
      // Carried as a message so the answer prompt receives it as stated facts
      // rather than reaching for it. See Q31.
      messages: [{ role: 'agent' as const, content: JSON.stringify({ document: resolved }) }],
    };
  };
}
