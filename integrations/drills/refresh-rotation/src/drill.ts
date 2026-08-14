/**
 * PRD p.8, option 5 — the refresh-token rotation drill.
 *
 * PRD p.3, Refresh Tokens: *"One-time-use refresh tokens with rotation"* and
 * *"Stolen-refresh-token detection: reuse invalidates the family."*
 *
 * ── Everything here is observed from OUTSIDE ───────────────────────────────
 * Not one assertion reads a database row, and the package cannot: the ESLint
 * fence and `scripts/check-integration-credentials.mjs` between them make a `pg`
 * import a build failure and a `DATABASE_URL` read a CI failure. That is the
 * point of a drill. `rotation.test.ts` inside `api/` already proves the server
 * does the right thing to its own tables; what nobody had proved is that the
 * guarantee is VISIBLE to the client holding the credential — and the
 * client-visible half is the only half a thief is constrained by.
 *
 * ── The drill is a function, so it can be pointed at a liar ────────────────
 * `runRotationDrill` takes a target and returns OBSERVATIONS. `rotationViolations`
 * turns observations into a list of things a correct platform would not have
 * done. Keeping those apart is what makes PF-727's anti-vacuity clause
 * expressible: run the same function against a stub token endpoint that
 * cheerfully re-issues on a reused token, and `rotationViolations` comes back
 * non-empty. A drill that cannot fail is a screenshot.
 */
import {
  ShipClient,
  ShipError,
  createFetchHttpClient,
  exchangeRefreshToken,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type StoredTokens,
} from '@ship/sdk';

export interface DrillTarget {
  baseUrl: string;
  clientId: string;
  /** A public client has none (RFC 6749 §2.1). Present only for a confidential app. */
  clientSecret?: string;
}

/** One `/oauth/token` refresh exchange, with the wire kept. */
export interface ExchangeOutcome {
  ok: boolean;
  tokens: StoredTokens | null;
  /** The SDK's own typed view — `kind`, `status`, `message`. */
  sdkError: { kind: string; status: number | null; message: string } | null;
  /**
   * The RAW response, recorded by teeing the HTTP client.
   *
   * PF-726 wants both halves printed: the SDK error is what a consumer catches,
   * the raw body is RFC 6749's `{error, error_description}` and is where the
   * three refresh failures are actually distinguishable. Recording it through a
   * wrapping `HttpClient` rather than a second request matters — a refresh token
   * is one-time-use, so "do it again to see the body" would spend it.
   */
  rawStatus: number;
  rawBody: string;
}

/** What one full drill run saw. Every field is something a client can observe. */
export interface RotationObservations {
  /** PF-723 — the access token from the real grant answers /api/v1/me. */
  meStatusBeforeAnyRotation: number;

  /** PF-724 — one rotation, from the client's side. */
  firstRotation: {
    exchanged: boolean;
    refreshTokenChanged: boolean;
    accessTokenChanged: boolean;
    meStatusWithNewAccessToken: number;
    /** Re-presenting the SAME refresh token immediately. Must fail. */
    replayOfSpentToken: ExchangeOutcome;
  };

  /** PF-725 — the theft scenario, three rotations deep. */
  theftScenario: {
    rotations: number;
    /** Replaying the long-spent R1 after R1→R2→R3. */
    replayOfR1: ExchangeOutcome;
    /** R3 was live and untouched before the replay. Must be dead after it. */
    r3ExchangeAfterReplay: ExchangeOutcome;
    /** A3 was never stolen. p.3's guarantee is family-wide, so it must be 401. */
    meStatusWithA3AfterReplay: number;
    /** Anti-vacuity: A3 answered 200 BEFORE the replay, so the 401 means something. */
    meStatusWithA3BeforeReplay: number;
  };

  /** PF-726 — the three failure shapes, recorded rather than asserted-by-code. */
  failureShapes: {
    reused: ExchangeOutcome;
    expired: ExchangeOutcome;
    unknown: ExchangeOutcome;
  };
}

/** Wraps an `HttpClient` and keeps the last response's status and body text. */
function recordingHttp(inner: HttpClient): {
  http: HttpClient;
  last: () => { status: number; body: string };
} {
  let status = 0;
  let body = '';
  return {
    http: {
      async send(request: HttpRequest): Promise<HttpResponse> {
        const response = await inner.send(request);
        const text = await response.text();
        status = response.status;
        body = text;
        // `text()` is single-use on a real Response, so hand the caller a
        // replayable view rather than the drained original.
        return {
          status: response.status,
          headers: response.headers,
          text: () => Promise.resolve(text),
        };
      },
    },
    last: () => ({ status, body }),
  };
}

