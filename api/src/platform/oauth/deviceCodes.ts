/**
 * The device authorization: codes, TTL, normalization, and the repository seam.
 * PF-121 / PF-123 / PF-124 / PF-127 / PF-131 (lane L05, slice S1).
 *
 * ---------------------------------------------------------------------------
 * TWO CREDENTIALS, TREATED DELIBERATELY DIFFERENTLY.
 * ---------------------------------------------------------------------------
 * RFC 8628 issues a pair, and they have opposite threat models. Migration 071's
 * header carries the full argument; the short version is:
 *
 *   device_code  a bearer credential the client redeems at /oauth/token.
 *                32 bytes of CSPRNG, stored as sha256 ONLY. A database read
 *                must not yield a redeemable credential — the same discipline
 *                `tokens.ts` applies to access tokens, `authCodes.ts` to
 *                authorization codes, and D1 to `client_secret`.
 *
 *   user_code    a short value a human reads off a terminal and types into a
 *                form. Stored IN CLEAR, because it must be looked up by
 *                equality on what the user typed. Its defense is entropy ×
 *                throttle × expiry, not secrecy.
 *
 * ---------------------------------------------------------------------------
 * THE ENTROPY FIGURE, AND WHY IT IS WRITTEN NEXT TO THE THROTTLE (PF-123).
 * ---------------------------------------------------------------------------
 * RFC 8628 §5.1 does not set a bit target. It requires that the `user_code` be
 * rate-limited or short-lived enough that brute force is impractical — the
 * requirement is on the PRODUCT of code entropy and attempt throttling, and
 * stating either number alone is how this gets shipped weak. So both are
 * recorded here, together:
 *
 *   alphabet       28 characters (see `USER_CODE_CHARSET`)
 *   length         8, formatted `XXXX-XXXX`
 *   entropy        8 × log2(28) ≈ 38.5 bits ≈ 3.8 × 10^11 codes
 *   live window    600 s (`DEVICE_CODE_TTL_SECONDS`)
 *   throttle       PF-132, in `deviceThrottle.ts` — failed lookups are counted
 *                  per session and per source IP, and a code guessed at past
 *                  the threshold is invalidated rather than left live.
 *
 * Against the throttle, an attacker gets a bounded number of attempts per
 * window per origin, over a 600-second window, against 3.8×10^11 codes with
 * typically a handful live. This is a decision without a requirement to cite —
 * PRD p.3 says nothing about it — and PF-123 records the reasoning rather than
 * inventing a target the PRD never set.
 *
 * ---------------------------------------------------------------------------
 * WHY A REPOSITORY AND NOT SQL IN THE HANDLER.
 * ---------------------------------------------------------------------------
 * Identical reasoning to `IAuthCodeRepo` (PF-086), `ITokenRepo` (PF-154) and
 * `IOAuthAppRepo` (PF-037): no Express type and no `pg` type appears in any
 * signature in this file, so the issuance handler, the verification screen, the
 * poll and the sweeper are all unit-testable in a bare Node context.
 * `InMemoryDeviceCodeRepo` and `PgDeviceCodeRepo` are a Liskov pair, and the
 * shared contract test is what catches a divergence.
 */
import type { Scope } from '../scopes/scopes.js';
import {
  hashToken,
  generateDeviceCode,
  generateUserCode,
  USER_CODE_CHARSET,
  USER_CODE_RAW_LENGTH,
} from './tokens.js';

/**
 * Re-exported, not redefined. Both generators live in `tokens.ts` because
 * `issue.test.ts` asserts that file is the only site under `platform/oauth/`
 * drawing random bytes — see their headers for why that invariant beat locality.
 */
export { generateDeviceCode, generateUserCode, USER_CODE_CHARSET, USER_CODE_RAW_LENGTH };

/**
 * PF-127 — the ONE place a device authorization's lifetime is written down.
 *
 * 600 seconds. RFC 8628 §3.2's own example value, and it is long enough for the
 * story PRD p.6 tells: the user reads a code off a terminal, walks to a browser,
 * signs in if they are not already, and types it. Sixty seconds — the
 * authorization code's TTL — would be wrong here for exactly the reason it is
 * right there: that code crosses one machine-to-machine redirect with no human
 * in the path, and this one is gated on human think time.
 *
 * ⚑ HONEST NOTE, carried from the lane's ticket: nothing in this build measures
 * how long a human actually takes between seeing the code and approving it, so
 * this number is RFC 8628's example rather than an observation. L20's drill
 * measures the automated path only. If the number is ever wrong it will be
 * wrong in the too-short direction and will surface as `expired_token` on a real
 * user's first login, which is at least a loud failure.
 */
