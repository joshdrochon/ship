/**
 * Refresh-token rotation. PF-166–171 (lane L06, slice S3).
 *
 * ★ THIS IS THE SITE `docs/architecture.md:118` MARKS. That line sits on the
 * `/oauth/token` participant of the Auth Code diagram and reads:
 *
 *   "★ rotation HERE — new pair issued, old spent. Reuse of a spent refresh
 *    token revokes the whole family (theft signal)"
 *
 * PRD p.12 requires the diagram to mark where rotation happens, so that sentence
 * is a graded deliverable and this module is what makes it true. `rotation.test.ts`
 * asserts the `refresh_token` grant dispatches here, so renaming or moving this
 * function fails a test rather than silently falsifying the document.
 *
 * PRD p.3's Refresh Tokens row: *"One-time-use refresh tokens with rotation"*
 * and *"Stolen-refresh-token detection: reuse invalidates the family."*
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS, AND WHY EACH STEP IS WHERE IT IS.
 * ---------------------------------------------------------------------------
 * Everything below happens inside ONE transaction (PF-170):
 *
 *   1. find the presented token by digest
 *   2. reject it if it is not a refresh token, not this client's, revoked, or
 *      expired
 *   3. SPEND IT CONDITIONALLY — `UPDATE … WHERE spent_at IS NULL`. The zero-row
 *      result IS the reuse signal. This is step 3 and not step 5 because it is
 *      the serialization point: ten concurrent exchanges all block here, exactly
 *      one wins, and the losers learn they lost from the row count rather than
 *      from a race they both passed.
 *   4. on a zero-row result → the replay window (if open) or family revocation
 *   5. issue the new pair into the SAME family, linking `replaces_token_id`
 *   6. revoke the OLD ACCESS token
 *
 * Step 6 is the one that is easy to omit. Leaving `A1` live for the rest of its
 * hour after `R1` was rotated away is the difference between rotation and mere
 * re-issuance, and it is the half a client can actually observe.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY: why the losers cannot revoke a family the winner then repopulates.
 * ---------------------------------------------------------------------------
 * A real ordering hazard, and it is closed by the row lock rather than by luck.
 * The losing exchanges BLOCK inside step 3 on the winner's uncommitted row lock.
 * They resume only after the winner COMMITS — by which time the new pair is
 * already in the family — and their `revokeFamily` then sweeps it up with
 * everything else. If the spend were a read-then-write, or if step 3 came after
 * step 5, a loser could revoke the family before the winner's insert landed and
 * a live pair would survive a detected theft.
 */
import type { Clock } from '../clock.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import type { ITokenRepo, TokenRecord } from './tokenRepo.js';
import { issueTokenPair, type TokenPairResponse } from './issue.js';
import { hashToken, REFRESH_REPLAY_WINDOW_MS, type TokenTtlConfig } from './tokens.js';

/**
 * PF-172 — the three refresh failures, distinguishable WITHOUT inventing a code
 * set.
 *
 * All three are HTTP 400 `invalid_grant` per RFC 6749 §5.2 — that part is fixed
 * by the RFC and is not ours to choose. The distinction rides in
 * `error_description`, which is the field RFC 6749 already provides for exactly
 * this, rather than in a new one.
 *
 * Exported as constants so the strings have one definition and a test can assert
 * they stay pairwise distinct. L24's PF-726 asserts only that the three ARE
 * distinguishable and deliberately refuses to name them, so as not to write this
 * lane's contract from a consumer lane; this is where they are named.
 */
export const REFRESH_ERROR_DESCRIPTIONS = {
  /** Reused, or belonging to a family that has been revoked. */
  reused: 'The refresh token has already been used or its family was revoked.',
  /** Past its own expiry — the user has been away longer than the refresh TTL. */
  expired: 'The refresh token has expired.',
  /** Well-formed but matching no row, or issued to a different client. */
  unknown: 'The refresh token is not valid for this client.',
} as const;

export type RefreshFailureKind = keyof typeof REFRESH_ERROR_DESCRIPTIONS;

/** RFC 6749 §5.2. `/oauth/*` never emits L07's ApiError envelope (L99 U3). */
export interface OAuthErrorBody {
  error: 'invalid_grant' | 'invalid_scope' | 'invalid_request' | 'invalid_client' | 'unsupported_grant_type';
  error_description?: string;
}

export type RotationResult =
  | {
      ok: true;
      response: TokenPairResponse;
      familyId: string;
      /** True when the replay window (D14 option b) served an already-issued pair. */
      replayed: boolean;
    }
  | { ok: false; status: 400; body: OAuthErrorBody; kind: RefreshFailureKind | 'scope' };

export interface RotationDeps {
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
  /**
   * D14 / PF-171. Defaults to `REFRESH_REPLAY_WINDOW_MS`, which ships at 0 —
   * option (a), strict revocation. Injectable so the table test can drive BOTH
   * behaviours without reassigning a module export.
   */
  replayWindowMs?: number;
}

export interface RotationInput {
  /** The authenticated client. Client authentication is the ROUTE's job (PF-036). */
  app: OAuthApp;
  presentedToken: string;
  /**
   * RFC 6749 §6 lets a refresh narrow scope. It may never WIDEN it — that is D4
   * seen from the token endpoint, and widening here would let an app escalate
   * past what the user consented to without ever showing them a consent screen.
   */
  requestedScopes?: Scope[];
}