/** One refresh exchange, keeping both the SDK's view and the wire. */
export async function exchangeOnce(
  target: DrillTarget,
  refreshToken: string,
  http: HttpClient = createFetchHttpClient(),
): Promise<ExchangeOutcome> {
  const recorder = recordingHttp(http);
  const deps = {
    http: recorder.http,
    baseUrl: target.baseUrl,
    clientId: target.clientId,
    ...(target.clientSecret !== undefined ? { clientSecret: target.clientSecret } : {}),
    nowMs: Date.now(),
  };

  try {
    const tokens = await exchangeRefreshToken(deps, refreshToken);
    const raw = recorder.last();
    return { ok: true, tokens, sdkError: null, rawStatus: raw.status, rawBody: raw.body };
  } catch (err) {
    const raw = recorder.last();
    const sdkError =
      err instanceof ShipError
        ? { kind: err.kind, status: err.status, message: err.message }
        : { kind: 'non-ship-error', status: null, message: String(err) };
    return { ok: false, tokens: null, sdkError, rawStatus: raw.status, rawBody: raw.body };
  }
}

/**
 * `GET /api/v1/me` with a bearer token, through the SDK. Returns the status.
 *
 * A raw `fetch` would be shorter and would prove less: PF-724 says the
 * assertions go "over HTTP through the SDK", and the 401 an external consumer
 * actually experiences is the one the SDK's error mapping produces.
 */
export async function meStatus(baseUrl: string, accessToken: string): Promise<number> {
  const client = new ShipClient({ baseUrl, token: accessToken });
  try {
    await client.me();
    return 200;
  } catch (err) {
    if (err instanceof ShipError && err.status !== null) return err.status;
    throw err;
  }
}

function requireRefresh(tokens: StoredTokens | null, what: string): string {
  const value = tokens?.refreshToken;
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `${what}: the token endpoint returned no refresh_token. Rotation cannot be observed ` +
        `without one, and the SDK deliberately stores null rather than re-using the presented ` +
        `token (see sdk/src/auth/refresh.ts).`,
    );
  }
  return value;
}

export interface DrillInput {
  /** The instance under test, with ordinary token TTLs. */
  target: DrillTarget;
  /** A pair from a REAL grant — PF-723. One session, spent by `firstRotation`. */
  sessionA: StoredTokens;
  /** A second real pair. Rotated three times, then robbed. */
  sessionB: StoredTokens;
  /**
   * A pair from an instance booted with a zero-second refresh TTL.
   *
   * The token is born expired, so PF-726's `expired` case is produced by
   * CONFIGURATION and observed instantly. p.11 rules out `setTimeout` waits by
   * name, and "wait for a short TTL to pass" is that with extra steps.
   */
  expiredPair: { target: DrillTarget; tokens: StoredTokens };
  /** Syntactically valid, matching no row. Generated by the caller. */
  unknownRefreshToken: string;
}

export async function runRotationDrill(input: DrillInput): Promise<RotationObservations> {
  const { target } = input;

  // ── PF-723: the grant's own access token works before anything is rotated ──
  const meStatusBeforeAnyRotation = await meStatus(target.baseUrl, input.sessionA.accessToken);

  // ── PF-724: one rotation, observed from the client ────────────────────────
  const r1 = requireRefresh(input.sessionA, 'session A');
  const rotated = await exchangeOnce(target, r1);
  const a2 = rotated.tokens?.accessToken ?? '';
  const firstRotation = {
    exchanged: rotated.ok,
    refreshTokenChanged: rotated.tokens?.refreshToken !== r1,
    accessTokenChanged: a2 !== input.sessionA.accessToken,
    meStatusWithNewAccessToken: a2 === '' ? 0 : await meStatus(target.baseUrl, a2),
    replayOfSpentToken: await exchangeOnce(target, r1),
  };

  // ── PF-725: R1 → R2 → R3, then the thief presents R1 ──────────────────────
  const bR1 = requireRefresh(input.sessionB, 'session B');
  const second = await exchangeOnce(target, bR1);
  const bR2 = requireRefresh(second.tokens, 'session B rotation 1');
  const third = await exchangeOnce(target, bR2);
  const bR3 = requireRefresh(third.tokens, 'session B rotation 2');
  const a3 = third.tokens?.accessToken ?? '';

  // Before the theft. If this is not 200 the assertion after it proves nothing.
  const meStatusWithA3BeforeReplay = a3 === '' ? 0 : await meStatus(target.baseUrl, a3);

  const replayOfR1 = await exchangeOnce(target, bR1);
  const r3ExchangeAfterReplay = await exchangeOnce(target, bR3);
  const meStatusWithA3AfterReplay = a3 === '' ? 0 : await meStatus(target.baseUrl, a3);

  // ── PF-726: three failure shapes ──────────────────────────────────────────
  const expiredRefresh = input.expiredPair.tokens.refreshToken;
  const failureShapes = {
    // The family revoked one step above. Presenting R3 again is `reused`.
    reused: await exchangeOnce(target, bR3),
    expired:
      typeof expiredRefresh === 'string' && expiredRefresh !== ''
        ? await exchangeOnce(input.expiredPair.target, expiredRefresh)
        : {
            ok: false,
            tokens: null,
            sdkError: { kind: 'drill', status: null, message: 'no refresh token to expire' },
            rawStatus: 0,
            rawBody: '',
          },
    unknown: await exchangeOnce(target, input.unknownRefreshToken),
  };

  return {
    meStatusBeforeAnyRotation,
    firstRotation,
    theftScenario: {
      rotations: 3,
      replayOfR1,
      r3ExchangeAfterReplay,
      meStatusWithA3AfterReplay,
      meStatusWithA3BeforeReplay,
    },
    failureShapes,
  };
}