export const DEVICE_CODE_TTL_SECONDS = 600;

/**
 * RFC 8628 §3.2's baseline polling interval, in seconds.
 *
 * Five is the RFC's own default. It is returned in the issuance response as
 * `interval` and it is the value the throttle enforces on the first poll —
 * PF-141 asserts those are the same number, so an SDK that trusts what we sent
 * is never slowed down for obeying it.
 */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * PF-136 — how much `interval_seconds` grows on each `slow_down`.
 *
 * RFC 8628 §3.5 says the client MUST increase its interval by 5 seconds on a
 * `slow_down`. The server raising its own stored interval by the same amount is
 * what keeps the two in agreement; a server that returns `slow_down` without
 * raising the interval leaves a fast client in a permanent error loop, which is
 * the most common misreading of §3.5.
 */
export const DEVICE_POLL_INTERVAL_INCREMENT_SECONDS = 5;

/**
 * The ceiling on the cumulative backoff.
 *
 * Without a cap, a client polling in a tight loop for the full 600-second TTL
 * drives the interval past the code's own lifetime, at which point every
 * remaining poll is `slow_down` and the flow can never complete even after the
 * user approves. Sixty seconds leaves at least ten legal polls inside the TTL in
 * the worst case.
 */
export const DEVICE_POLL_INTERVAL_MAX_SECONDS = 60;

/**
 * PF-144 — how long a CONSUMED or decided row is kept before the sweeper
 * deletes it.
 *
 * Not the same number as the TTL and it must not be, for `authCodes.ts`'s
 * reason: a consumed row is what makes a second poll recognisable as a replay
 * (`invalid_grant`) rather than as an unknown device code, and a denied row is
 * what makes `access_denied` reachable instead of the client polling until
 * expiry and reporting the wrong reason (PF-133). An hour comfortably outlives
 * any legitimate retry.
 */
export const CONSUMED_DEVICE_CODE_RETENTION_SECONDS = 60 * 60;

/** What the row stores for the device code. Never the value itself. */
export function hashDeviceCode(raw: string): string {
  return hashToken(raw);
}

/**
 * PF-131 — THE one normalization function, called by the generator's consumers
 * and by every lookup.
 *
 * A user typing a code they read off a terminal will lowercase it, drop the
 * hyphen, or paste it with a trailing space. All three are the same code and the
 * flow must treat them as such — this is the difference between the demo working
 * on the first try and on the third. It is RFC 8628 §6.1's usability guidance
 * rather than anything PRD p.3 asks for, and the ticket says so.
 *
 * Being ONE exported function matters more than what it does. If the generator
 * canonicalised one way and the lookup normalised another, the mismatch would be
 * invisible until a user typed a code that should have worked. The lookup path
 * and the storage path call this same function, and a test drives eight input
 * variants of one issued code to the same row.
 *
 * Note what it does NOT do: it never mutates what is stored or displayed. The
 * canonical hyphenated form is what the row holds and what the terminal prints,
 * so the audit trail and the portal show exactly what the user saw (PF-131's
 * second assertion). Normalization is applied to BOTH sides of the comparison,
 * not by rewriting the stored value.
 */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The `XXXX-XXXX` canonical form, as a pattern. Asserted against the generator. */
export const USER_CODE_PATTERN = new RegExp(
  `^[${USER_CODE_CHARSET}]{4}-[${USER_CODE_CHARSET}]{4}$`,
);

/** Three states. Mirrors migration 071's CHECK constraint exactly. */
export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied';

