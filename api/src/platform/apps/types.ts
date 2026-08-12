/**
 * Registry-of-apps domain types. Backed by new tables (migration 039+):
 * oauth_apps, oauth_tokens, webhook_subscriptions, webhook_deliveries.
 *
 * Secrets discipline: client_secret and webhook signing secrets are stored
 * SHA-256 hashed (high-entropy random values; slow KDFs are for low-entropy
 * passwords) and the raw value is shown exactly once at creation/rotation.
 */
import type { Scope } from '../scopes/registry.js';

export interface OAuthApp {
  id: string;
  clientId: string;
  /** SHA-256 hash of the client secret; raw value never stored. */
  clientSecretHash: string;
  name: string;
  ownerUserId: string;
  redirectUris: string[];
  requestedScopes: Scope[];
  /** First-party apps (the FleetGraph agent) are seeded by migration. */
  firstParty: boolean;
  createdAt: Date;
}

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
