/**
 * Resource client: documents. Resource-segregated (ISP) — consumers that only
 * need documents compile against exactly this surface.
 */
import type { Page } from '../pagination.js';
import { paginate } from '../pagination.js';
import type { Transport } from '../transport.js';

/**
 * Re-exported so an existing `import type { Transport } from '.../documents.js'`
 * keeps working. The definition moved to `transport.ts` in PF-495: it is the
 * contract every resource client plugs into, not a detail of this one.
 */
export type { Transport };

export interface ShipDocument {
  id: string;
  title: string;
  document_type: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDocumentInput {
  title: string;
  content?: string;
}

export class DocumentsClient {
  constructor(private readonly transport: Transport) {}

  list(options: { cursor?: string; limit?: number } = {}): Promise<Page<ShipDocument>> {
    const query: Record<string, string> = {};
    if (options.cursor) query.cursor = options.cursor;
    if (options.limit) query.limit = String(options.limit);
    return this.transport.request<Page<ShipDocument>>('GET', '/documents', { query });
  }

  get(id: string): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('GET', `/documents/${encodeURIComponent(id)}`);
  }

  create(input: CreateDocumentInput): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('POST', '/documents', { body: input });
  }

  /** for await (const doc of client.documents.iterate()) { ... } */
  iterate(): AsyncGenerator<ShipDocument, void, undefined> {
    return paginate<ShipDocument>((cursor) => this.list(cursor ? { cursor } : {}));
  }
}

// TODO(josh): issues.ts, sprints.ts, webhooks.ts (subscriptions CRUD + replay)
// follow this exact shape once their /api/v1 routes land.
