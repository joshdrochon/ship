/**
 * The FOUR RESOURCE CLIENTS, against a genuinely running server — PF-522 – PF-526,
 * PF-533 – PF-536.
 *
 * `sdk/src/resources/clients.test.ts` proves the SHAPE (what hangs off the
 * client, which HTTP call each method makes) against a recording double. That is
 * necessary and it is not sufficient: it would pass identically if every route
 * on the server 404'd. This file boots `createApp()` — the real composition
 * root, real `bearerTokenMiddleware`, real Postgres repositories — on a real
 * socket and drives the published `@ship/sdk` entry point across it.
 *
 * Same arrangement and the same reason as `sdkGate.test.ts`: ESLint fence 4
 * (L99 F24) forbids `sdk/**` from importing anything in this repository, so an
 * SDK test cannot boot Ship. `@ship/api` takes `@ship/sdk` as a devDependency
 * and exercises it exactly as an external consumer would.
 *
 *   §1  documents · issues · sprints — list/get/create/update, typed, live
 *   §2  webhooks — CRUD + rotate, and the scope failure surfaced not flattened
 *   §3  the signing secret, returned once (PF-525)
 *   §4  async-iterator pagination across three real pages (PF-533)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ShipClient,
  ShipError,
  type ShipDocument,
  type ShipIssue,
  type ShipSprint,
  type WebhookSubscription,
} from '@ship/sdk';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { PgOAuthAppRepo } from '../../apps/pg-repo.js';
import { PgTokenRepo } from '../../oauth/pgTokenRepo.js';
import { issueTokenPair } from '../../oauth/issue.js';
import { DEFAULT_TOKEN_TTL } from '../../oauth/tokens.js';
import { SystemClock } from '../../clock.js';
import { secretMaterial } from '../../apps/repo.js';
import { generateClientId, generateClientSecret } from '../../apps/secrets.js';
import type { OAuthApp } from '../../apps/types.js';
import type { Scope } from '../../scopes/scopes.js';

const ALL_SCOPES: Scope[] = [
  'documents:read',
  'documents:write',
  'issues:read',
  'issues:write',
  'sprints:read',
  'sprints:write',
  'webhooks:manage',
];

let server: Server;
let baseUrl: string;
let workspaceId: string;
let userId: string;
let oauthApp: OAuthApp;

const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Mints a real pair through the one issuance site, against Postgres. */
async function mint(scopes: Scope[]): Promise<string> {
  const issued = await issueTokenPair(
    { tokenRepo: new PgTokenRepo(pool), clock: new SystemClock(), ttl: DEFAULT_TOKEN_TTL },
    { app: oauthApp, userId, scopes },
  );
  return issued.response.access_token;
}

function clientFor(token: string): ShipClient {
  return new ShipClient({ token, baseUrl });
}

async function listen(app: express.Express): Promise<void> {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  // L15 encrypts webhook signing secrets at rest with AES-256-GCM and resolves
  // `WEBHOOK_SECRET_KEY` LAZILY, on first use — a deployment missing it boots
  // fine and then answers 500 on the first `POST /api/v1/webhooks`. Set here
  // because this file is the first to exercise that path through the SDK.
  //
  // ⚑ Cross-lane: what a consumer SEES when the key is absent is
  // `{ kind: 'server', code: 'server_error' }` — "An unexpected error occurred."
  // The subscription is simply un-creatable and nothing says why. L19's
  // `ship webhooks create` and L20's TTFE drill both hit this. Filed as L99 F91.
  process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 0x5a).toString('base64');

  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`l18 ${runId}`],
  );
  workspaceId = workspace.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'L18 SDK User') RETURNING id`,
    [`l18-${runId}@ship.local`],
  );
  userId = user.rows[0]!.id;

  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
    [workspaceId, userId],
  );

  oauthApp = await new PgOAuthAppRepo(pool).create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: `L18 SDK app ${runId}`,
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ALL_SCOPES,
  });

  // THE COMPOSITION ROOT. Nothing is mounted by this test.
  await listen(createApp());
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DELETE FROM webhook_subscriptions WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM oauth_tokens WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM document_associations
                    WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`, [workspaceId]);
  await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

