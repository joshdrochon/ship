/**
 * `IOAuthAppRepo` and its in-memory double. PF-037 (lane L02, slice S1).
 *
 * No Express types and no `pg` types appear in any signature in this file. That
 * is the property that lets L04 (authorize + PKCE), L05 (device grant) and L06
 * (token lifecycle) be built and unit-tested against this interface before any
 * of this lane's HTTP surface exists — and it is why a unit test can import
 * this module in a bare Node context with no HTTP stack running.
 *
 * Construction is the composition root's job and nobody else's: `PgOAuthAppRepo`
 * is built in `productionDeps()` and `InMemoryOAuthAppRepo` in `testDeps()`
 * (`api/src/deps.ts`, PF-015/PF-016). A `new PgOAuthAppRepo(...)` anywhere else
 * is the bug the composition-root claim in `docs/architecture.md` exists to
 * prevent, and PF-037's fitness test fails on it.
 */
import type { Scope } from '../scopes/registry.js';
import type { OAuthApp } from './types.js';
import { digestsEqual, hashClientSecret, secretPrefix, ABSENT_APP_DIGEST } from './secrets.js';

/** Everything needed to persist a new app. The raw secret never reaches here. */
export interface CreateOAuthAppInput {
  clientId: string;
  clientSecretHash: string;
  secretPrefix: string;
  name: string;
  ownerUserId: string;
  workspaceId: string;
  redirectUris: string[];
  requestedScopes: Scope[];
  /** Only the seeding path (PF-054) sets this. */
  isFirstParty?: boolean;
}

/** D2 bookkeeping. `reason` is a machine-readable tag, not prose. */
export type DeactivationReason = 'owner_deleted' | 'admin_action';

export interface IOAuthAppRepo {
  create(input: CreateOAuthAppInput): Promise<OAuthApp>;

  /**
   * The lookup `/oauth/token` performs on every client authentication, and the
   * one L06's bearer middleware resolves a token's app through.
   *
   * Returns the app REGARDLESS of `active`, with `active` on it. Filtering
   * here would make the flag invisible to callers and would silently turn
   * "deactivated" into "never existed" — PF-052 requires the token path to see
   * the flag and decide, so that the decision is asserted at the boundary
   * rather than hidden in a query.
   */
  findByClientId(clientId: string): Promise<OAuthApp | null>;

  findById(id: string): Promise<OAuthApp | null>;

  /** PF-044: the list is owner-scoped at the repository, not at the route. */
  listByOwner(ownerUserId: string): Promise<OAuthApp[]>;

  /**
   * D3 — replaces the stored hash and bumps `secret_version`. The old secret is
   * unusable the instant this returns; there is no grace window and no second
   * live hash column that could provide one (PF-047).
   */
  rotateSecret(id: string, clientSecretHash: string, newSecretPrefix: string): Promise<OAuthApp | null>;

  deactivate(id: string, reason: DeactivationReason, at: Date): Promise<OAuthApp | null>;

  /** D2 — every app owned by the user, in one statement (PF-051). Returns the count. */
  deactivateByOwner(ownerUserId: string, at: Date): Promise<number>;

  /** PF-053 — reactivate and reassign. `newOwnerUserId` must be a live user. */
  reactivate(id: string, newOwnerUserId: string): Promise<OAuthApp | null>;
}

/**
 * PF-036 — the outcome of a client-secret verification.
 *
 * There is deliberately no `reason` field. Four inputs must be
 * indistinguishable to the caller: an unknown `client_id`, a known id with a
 * wrong secret, a known id whose app is deactivated, and a match. Anything that
 * split those apart would turn `/oauth/token` into a client-id enumerator —
 * "wrong secret" tells an attacker the id is real, which is exactly the fact
 * PF-043 refuses to disclose on the HTTP surface.
 *
 * The distinctions still exist; they go to the audit recorder (PF-050), which
 * is a server-side sink, not a response body.
 */
export type VerifyOutcome = { ok: true; app: OAuthApp } | { ok: false };

/** Why a verification failed. Never returned to a caller — audit sink only. */
export type VerifyFailureReason = 'unknown_client' | 'bad_secret' | 'app_inactive';

/**
 * PF-036 — THE ONLY client-secret verification site in the repository.
 *
 * Takes the repo rather than reaching for a module-level singleton, so it stays
 * a pure function of its inputs and L04/L05/L06 can drive it with
 * `InMemoryOAuthAppRepo` and no database.
 *
 * Constant work on every path: the presented secret is hashed and compared
 * even when no app was found (against `ABSENT_APP_DIGEST`). An early return on
 * "no such app" would make the unknown-client case measurably faster than the
 * wrong-secret case, which is the same oracle the response body is careful not
 * to be — leaked through timing instead of through JSON.
 *
 * `onAttempt` is PF-050's recording hook. It is called for every attempt,
 * including successes, because two of the three alert conditions are about
 * *successful* verifications (unusual source IPs) and about attempts against
 * deactivated apps.
 */
