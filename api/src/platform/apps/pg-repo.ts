/**
 * `PgOAuthAppRepo` — the Postgres implementation of `IOAuthAppRepo`. PF-037.
 *
 * Constructed ONLY in `productionDeps()` (`api/src/deps.ts`). It takes a
 * `QueryRunner` rather than a `pg.Pool` so that the seeding path can hand it a
 * transaction client, and so the type stays the narrowest thing that works —
 * the same discipline `api/src/db/seedAgentToken.ts` uses.
 *
 * Every statement names its columns explicitly. `SELECT *` and `RETURNING *`
 * are both banned here for the reason L99's F17 records: an internal create
 * returning `RETURNING *` is how `yjs_state` and `deleted_at` nearly shipped to
 * external consumers. A column added to this table by a later migration must
 * be published deliberately, and an explicit list is what forces that.
 */
import type { QueryRunner } from '../../db/client.js';
import type { Scope } from '../scopes/scopes.js';
import type { OAuthApp } from './types.js';
import type {
  CreateOAuthAppInput,
  DeactivationReason,
  IOAuthAppRepo,
} from './repo.js';

/**
 * The column list, written once. Order matters only in that it must match what
 * `toDomain` reads, and both are in this file so they cannot drift apart.
 */
const COLUMNS = `
  id, client_id, client_secret_hash, secret_prefix, secret_version, name,
  owner_user_id, workspace_id, redirect_uris, requested_scopes, active,
  is_first_party, deactivated_at, deactivation_reason, created_at, updated_at
`;

/** The raw row shape as `pg` returns it. */
interface Row {
  id: string;
  client_id: string;
  client_secret_hash: string;
  secret_prefix: string;
  secret_version: number;
  name: string;
  owner_user_id: string;
  workspace_id: string;
  redirect_uris: string[];
  requested_scopes: string[];
  active: boolean;
  is_first_party: boolean;
  deactivated_at: Date | null;
  deactivation_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDomain(row: Row): OAuthApp {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    secretPrefix: row.secret_prefix,
    // `pg` returns INT as a number, but the driver's type map has surprised
    // this repo before; Number() makes the contract explicit rather than assumed.
    secretVersion: Number(row.secret_version),
    name: row.name,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    redirectUris: row.redirect_uris,
    // Widening to Scope[] is safe because PF-041 validates against the registry
    // at write time; nothing else can put a string into this column.
    requestedScopes: row.requested_scopes as Scope[],
    active: row.active,
    isFirstParty: row.is_first_party,
    deactivatedAt: row.deactivated_at,
    deactivationReason: row.deactivation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgOAuthAppRepo implements IOAuthAppRepo {
  constructor(private db: QueryRunner) {}

  async create(input: CreateOAuthAppInput): Promise<OAuthApp> {
    const result = await this.db.query<Row>(
      `INSERT INTO oauth_apps
         (client_id, client_secret_hash, secret_prefix, name,
          owner_user_id, workspace_id, redirect_uris, requested_scopes, is_first_party)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        input.clientId,
        input.clientSecretHash,
        input.secretPrefix,
        input.name,
        input.ownerUserId,
        input.workspaceId,
        input.redirectUris,
        input.requestedScopes,
        input.isFirstParty ?? false,
      ]
    );
    const row = result.rows[0];
    // `noUncheckedIndexedAccess` makes this a real check, not a formality: an
    // INSERT ... RETURNING that produced no row means the statement did not do
    // what it claimed, and silently returning undefined would surface three
    // frames later as "cannot read clientId of undefined".
    if (!row) throw new Error('oauth_apps insert returned no row');
    return toDomain(row);
  }

  async findByClientId(clientId: string): Promise<OAuthApp | null> {
    // No `AND active` filter, on purpose — see IOAuthAppRepo.findByClientId.
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_apps WHERE client_id = $1`,
      [clientId]
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async findById(id: string): Promise<OAuthApp | null> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_apps WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async listByOwner(ownerUserId: string): Promise<OAuthApp[]> {
    // (created_at DESC, id DESC) matches idx_oauth_apps_owner and is the stable
    // order a cursor would page over. created_at alone is not unique.
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_apps
       WHERE owner_user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [ownerUserId]
    );
    return result.rows.map(toDomain);
  }

  async rotateSecret(
    id: string,
    clientSecretHash: string,
    newSecretPrefix: string
  ): Promise<OAuthApp | null> {
    // D3 — instant invalidation. This is an overwrite, not an append: there is
    // no second hash column, so no grace period is representable in the schema.
    // That is the point. A future grace period is a migration plus a policy
    // change, and `rotation_policy` (types.ts) is the value that would have to
    // change with it.
    const result = await this.db.query<Row>(
      `UPDATE oauth_apps
          SET client_secret_hash = $2,
              secret_prefix      = $3,
              secret_version     = secret_version + 1,
              updated_at         = now()
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, clientSecretHash, newSecretPrefix]
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async deactivate(id: string, reason: DeactivationReason, at: Date): Promise<OAuthApp | null> {
    const result = await this.db.query<Row>(
      `UPDATE oauth_apps
          SET active = false, deactivated_at = $3, deactivation_reason = $2, updated_at = $3
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, reason, at]
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  async deactivateByOwner(ownerUserId: string, at: Date): Promise<number> {
    // D2 — one statement, so a user-delete path cannot deactivate half an
    // owner's apps and then fail. `AND active` keeps deactivated_at at the
    // first deactivation rather than refreshing it on every re-run.
    const result = await this.db.query<Row>(
      `UPDATE oauth_apps
          SET active = false, deactivated_at = $2,
              deactivation_reason = 'owner_deleted', updated_at = $2
        WHERE owner_user_id = $1 AND active
       RETURNING ${COLUMNS}`,
      [ownerUserId, at]
    );
    return result.rows.length;
  }

  async reactivate(id: string, newOwnerUserId: string): Promise<OAuthApp | null> {
    // client_id and client_secret_hash untouched (PF-053): the audit trail's
    // client_id stays resolvable and the owner's stored credential still works.
    // The FK on owner_user_id is what enforces "a live owner" — reassigning to
    // a deleted user fails here rather than producing the orphan state D2 was
    // chosen to avoid.
    const result = await this.db.query<Row>(
      `UPDATE oauth_apps
          SET active = true, owner_user_id = $2,
              deactivated_at = NULL, deactivation_reason = NULL, updated_at = now()
        WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, newOwnerUserId]
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }
}