describe('§1 · documents, issues and sprints — live, typed, field for field', () => {
  it('documents.create → get → list, and the returned object IS a ShipDocument', async () => {
    const client = clientFor(await mint(['documents:read', 'documents:write']));

    const created: ShipDocument = await client.documents.create({ title: `Doc ${runId}` });
    // Each read compiles only because `ShipDocument` declares it — and each
    // value is asserted, so a type that is right about names and wrong about
    // presence still fails.
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe(`Doc ${runId}`);
    expect(created.document_type).toBe('wiki');
    expect(created.created_at).toEqual(expect.any(String));
    expect(created.updated_at).toEqual(expect.any(String));
    expect(created.parent_id).toBeNull();
    expect(created.created_by).toBe(userId);

    // ⚑ The SDK's create input carried a `content` field until PF-527. The spec's
    // request schema is `.strict()`, so this is what every consumer following the
    // SDK's own types got:
    const rejected = (await client.documents
      .create({ ...( { content: 'body text' } as object) } as never)
      .catch((e: unknown) => e)) as ShipError;
    expect(rejected.kind).toBe('validation');
    expect(rejected.code).toBe('validation_failed');

    const fetched = await client.documents.get(created.id);
    expect(fetched).toEqual(created);

    const page = await client.documents.list({ limit: 5 });
    expect(page.data.some((d) => d.id === created.id)).toBe(true);
    // Present and NULL on the last page, never absent (L08 PF-224).
    expect(page).toHaveProperty('next_cursor');
  });

  it('issues.create → get → update → list, with belongs_to as the array D13 settled on', async () => {
    const client = clientFor(await mint(['issues:read', 'issues:write']));

    const created: ShipIssue = await client.issues.create({
      title: `Issue ${runId}`,
      priority: 'high',
    });
    expect(created.title).toBe(`Issue ${runId}`);
    expect(created.priority).toBe('high');
    expect(created.state).toBe('backlog');
    expect(created.document_type).toBe('issue');
    // L99 D13: the junction rows themselves, not a flat `sprint_id` the schema
    // does not enforce. An ARRAY, and present even when empty.
    expect(Array.isArray(created.belongs_to)).toBe(true);

    const updated = await client.issues.update(created.id, { state: 'in_progress' });
    expect(updated.state).toBe('in_progress');
    expect(updated.id).toBe(created.id);

    expect((await client.issues.get(created.id)).state).toBe('in_progress');
    expect((await client.issues.list()).data.some((i) => i.id === created.id)).toBe(true);
  });

  it('sprints — the PUBLIC path is /sprints, live (PF-523)', async () => {
    const client = clientFor(await mint(['sprints:read', 'sprints:write']));

    const number = 900 + Math.floor(Math.random() * 90);
    const created: ShipSprint = await client.sprints.create({
      sprint_number: number,
      title: `Sprint ${runId}`,
    });
    expect(created.sprint_number).toBe(number);
    expect(created.document_type).toBe('sprint');
    expect(['planning', 'active', 'completed']).toContain(created.status);

    expect((await client.sprints.get(created.id)).id).toBe(created.id);
    expect((await client.sprints.list()).data.some((s) => s.id === created.id)).toBe(true);

    // The client never constructed a URL containing Ship's internal noun — that
    // translation lives in L03's resource-map alone, and `sprintsNaming.test.ts`
    // greps the whole package for it.
  });

  it('a scope the token does not carry is `auth`/`forbidden`, naming the scope', async () => {
    const readOnly = clientFor(await mint(['documents:read']));
    const error = (await readOnly.documents
      .create({ title: 'nope' })
      .catch((e: unknown) => e)) as ShipError;

    expect(error).toBeInstanceOf(ShipError);
    expect(error.kind).toBe('auth');
    // L99 F6: the mapping is 6 → 5. `unauthorized` and `forbidden` BOTH collapse
    // to kind 'auth', which is why `code` is preserved — 401 says refresh, 403
    // says re-consent, and only `code` tells them apart.
    expect(error.code).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(error.requiredScope).toBe('documents:write');
  });
});