/**
 * Everything a correct platform would not have done, as strings.
 *
 * A list rather than a throw, so one run reports every violation instead of the
 * first — which is what makes the permissive-stub case (PF-727) legible: a stub
 * that accepts everything fails on four counts at once, and seeing all four is
 * how you know the drill is checking four things.
 */
export function rotationViolations(observed: RotationObservations): string[] {
  const problems: string[] = [];

  if (observed.meStatusBeforeAnyRotation !== 200) {
    problems.push(
      `PF-723: the access token from the grant answered ${observed.meStatusBeforeAnyRotation} on ` +
        `/api/v1/me, not 200. The drill is measuring itself, not the platform.`,
    );
  }

  const first = observed.firstRotation;
  if (!first.exchanged) problems.push('PF-724: the refresh grant did not issue a new pair at all.');
  if (!first.refreshTokenChanged) {
    problems.push('PF-724: the refresh token did not change. That is re-issuance, not rotation.');
  }
  if (!first.accessTokenChanged) {
    problems.push('PF-724: the access token did not change across a rotation.');
  }
  if (first.meStatusWithNewAccessToken !== 200) {
    problems.push(
      `PF-724: the newly issued access token answered ${first.meStatusWithNewAccessToken} on ` +
        `/api/v1/me. A rotation that hands back a token that does not work is worse than none.`,
    );
  }
  if (first.replayOfSpentToken.ok) {
    problems.push(
      'PF-724: presenting the SAME refresh token a second time SUCCEEDED. p.3 requires one-time ' +
        'use; a token that can be spent twice is a token a thief can spend once.',
    );
  }

  const theft = observed.theftScenario;
  if (theft.meStatusWithA3BeforeReplay !== 200) {
    problems.push(
      `PF-725 (control): A3 answered ${theft.meStatusWithA3BeforeReplay} BEFORE the theft. The ` +
        `401 assertion below would then pass for the wrong reason.`,
    );
  }
  if (theft.replayOfR1.ok) {
    problems.push('PF-725: replaying the long-spent R1 after three rotations SUCCEEDED.');
  }
  if (theft.r3ExchangeAfterReplay.ok) {
    problems.push(
      'PF-725: R3 still exchanges after R1 was replayed. Reuse revoked nothing but the token ' +
        'presented — the FAMILY is what p.3 and p.15 both say is invalidated, and R3 is the ' +
        'credential the thief did not have.',
    );
  }
  if (theft.meStatusWithA3AfterReplay !== 401) {
    problems.push(
      `PF-725: A3 answered ${theft.meStatusWithA3AfterReplay} on /api/v1/me after the theft ` +
        `signal, not 401. The access token issued alongside R3 was never itself stolen, and it ` +
        `is the only part of the family-wide guarantee a subscriber can see.`,
    );
  }

  // ── PF-726 asserts DISTINGUISHABILITY, and deliberately not the codes ─────
  //
  // p.2 names distinct 401 codes for BEARER tokens and RFC 6749's
  // `invalid_grant` for the token endpoint. It specifies no code set for refresh
  // failures. Naming one here would write L06's contract from a consumer lane,
  // so the drill asserts only that a caller CAN tell the three apart — which is
  // the property that has consumer value — and prints all three.
  const shapes = observed.failureShapes;
  for (const [name, outcome] of Object.entries(shapes)) {
    if (outcome.ok) problems.push(`PF-726: the '${name}' case SUCCEEDED. It is not a failure at all.`);
  }
  const descriptions = Object.entries(shapes).map(([name, o]) => [name, o.rawBody] as const);
  const distinct = new Set(descriptions.map(([, body]) => body));
  if (distinct.size !== descriptions.length) {
    problems.push(
      `PF-726: the three refresh failures are NOT distinguishable — ${descriptions.length} cases ` +
        `produced ${distinct.size} distinct response bodies. A consumer cannot tell "your session ` +
        `expired, sign in again" from "someone is replaying your token". Bodies: ` +
        descriptions.map(([n, b]) => `${n}=${b}`).join(' | '),
    );
  }

  return problems;
}

/** Human-readable, for the CI log. PF-726 requires the three shapes be PRINTED. */
export function formatFailureShapes(observed: RotationObservations): string {
  return Object.entries(observed.failureShapes)
    .map(([name, o]) =>
      [
        `  ${name}`,
        `    sdk   : kind=${o.sdkError?.kind ?? '—'} status=${o.sdkError?.status ?? '—'}`,
        `            ${o.sdkError?.message ?? '(no error — this case SUCCEEDED)'}`,
        `    wire  : ${o.rawStatus} ${o.rawBody}`,
      ].join('\n'),
    )
    .join('\n');
}