export async function verifyClientSecret(
  repo: IOAuthAppRepo,
  clientId: string,
  presented: string,
  onAttempt?: (result: { ok: boolean; reason?: VerifyFailureReason; app: OAuthApp | null }) => void
): Promise<VerifyOutcome> {
  const app = await repo.findByClientId(clientId);
  const presentedDigest = hashClientSecret(presented);
  const expectedDigest = app ? app.clientSecretHash : ABSENT_APP_DIGEST;

  const digestMatches = digestsEqual(presentedDigest, expectedDigest);

  let reason: VerifyFailureReason | undefined;
  if (!app) reason = 'unknown_client';
  else if (!digestMatches) reason = 'bad_secret';
  else if (!app.active) reason = 'app_inactive';

  const ok = reason === undefined;
  onAttempt?.({ ok, ...(reason ? { reason } : {}), app });

  if (!ok || !app) return { ok: false };
  return { ok: true, app };
}

/**
 * In-memory double for tests and for the lanes downstream of this one.
 *
 * Liskov-substitutable with `PgOAuthAppRepo`: same interface, same ordering
 * guarantees (newest first), same null-on-missing behaviour. Where the two
 * differ the difference is a bug in one of them, and the shared contract test
 * in `oauth-app-repo.test.ts` is what catches it.
 */
export class InMemoryOAuthAppRepo implements IOAuthAppRepo {
  private rows = new Map<string, OAuthApp>();
  private seq = 0;

  /** Test seam: deterministic ids and timestamps beat `gen_random_uuid()` here. */
  constructor(private now: () => Date = () => new Date()) {}

  async create(input: CreateOAuthAppInput): Promise<OAuthApp> {
    const at = this.now();
    this.seq += 1;
    const app: OAuthApp = {
      id: `app-${this.seq}`,
      clientId: input.clientId,
      clientSecretHash: input.clientSecretHash,
      secretPrefix: input.secretPrefix,
      secretVersion: 1,
      name: input.name,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      redirectUris: [...input.redirectUris],
      requestedScopes: [...input.requestedScopes],
      active: true,
      isFirstParty: input.isFirstParty ?? false,
      deactivatedAt: null,
      deactivationReason: null,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.set(app.id, app);
    return { ...app };
  }

  async findByClientId(clientId: string): Promise<OAuthApp | null> {
    for (const app of this.rows.values()) {
      if (app.clientId === clientId) return { ...app };
    }
    return null;
  }

  async findById(id: string): Promise<OAuthApp | null> {
    const app = this.rows.get(id);
    return app ? { ...app } : null;
  }

  async listByOwner(ownerUserId: string): Promise<OAuthApp[]> {
    return [...this.rows.values()]
      .filter((a) => a.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((a) => ({ ...a }));
  }

  async rotateSecret(
    id: string,
    clientSecretHash: string,
    newSecretPrefix: string
  ): Promise<OAuthApp | null> {
    const app = this.rows.get(id);
    if (!app) return null;
    // The old hash is overwritten, not kept alongside. D3 is enforced by the
    // absence of anywhere to put a second live secret, not by a policy check.
    app.clientSecretHash = clientSecretHash;
    app.secretPrefix = newSecretPrefix;
    app.secretVersion += 1;
    app.updatedAt = this.now();
    return { ...app };
  }

  async deactivate(id: string, reason: DeactivationReason, at: Date): Promise<OAuthApp | null> {
    const app = this.rows.get(id);
    if (!app) return null;
    app.active = false;
    app.deactivatedAt = at;
    app.deactivationReason = reason;
    app.updatedAt = at;
    return { ...app };
  }

  async deactivateByOwner(ownerUserId: string, at: Date): Promise<number> {
    let count = 0;
    for (const app of this.rows.values()) {
      if (app.ownerUserId === ownerUserId && app.active) {
        app.active = false;
        app.deactivatedAt = at;
        app.deactivationReason = 'owner_deleted';
        app.updatedAt = at;
        count += 1;
      }
    }
    return count;
  }

  async reactivate(id: string, newOwnerUserId: string): Promise<OAuthApp | null> {
    const app = this.rows.get(id);
    if (!app) return null;
    // client_id and client_secret_hash are deliberately untouched: PF-053
    // requires the audit history to stay continuous and the owner's stored
    // credential to keep working across a reactivation.
    app.active = true;
    app.ownerUserId = newOwnerUserId;
    app.deactivatedAt = null;
    app.deactivationReason = null;
    app.updatedAt = this.now();
    return { ...app };
  }
}

/** Convenience for the seeding path and tests: hash + prefix in one step. */
export function secretMaterial(raw: string): { clientSecretHash: string; secretPrefix: string } {
  return { clientSecretHash: hashClientSecret(raw), secretPrefix: secretPrefix(raw) };
}
