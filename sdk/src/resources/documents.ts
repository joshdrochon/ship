/**
 * Resource client: documents. Resource-segregated (ISP) — consumers that only
 * need documents compile against exactly this surface.
 *
 * ── PF-527: the field lists are DATA, and they are the parity surface ───────
 * PRD p.10 settles the generated-vs-hand-written question in favour of
 * *"hand-written in TypeScript for quality, fitness-tested against the spec for
 * parity"*. This file is the hand-written half. The parity half needs the field
 * names at RUNTIME — a TypeScript interface evaporates at `tsc` — so every
 * projection also publishes its keys as a `readonly` tuple, and two things bind
 * the two representations together:
 *
 *   `typeProofs/resourceTypes.ts`  interface keys ≡ tuple members, at compile time
 *   `specSurfaceParity.test.ts`    tuple members ≡ spec schema properties, at test time
 *
 * Neither alone is enough. Without the type proof, someone adds a field to the
 * interface and the tuple silently disagrees; without the spec test, both agree
 * with each other and with nothing else.
 */
import type { Page } from '../pagination.js';
import type { Transport } from '../transport.js';
import { ResourceClient } from './base.js';

/**
 * Re-exported so an existing `import type { Transport } from '.../documents.js'`
 * keeps working. The definition moved to `transport.ts` in PF-495: it is the
 * contract every resource client plugs into, not a detail of this one.
 */
export type { Transport };

/**
 * The document types a `documents:read` token may see (L09's PF-250).
 *
 * `issue`, `sprint`, `program`, `project` and `person` are deliberately absent:
 * the unified document model puts them in one table, but p.3 registers a
 * separate scope for each and one scope over all of them is a leak (L99 F16).
 * Issues and sprints have their own clients below.
 */
export const PUBLIC_DOCUMENT_TYPES = [
  'wiki',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
] as const;

export type PublicDocumentType = (typeof PUBLIC_DOCUMENT_TYPES)[number];

/** The association kinds a document may declare on create. */
export const BELONGS_TO_TYPES = ['program', 'project', 'sprint', 'parent'] as const;
export type BelongsToType = (typeof BELONGS_TO_TYPES)[number];

export interface BelongsToRef {
  id: string;
  type: BelongsToType;
}

/** Every field the server's document projection carries. PF-527's parity surface. */
export const DOCUMENT_FIELDS = [
  'id',
  'document_type',
  'title',
  'parent_id',
  'created_at',
  'updated_at',
  'created_by',
] as const;

export interface ShipDocument {
  id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/**
 * Every field `POST /documents` accepts. None is required — the server defaults
 * `title` to `'Untitled'` and `document_type` to `'wiki'`.
 *
 * ⚑ `content` was on this type and is GONE. The old `CreateDocumentInput` was
 * `{ title: string; content?: string }`; the spec's request schema is
 * `.strict()` and has no `content`, so every consumer that passed one got a 422
 * naming a field the SDK's own types told them to send. Caught by PF-530's
 * signature parity, which is the ticket that exists for exactly this.
 */
export const CREATE_DOCUMENT_FIELDS = [
  'title',
  'document_type',
  'parent_id',
  'belongs_to',
  'properties',
  'visibility',
] as const;

export interface CreateDocumentInput {
  title?: string;
  document_type?: PublicDocumentType;
  parent_id?: string | null;
  belongs_to?: BelongsToRef[];
  properties?: Record<string, unknown>;
  visibility?: 'private' | 'workspace';
}

export class DocumentsClient extends ResourceClient<ShipDocument> {
  constructor(transport: Transport) {
    super(transport, '/documents');
  }

  create(input: CreateDocumentInput = {}): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('POST', this.collectionPath, { body: input });
  }
}

/** Re-declared for the doc comment above `iterate`; the implementation is shared. */
export type DocumentPage = Page<ShipDocument>;