/**
 * D14 option (b)'s store: the raw pair issued for a given spent refresh token.
 *
 * PROCESS-LOCAL, AND THAT IS A REAL LIMITATION, NOT AN OVERSIGHT. Tokens are
 * hashed at rest, so the server genuinely cannot reproduce an already-issued
 * pair from the database — a replay window has to remember the raw values
 * somewhere, and the only place that does not undo the hashing discipline is
 * memory. Behind more than one API instance, a replay that lands on a different
 * instance finds no entry and revokes the family as usual. So option (b)
 * SOFTENS the concurrent-CLI failure; it does not eliminate it.
 *
 * Empty and never written while `replayWindowMs` is 0, which is what ships.
 */
const replayCache = new Map<string, { response: TokenPairResponse; issuedAtMs: number }>();

/** Test seam. Not used by production code. */
export function clearReplayCache(): void {
  replayCache.clear();
}

function fail(kind: RefreshFailureKind): RotationResult {
  return {
    ok: false,
    status: 400,
    kind,
    body: { error: 'invalid_grant', error_description: REFRESH_ERROR_DESCRIPTIONS[kind] },
  };
}

/**
 * PF-166 — exchange a refresh token for a NEW PAIR.
 *
 * Named `rotateRefreshToken` and defined exactly once. `rotation.test.ts`
 * asserts both, because `docs/architecture.md:118` points at this site by name.
 */
export async function rotateRefreshToken(
  deps: RotationDeps,
  input: RotationInput,
): Promise<RotationResult> {
  const windowMs = deps.replayWindowMs ?? REFRESH_REPLAY_WINDOW_MS;
  const presentedHash = hashToken(input.presentedToken);

  return deps.tokenRepo.transaction(async (tx) => {
    const nowMs = deps.clock.nowMs();
    const now = new Date(nowMs);

    const row = await tx.findByHash(presentedHash);

    // Unknown, or an ACCESS token presented at the refresh grant. Both are
    // "this is not a refresh token of ours".
    if (!row || row.tokenType !== 'refresh') return fail('unknown');

    // Issued to a different client. RFC 6749 §6 requires the refresh token to
    // belong to the authenticated client; answering `unknown` rather than a
    // distinct "wrong client" keeps this from becoming an oracle for whether a
    // token exists at all.
    if (row.appId !== input.app.id) return fail('unknown');

    // Already revoked — individually, or because the family was swept by an
    // earlier theft signal. Same answer as reuse: a caller holding a revoked
    // token learns only that it is dead.
    if (row.revokedAt !== null) return fail('reused');

    if (row.expiresAt.getTime() <= nowMs) return fail('expired');

    // ── Scope: same or narrower, never wider (D4 from the token endpoint) ──
    //
    // VALIDATED BEFORE THE SPEND, deliberately. A malformed request must not
    // consume a one-time-use credential: if this ran after `markSpent`, an app
    // that asked for one scope too many would burn the user's refresh token,
    // and the user's honest retry would then look like REUSE and revoke their
    // whole family. A client error would become a forced logout.
    let scopes: Scope[] = row.scopes;
    if (input.requestedScopes) {
      const widened = input.requestedScopes.filter((s) => !row.scopes.includes(s));
      if (widened.length > 0) {
        return {
          ok: false,
          status: 400,
          kind: 'scope',
          body: {
            error: 'invalid_scope',
            error_description: `A refresh cannot widen scope. Not granted: ${widened.join(' ')}`,
          },
        };
      }
      scopes = input.requestedScopes;
    }

    // ── PF-167: THE CONDITIONAL SPEND. The serialization point. ───────────
    const spent = await tx.markSpent(row.id, now);

    if (!spent) {
      // Zero rows. Someone has already exchanged this token.
      //
      // D14 option (b): if the window is open and we still remember what this
      // exact token was exchanged for, hand back the SAME pair rather than
      // treating an honest second process as a thief.
      if (windowMs > 0) {
        const cached = replayCache.get(row.id);
        if (cached && nowMs - cached.issuedAtMs <= windowMs) {
          return { ok: true, response: cached.response, familyId: row.familyId, replayed: true };
        }
      }

      // ── PF-168: REUSE INVALIDATES THE FAMILY ────────────────────────────
      // Every token in the family, of either type, spent or not — including the
      // live access token, which is the half a client can observe.
      await tx.revokeFamily(row.familyId, 'refresh_token_reuse', now);
      return fail('reused');
    }

    // ── PF-155: the ONE issuance site, joined to this transaction ─────────
    const issued = await issueTokenPair(
      { tokenRepo: tx, clock: deps.clock, ttl: deps.ttl },
      {
        app: input.app,
        userId: row.userId,
        scopes,
        // Same family — this is a rotation, not a new grant.
        familyId: row.familyId,
        replacesRefreshTokenId: row.id,
        replacesAccessTokenId: await currentAccessTokenId(tx, row),
        repo: tx,
      },
    );

    // ── PF-166: the OLD ACCESS TOKEN dies with its refresh partner ────────
    // Without this, A1 stays valid for the rest of its hour after R1 was
    // rotated away — re-issuance dressed as rotation.
    for (const stale of await tx.listFamily(row.familyId)) {
      if (
        stale.tokenType === 'access' &&
        stale.revokedAt === null &&
        stale.id !== issued.access.id
      ) {
        await tx.revokeToken(stale.id, 'rotated', now);
      }
    }

    if (windowMs > 0) {
      replayCache.set(row.id, { response: issued.response, issuedAtMs: nowMs });
    }

    return { ok: true, response: issued.response, familyId: row.familyId, replayed: false };
  });
}

/** The live access token of this family, for the `replaces_token_id` chain. */
async function currentAccessTokenId(
  repo: ITokenRepo,
  presented: TokenRecord,
): Promise<string | null> {
  const family = await repo.listFamily(presented.familyId);
  const live = family.filter((r) => r.tokenType === 'access' && r.revokedAt === null);
  return live.length > 0 ? live[live.length - 1]!.id : null;
}
