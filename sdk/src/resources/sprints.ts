/**
 * Resource client: sprints — PF-523.
 *
 * ## The public noun is `sprints`, and this package knows no other one
 *
 * p.3 registers `sprints:read` / `sprints:write`; p.4 lists `client.sprints`;
 * p.7's interface sketch writes `readonly sprints: SprintsClient`. The path is
 * `/api/v1/sprints`.
 *
 * Ship's INTERNAL HTTP path for the same documents is a different noun, and
 * exactly one file in the whole repository is allowed to know that:
 * `api/src/platform/scopes/resource-map.ts` (L03's PF-077), with a fitness test
 * asserting the internal spelling appears in no other platform file (PF-078).
 * The SDK is on the far side of that map and is an external package that cannot
 * import `api/src/` at all — so the internal noun must appear NOWHERE under
 * `sdk/`. `sprintsNaming.test.ts` greps for it.
 *
 * A leaked internal noun in a published package is a contract bug that cannot be
 * taken back: it ends up in a consumer's code, in a support thread, and in a
 * search index.
 */
import type { Transport } from '../transport.js';
import { ResourceClient, resourceItemPath } from './base.js';

/** The three statuses a sprint transitions between. */
export const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

/** Every field the server's sprint projection carries. PF-527's parity surface. */
export const SPRINT_FIELDS = [
  'id',
  'document_type',
  'title',
  'sprint_number',
  'status',
  'start_date',
  'end_date',
  'owner_id',
  'program_id',
  'created_at',
  'updated_at',
  'created_by',
] as const;

export interface ShipSprint {
  id: string;
  document_type: string;
  title: string;
  sprint_number: number;
  /**
   * DERIVED server-side, and read-only on the wire. Move it with `update()`,
   * which is a transition endpoint rather than a general PATCH.
   */
  status: SprintStatus;
  start_date: string | null;
  end_date: string | null;
  owner_id: string | null;
  program_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** `POST /sprints`. `sprint_number` is the only required field. */
export const CREATE_SPRINT_FIELDS = ['sprint_number', 'title', 'owner_id', 'program_id'] as const;

export interface CreateSprintInput {
  sprint_number: number;
  title?: string;
  owner_id?: string | null;
  program_id?: string | null;
}

/**
 * `PATCH /sprints/{id}` — a TRANSITION, not a general update.
 *
 * `status` is the only field and it is required: an empty-body PATCH on a
 * transition endpoint has no meaning, and the server's schema says so.
 */
export const UPDATE_SPRINT_FIELDS = ['status'] as const;

export interface UpdateSprintInput {
  status: SprintStatus;
}

export class SprintsClient extends ResourceClient<ShipSprint> {
  constructor(transport: Transport) {
    super(transport, '/sprints');
  }

  create(input: CreateSprintInput): Promise<ShipSprint> {
    return this.transport.request<ShipSprint>('POST', this.collectionPath, { body: input });
  }

  update(id: string, input: UpdateSprintInput): Promise<ShipSprint> {
    return this.transport.request<ShipSprint>('PATCH', resourceItemPath(this.collectionPath, id), { body: input });
  }
}
