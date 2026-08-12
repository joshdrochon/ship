/**
 * Registry-of-apps domain types. Backed by new tables (migration 039+):
 * oauth_apps, oauth_tokens, webhook_subscriptions, webhook_deliveries.
 *
 * Secrets discipline: client_secret and webhook signing secrets are stored
 * SHA-256 hashed (high-entropy random values; slow KDFs are for low-entropy
 * passwords) and the raw value is shown exactly once at creation/rotation.
 */
import type { Scope } from '../scopes/scopes.js';

/**
 * A row of `oauth_apps` (migration 039), in domain terms.
 *
 * Field-by-field justification lives in the migration header, not here — this
 * is the shape, that is the reasoning. One rule this type enforces on its own:
 * there is no `clientSecret` field and there never will be. The raw secret is a
 * value that exists in flight, is returned exactly once (PF-040, PF-047), and
 * is not part of an app's persisted identity.
 */
export interface OAuthApp {
  id: string;
  /** Public identifier. NOT a secret — returned in full by every read (PF-032). */
  clientId: string;
  /** Unsalted SHA-256 of the client secret; the raw value is never stored (D1). */
  clientSecretHash: string;
  /** First 8 chars of the secret's random portion, in clear, for identification (PF-035). */
  secretPrefix: string;
  /** Increments on every rotation (PF-047). */
  secretVersion: number;
  name: string;
  ownerUserId: string;
  workspaceId: string;
  /** Stored byte-for-byte as submitted; L04 compares them exactly (PF-042). */
  redirectUris: string[];
  requestedScopes: Scope[];
  /** D2: false stops token validation (PF-052). Never deleted, only deactivated. */
  active: boolean;
  /** First-party apps (the FleetGraph agent) are seeded by migration (PF-054). */
  isFirstParty: boolean;
  deactivatedAt: Date | null;
  /** Machine-readable tag, e.g. 'owner_deleted' — not prose. */
  deactivationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * D3 — how rotation treats the outgoing secret, exposed as DATA rather than as
 * UI copy (PF-047, PF-048).
 *
 * The portal (L22 PF-670) renders whichever value the API returns, so flipping
 * the model is a change here and not a UI rewrite. `'grace'` is deliberately in
 * the type although nothing produces it: it is the alternative D3 rejected, and
 * naming it is what keeps the rejection legible.
 */
export type RotationPolicy = 'instant' | 'grace';

export interface IssuedTokens {
  /** Opaque high-entropy access token — stored hashed, ~1h TTL. */
  accessToken: string;
  /** One-time-use refresh token; reuse of a spent token revokes the family. */
  refreshToken: string;
  expiresInSeconds: number;
  scopes: Scope[];
}

export interface WebhookSubscription {
  id: string;
  appId: string;
  targetUrl: string;
  eventTypes: string[];
  /** SHA-256 hash of the signing secret; raw shown once. */
  signingSecretHash: string;
  active: boolean;
  createdAt: Date;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'retrying' | 'dead_lettered';

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  idempotencyKey: string;
  attemptNumber: number;
  responseStatus: number | null;
  responseExcerpt: string | null;
  latencyMs: number | null;
  status: DeliveryStatus;
  createdAt: Date;
}

// TODO(josh): repos (Postgres-backed) — appsRepo, tokenRepo, subscriptionsRepo,
// deliveryLogRepo — with in-memory doubles for tests. Schema in migration 039.
