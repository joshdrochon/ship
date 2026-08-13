/**
 * Resource client: issues — PF-522.
 *
 * Mirrors `DocumentsClient` exactly, through the same injected `Transport` and
 * with no `fetch` of its own (PF-495's grep still passes after this file).
 *
 * ## `belongs_to`, not `sprint_id` (L99 D13)
 *
 * The public projection carries the junction rows themselves, as an array. The
 * flat `sprint_id` a consumer expects does not exist and will not: migration 027
 * dropped that column, and `document_associations`'s only uniqueness constraint
 * forbids the same pair twice — not the same issue in two sprints. A scalar
 * would have to pick one arbitrarily and publish a cardinality the schema does
 * not enforce.
 *
 *     const sprint = issue.belongs_to.find((b) => b.type === 'sprint')?.id;
 */
import type { Transport } from '../transport.js';
import type { BelongsToRef } from './documents.js';
import { ResourceClient, resourceItemPath } from './base.js';

export const ISSUE_STATES = [
  'triage',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const ISSUE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** Every field the server's issue projection carries. PF-527's parity surface. */
export const ISSUE_FIELDS = [
  'id',
  'document_type',
  'title',
  'ticket_number',
  'state',
  'priority',
  'assignee_id',
  'belongs_to',
  'created_at',
  'updated_at',
  'created_by',
] as const;

export interface ShipIssue {
  id: string;
  document_type: string;
  title: string;
  /** Null until the workspace's counter has assigned one. */
  ticket_number: number | null;
  state: IssueState;
  priority: IssuePriority;
  assignee_id: string | null;
  /** The junction rows. See the header — there is no `sprint_id`. */
  belongs_to: BelongsToRef[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** `POST /issues`. `title` is the only required field. */
export const CREATE_ISSUE_FIELDS = [
  'title',
  'state',
  'priority',
  'assignee_id',
  'belongs_to',
] as const;

export interface CreateIssueInput {
  title: string;
  state?: IssueState;
  priority?: IssuePriority;
  assignee_id?: string | null;
  belongs_to?: BelongsToRef[];
}

/** `PATCH /issues/{id}`. Every field optional — a PATCH sends what changed. */
export const UPDATE_ISSUE_FIELDS = [
  'title',
  'state',
  'priority',
  'assignee_id',
  'belongs_to',
] as const;

export interface UpdateIssueInput {
  title?: string;
  state?: IssueState;
  priority?: IssuePriority;
  assignee_id?: string | null;
  belongs_to?: BelongsToRef[];
}

export class IssuesClient extends ResourceClient<ShipIssue> {
  constructor(transport: Transport) {
    super(transport, '/issues');
  }

  create(input: CreateIssueInput): Promise<ShipIssue> {
    return this.transport.request<ShipIssue>('POST', this.collectionPath, { body: input });
  }

  update(id: string, input: UpdateIssueInput): Promise<ShipIssue> {
    return this.transport.request<ShipIssue>('PATCH', resourceItemPath(this.collectionPath, id), { body: input });
  }
}