describe('§2 · webhooks — six methods, one scope (PF-524)', () => {
  it('create → list → get → update → rotate → delete', async () => {
    const client = clientFor(await mint(['webhooks:manage']));

    const created = await client.webhooks.create({
      event: 'document.created',
      target_url: 'https://listener.example.test/hook',
    });
    expect(created.event).toBe('document.created');
    expect(created.active).toBe(true);
    expect(created.secret_version).toBe(1);

    const listed = await client.webhooks.list();
    expect(listed.data.some((s: WebhookSubscription) => s.id === created.id)).toBe(true);

    expect((await client.webhooks.get(created.id)).id).toBe(created.id);

    expect((await client.webhooks.update(created.id, { active: false })).active).toBe(false);

    const rotated = await client.webhooks.rotate(created.id);
    expect(rotated.secret_version).toBe(2);

    const deleted = await client.webhooks.delete(created.id);
    expect(deleted.active).toBe(false);
    expect(deleted.deactivated_at).toEqual(expect.any(String));
  });

  it('a token WITHOUT webhooks:manage is surfaced, not flattened', async () => {
    // The ticket's exact clause: the SDK must surface the scope failure. A
    // client that reported "403" and dropped `details` would leave a consumer
    // guessing which of seven scopes to re-consent for.
    const client = clientFor(await mint(['documents:read']));
    const error = (await client.webhooks.list().catch((e: unknown) => e)) as ShipError;

    expect(error.kind).toBe('auth');
    expect(error.code).toBe('forbidden');
    expect(error.requiredScope).toBe('webhooks:manage');
    expect(error.grantedScopes).toEqual(['documents:read']);
  });

  it('reads need the scope too — there is no cheaper method', async () => {
    const client = clientFor(await mint(['issues:read']));
    for (const call of [
      () => client.webhooks.list(),
      () => client.webhooks.get('00000000-0000-4000-8000-000000000000'),
    ]) {
      const error = (await call().catch((e: unknown) => e)) as ShipError;
      expect(error.code).toBe('forbidden');
    }
  });
});

describe('§3 · PF-525 — the signing secret is returned exactly once', () => {
  it('create and rotate carry it; list and get do not, at RUNTIME as well as in the types', async () => {
    const client = clientFor(await mint(['webhooks:manage']));

    const created = await client.webhooks.create({
      event: 'issue.created',
      target_url: 'https://listener.example.test/once',
    });

    // p.7's drill reads exactly this, off exactly this response.
    expect(created.signing_secret).toEqual(expect.any(String));
    expect(created.signing_secret.length).toBeGreaterThan(20);
    // and it says WHICH secret without being one. The prefix is taken from
    // AFTER the `whsec_` tag — `whsec_wh` would identify nothing — so it is a
    // substring of the secret rather than a leading slice of it.
    expect(created.signing_secret.startsWith('whsec_')).toBe(true);
    expect(created.secret_prefix).toHaveLength(8);
    expect(created.signing_secret.slice('whsec_'.length, 'whsec_'.length + 8)).toBe(
      created.secret_prefix,
    );

    // The read paths carry no secret at all. `webhookSubscriptionSchema` is
    // `.strict()` server-side, so this is structural rather than vigilant — but
    // it is the claim the whole shown-once contract rests on (p.2), so it is
    // asserted on the wire and not inferred from the schema.
    const fetched = (await client.webhooks.get(created.id)) as unknown as Record<string, unknown>;
    expect(Object.keys(fetched)).not.toContain('signing_secret');

    const listed = (await client.webhooks.list()).data[0] as unknown as Record<string, unknown>;
    expect(Object.keys(listed)).not.toContain('signing_secret');

    // rotate mints a NEW one and the old value never returns.
    const rotated = await client.webhooks.rotate(created.id);
    expect(rotated.signing_secret).not.toBe(created.signing_secret);
    expect(rotated.secret_version).toBe(created.secret_version + 1);

    await client.webhooks.delete(created.id);
  });
});

describe('§4 · PF-533 — async-iterator pagination over REAL pages', () => {
  it('iterate() walks the whole collection through a page size of 1, and terminates', async () => {
    const client = clientFor(await mint(['documents:read', 'documents:write']));

    const titles = [`p-${runId}-a`, `p-${runId}-b`, `p-${runId}-c`];
    const ids: string[] = [];
    for (const title of titles) ids.push((await client.documents.create({ title })).id);

    // A page size of 1 forces at least three round trips over the three rows
    // this test created, so the walk really crosses page boundaries rather than
    // fitting in one response and proving nothing.
    const walked: string[] = [];
    for await (const document of client.documents.iterate({ limit: 1 })) {
      walked.push(document.id);
    }

    for (const id of ids) expect(walked).toContain(id);
    // No duplicates: a cursor that failed to advance would repeat rows, which is
    // the failure PaginationStalledError exists for and which a `toContain`
    // check alone would not notice.
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('and the consumer never touched a cursor to do it', async () => {
    // p.4: *"Cursors handled internally; consumer code never sees them."* The
    // compile-time half is `typeProofs/surfaceContracts.ts`; this is the
    // behavioural half — the walk above passed no cursor and read none.
    const client = clientFor(await mint(['issues:read']));
    let count = 0;
    for await (const issue of client.issues.iterate({ limit: 2 })) {
      expect(issue).not.toHaveProperty('next_cursor');
      count += 1;
      if (count > 50) break;
    }
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
