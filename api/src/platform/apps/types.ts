/**
 * Registry-of-apps domain types. Backed by new tables (migration 039+):
 * oauth_apps, oauth_tokens, webhook_subscriptions, webhook_deliveries.
 *
 * Secrets discipline: client_secret and webhook signing secrets are stored
 * SHA-256 hashed (high-entropy random values; slow KDFs are for low-entropy
 * passwords) and the raw value is shown exactly once at creation/rotation.
 * The full argument lives in `secrets.ts` — this file is shapes only.
 */
import type { Scope } from '../scopes/scopes.js';

/**
 * One row of `oauth_apps` (migration 039), in application terms.
 *
 * Note what is NOT here: the raw `client_secret`. There is no field for it on any
 * persisted type in this codebase, which is the type system carrying part of
 * PF-038's guarantee — a projection cannot accidentally include a property that
 * does not exist. The raw value appears only on the two response types below.
 */
export interface OAuthApp {
  id: string;
  /** Public identifier, `ship_app_…`. Not a secret; see secrets.ts. */
  clientId: string;
  /** SHA-256 hash of the client secret; raw value never stored. */
  clientSecretHash: string;
  /** First 8 chars after the `ship_secret_` tag, in clear. Identification only. */
  secretPrefix: string;
  /** Increments on every rotation (D3). */
  secretVersion: number;
  name: string;
  ownerUserId: string;
  workspaceId: string;
  /** Stored byte-for-byte as submitted — no normalisation (PF-042). */
  redirectUris: string[];
  requestedScopes: Scope[];
  /** D2: false means "deactivated", never "deleted". Token validation reads this. */
  active: boolean;
  /** First-party apps (the FleetGraph agent) are seeded by the deploy path. */
  firstParty: boolean;
  deactivatedAt: Date | null;
  deactivationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Why an app was deactivated. Free-form in the column, named here for the paths we take. */
export type DeactivationReason = 'owner_deleted' | 'admin' | 'suspected_leak';

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
