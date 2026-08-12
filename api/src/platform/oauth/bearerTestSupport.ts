/**
 * Test wiring for the REAL bearer middleware — the counterpart to L07's
 * `api/v1/testSupport.ts`, which stubs it.
 *
 * L07's `createTestPublicApp` installs a bearer-auth STUB, which is right for
 * testing the envelope and the middleware ORDER but cannot test the middleware
 * itself. This builder assembles the same router with the genuine
 * `bearerTokenMiddleware` over in-memory repositories and a `FakeClock`, so a
 * test can mint a real token, advance past its TTL, and watch the real code
 * produce a real 401.
 *
 * Lives in `src/` rather than `src/test/` for the reason `testDeps()` and
 * `api/v1/testSupport.ts` both give: it is part of the contract this module
 * exports, and `api/tsconfig.json` excludes `src/test/**`, so hiding it there
 * would let the test wiring and the production wiring drift without `tsc`
 * noticing.
 *
 * It imports `supertest` in a non-test source file, which matches the
 * convention L07's `envelopeAssertion.ts` already set for clause modules.
 */
import express, { type Express, type Router } from 'express';
import { createPublicRouter } from '../api/v1/router.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { InMemoryAuditSink } from '../audit/audit.js';
import { InMemoryTokenBucket, type IRateLimiter } from '../ratelimit/limiter.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { issueTokenPair, type TokenPairResponse } from './issue.js';
import { bearerTokenMiddleware } from './bearer.js';
import { DEFAULT_TOKEN_TTL, type TokenTtlConfig } from './tokens.js';

export interface BearerTestApp {
  app: Express;
  clock: FakeClock;
  appsRepo: InMemoryOAuthAppRepo;
  tokenRepo: InMemoryTokenRepo;
  auditSink: InMemoryAuditSink;
  oauthApp: OAuthApp;
  ttl: TokenTtlConfig;
  /** Mints a live pair for `oauthApp` through the one issuance site. */
  mint(scopes?: Scope[]): Promise<TokenPairResponse>;
}

export interface BearerTestAppOptions {
  /** Routes under test, mounted above the catch-all through the router hook. */
  mountResources?: (router: Router) => void;
  /** Short TTLs for expiry-without-waiting (PF-173). */
  ttl?: TokenTtlConfig;
  scopes?: Scope[];
  perAppLimiter?: IRateLimiter;
  perTokenLimiter?: IRateLimiter;
  /**
   * The workspace the app — and therefore every token minted from it — belongs
   * to (PF-260). Defaults to the opaque `'ws-1'`, which is right for tests that
   * never touch a database.
   *
   * A resource test DOES touch one, and its rows are keyed by a real
   * `workspaces.id`. Added by L09 rather than worked around with a cast, because
   * the cast would have been in the one place tenancy is decided: a token whose
   * workspace does not match the fixture's rows returns an empty list, which
   * looks exactly like a passing "no cross-tenant leakage" assertion.
   */
  workspaceId?: string;
  /** The consenting user tokens are minted for. Defaults to `'user-1'`. */
  userId?: string | null;
}

export async function createBearerTestApp(
  options: BearerTestAppOptions = {},
): Promise<BearerTestApp> {
  // A non-zero start: a FakeClock at 0 makes "unset" and "the epoch"
  // indistinguishable when reading a timestamp column.
  const clock = new FakeClock(1_700_000_000_000);
  const appsRepo = new InMemoryOAuthAppRepo(() => new Date(clock.nowMs()));
  const tokenRepo = new InMemoryTokenRepo();
  const auditSink = new InMemoryAuditSink();
  const ttl = options.ttl ?? DEFAULT_TOKEN_TTL;

  const oauthApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L06 bearer test app',
    ownerUserId: options.userId ?? 'user-1',
    workspaceId: options.workspaceId ?? 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });

  const generous = (): IRateLimiter =>
    new InMemoryTokenBucket({ capacity: 1_000_000, refillPerSecond: 1_000_000 });

  const app = express();
  app.use(
    V1_PREFIX,
    createPublicRouter({
      // THE REAL THING. This is the whole point of this builder.
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      perAppLimiter: options.perAppLimiter ?? generous(),
      perTokenLimiter: options.perTokenLimiter ?? generous(),
      auditSink,
      ...(options.mountResources ? { mountResources: options.mountResources } : {}),
    }),
  );

  return {
    app,
    clock,
    appsRepo,
    tokenRepo,
    auditSink,
    oauthApp,
    ttl,
    async mint(scopes: Scope[] = options.scopes ?? ['documents:read']) {
      const { response } = await issueTokenPair(
        { tokenRepo, clock, ttl },
        { app: oauthApp, userId: options.userId ?? 'user-1', scopes },
      );
      return response;
    },
  };
}