/** A row of `oauth_device_codes` (migration 071), in domain terms. */
export interface DeviceCodeRecord {
  id: string;
  deviceCodeHash: string;
  /** Canonical hyphenated form, in clear. See the header. */
  userCode: string;
  appId: string;
  /**
   * At issuance: the validated request (PF-126). At approval: replaced with the
   * RESOLVED grant, `resolveGrantedScopes(app.requestedScopes, consented)`.
   */
  scopes: Scope[];
  status: DeviceAuthorizationStatus;
  /** Both null until approval; both set by PF-130 from the verifying session. */
  userId: string | null;
  workspaceId: string | null;
  intervalSeconds: number;
  lastPolledAt: Date | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Everything needed to write one device-code row. The raw code never reaches here. */
export interface InsertDeviceCodeInput {
  deviceCodeHash: string;
  userCode: string;
  appId: string;
  scopes: Scope[];
  intervalSeconds: number;
  expiresAt: Date;
  createdAt: Date;
}

/** The approval decision recorded by PF-130. */
export interface ApproveDeviceCodeInput {
  id: string;
  userId: string;
  workspaceId: string;
  /** The RESOLVED grant (PF-074), never the app's `requested_scopes`. */
  scopes: Scope[];
}

export interface IDeviceCodeRepo {
  /**
   * Insert one row.
   *
   * Throws on a `user_code` or `device_code_hash` collision rather than
   * returning null, because both mean something has gone wrong that the caller
   * must not paper over: a duplicate hash is a CSPRNG failure, and a duplicate
   * `user_code` is the case PF-123's bounded retry handles ONE level up, where
   * there is a fresh code to try. Swallowing it here would make a retry
   * impossible to write correctly.
   */
  insert(input: InsertDeviceCodeInput): Promise<DeviceCodeRecord>;

  /** The lookup at `/oauth/token`. Returns the row whatever its state. */
  findByDeviceCodeHash(hash: string): Promise<DeviceCodeRecord | null>;

  /**
   * The lookup at `/oauth/device/verify`.
   *
   * Takes the NORMALIZED code and compares against the stored value normalized
   * the same way (PF-131), so `abcd-efgh`, `ABCDEFGH` and `ABCD-EFGH ` all reach
   * one row. Implementations must normalize on the stored side too rather than
   * assuming the column already holds a normalized value — that assumption is
   * what would let the two sides drift.
   */
  findByUserCode(normalized: string): Promise<DeviceCodeRecord | null>;

  /**
   * PF-130 — record the user's approval and bind them to the grant.
   *
   * Returns false when the row was not `pending`, which is what makes a second
   * approval of an already-decided code a no-op rather than a silent overwrite.
   * Expressed as ONE conditional write (`UPDATE … WHERE status = 'pending'`),
   * never a read followed by a write, for `IAuthCodeRepo.consume`'s reason: two
   * concurrent decisions both pass a read-then-write.
   */
  approve(input: ApproveDeviceCodeInput, at: Date): Promise<boolean>;

  /** PF-130 — record a denial. Same conditional-write contract as `approve`. */
  deny(id: string, at: Date): Promise<boolean>;

  /**
   * PF-136 — stamp `last_polled_at` and set the (possibly raised) interval.
   *
   * One statement, because the poll's decision and the state it leaves behind
   * must not come apart: a crash between "decide this poll was too fast" and
   * "record that it happened" would let a client poll fast forever.
   */
  recordPoll(id: string, at: Date, intervalSeconds: number): Promise<void>;

  /**
   * PF-140 — the CONDITIONAL consume, and the whole single-redemption guarantee.
   *
   * Returns false when the row was already consumed. Implementations must
   * express this as ONE conditional write
   * (`UPDATE … WHERE id = $1 AND consumed_at IS NULL RETURNING id`) so that two
   * simultaneous polls after approval yield exactly one token pair and one
   * `invalid_grant`. Identical in shape and reasoning to
   * `IAuthCodeRepo.consume` and `ITokenRepo.markSpent`.
   */
  consume(id: string, at: Date): Promise<boolean>;

  /**
   * PF-132 — invalidate a code that has been guessed at past the threshold.
   *
   * Denial rather than deletion: the poller must be able to tell that its flow
   * is over. The legitimate user simply runs `ship login` again, which is cheap,
   * and an attacker who has burned the throttle has also burned the code.
   */
  invalidate(id: string, at: Date): Promise<boolean>;

  /**
   * PF-144 — the sweep. Deletes rows past `expires_at` that were never
   * consumed, and consumed/decided rows older than `consumedBefore`.
   *
   * Two cut-offs rather than one, for `IAuthCodeRepo.deleteSwept`'s reason: an
   * unredeemed expired row is dead weight the moment it expires, while a
   * consumed row must outlive its own TTL to keep a replayed poll
   * distinguishable from an unknown one.
   */
  deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number>;

  /**
   * Runs `fn` inside one transaction. Present because PF-140 requires the
   * consume and the token insert to be one atomic step, and no single-purpose
   * method can express that boundary.
   */
  transaction<T>(fn: (repo: IDeviceCodeRepo) => Promise<T>): Promise<T>;
}

/**
 * In-memory double. Liskov-substitutable with `PgDeviceCodeRepo`: same
 * interface, same null-on-missing behaviour, same conditional-write semantics.
 * Where the two differ, the difference is a bug in one of them.
 */
export class InMemoryDeviceCodeRepo implements IDeviceCodeRepo {
  private rows = new Map<string, DeviceCodeRecord>();
  private seq = 0;

  async insert(input: InsertDeviceCodeInput): Promise<DeviceCodeRecord> {
    const normalized = normalizeUserCode(input.userCode);
    for (const row of this.rows.values()) {
      // Mirrors UNIQUE(device_code_hash). A collision means a CSPRNG failure.
      if (row.deviceCodeHash === input.deviceCodeHash) throw new Error('duplicate device_code_hash');
      // Mirrors UNIQUE(user_code). Compared normalized, so the in-memory double
      // rejects `abcd-efgh` against a stored `ABCD-EFGH` exactly as the
      // database's lookup path would find them to be the same code.
      if (normalizeUserCode(row.userCode) === normalized) throw new Error('duplicate user_code');
    }
    this.seq += 1;
    const row: DeviceCodeRecord = {
      id: `devicecode-${this.seq}`,
      deviceCodeHash: input.deviceCodeHash,
      userCode: input.userCode,
      appId: input.appId,
      scopes: [...input.scopes],
      status: 'pending',
      userId: null,
      workspaceId: null,
      intervalSeconds: input.intervalSeconds,
      lastPolledAt: null,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    };
    this.rows.set(row.id, row);
    return { ...row, scopes: [...row.scopes] };
  }

  async findByDeviceCodeHash(hash: string): Promise<DeviceCodeRecord | null> {
    for (const row of this.rows.values()) {
      if (row.deviceCodeHash === hash) return { ...row, scopes: [...row.scopes] };
    }
    return null;
  }

  async findByUserCode(normalized: string): Promise<DeviceCodeRecord | null> {
    const target = normalizeUserCode(normalized);
    for (const row of this.rows.values()) {
      if (normalizeUserCode(row.userCode) === target) return { ...row, scopes: [...row.scopes] };
    }
    return null;
  }

  async approve(input: ApproveDeviceCodeInput, at: Date): Promise<boolean> {
    const row = this.rows.get(input.id);
    // The `status === 'pending'` guard is the in-memory equivalent of the SQL
    // `WHERE status = 'pending'`. Checking it HERE rather than in the caller is
    // what keeps the two implementations substitutable.
    if (!row || row.status !== 'pending') return false;
    row.status = 'approved';
    row.userId = input.userId;
    row.workspaceId = input.workspaceId;
    row.scopes = [...input.scopes];
    void at;
    return true;
  }

  async deny(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return false;
    row.status = 'denied';
    void at;
    return true;
  }

  async recordPoll(id: string, at: Date, intervalSeconds: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.lastPolledAt = at;
    row.intervalSeconds = intervalSeconds;
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.consumedAt !== null) return false;
    row.consumedAt = at;
    return true;
  }

  async invalidate(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'pending') return false;
    row.status = 'denied';
    void at;
    return true;
  }

  async deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      const expiredUnconsumed = row.consumedAt === null && row.expiresAt < expiredBefore;
      const agedConsumed = row.consumedAt !== null && row.consumedAt < consumedBefore;
      if (expiredUnconsumed || agedConsumed) {
        this.rows.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async transaction<T>(fn: (repo: IDeviceCodeRepo) => Promise<T>): Promise<T> {
    // No rollback. A test that needs rollback semantics is testing Postgres and
    // belongs in `pgDeviceCodeRepo.test.ts`, where it runs against the engine
    // whose guarantee is under test. Same call as `InMemoryAuthCodeRepo`'s.
    return fn(this);
  }

  /** Test-only: total rows held. PF-125 asserts a deactivated app writes none. */
  size(): number {
    return this.rows.size;
  }
}
