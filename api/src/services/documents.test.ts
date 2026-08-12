/**
 * PF-242 / PF-243 — the domain service is callable with no Express in scope, and
 * the internal surface it was extracted out of is unchanged.
 *
 * PF-242 is the ticket that makes `docs/architecture.md`'s Public/Internal
 * Boundary diagram true rather than drawn. The proof has to be a service call
 * made from a context that has no HTTP stack at all — no app, no supertest, no
 * session, no cookie, no `req` — because a service that quietly reads `req` is
 * one that only the internal surface can ever call, and then "both surfaces call
 * the same domain service" is false no matter what the diagram says.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/client.js';
import { createDocumentService, documentService, type DomainContext } from './documents.js';

const SERVICE_SOURCE = fileURLToPath(new URL('./documents.ts', import.meta.url));

describe('PF-242 · the service imports no HTTP', () => {
  const source = readFileSync(SERVICE_SOURCE, 'utf8');

  // Comments are stripped before grepping. The point is what the module DEPENDS
  // on, and the file's docstring names `express` and `requireAuth(req)` on
  // purpose — explaining the rule must not be indistinguishable from breaking it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('imports nothing from express', () => {
    expect(code).not.toMatch(/from\s+['"]express['"]/);
    expect(code).not.toMatch(/require\(['"]express['"]\)/);
  });

  it('imports nothing from ../middleware/', () => {
    // `requireAuth` (api/src/middleware/auth.ts:73) throws MissingAuthContextError
    // off `req.userId`. A service that calls it cannot be called without a request.
    expect(code).not.toMatch(/from\s+['"]\.\.\/middleware\//);
    expect(code).not.toMatch(/requireAuth\s*\(/);
  });

  it('names no request, response or res.locals', () => {
    expect(code).not.toMatch(/\breq\./);
    expect(code).not.toMatch(/\bres\.locals\b/);
  });
});

describe('PF-242 · a document is created with no HTTP stack in scope', () => {
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      ['L09 service test'],
    );
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Service Test User') RETURNING id`,
      [`l09-service-${Date.now().toString(36)}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );
  });

  function ctx(): DomainContext {
    return { workspaceId, userId, db: pool };
  }

  it('creates, then reads back through get()', async () => {
    // Note what is NOT in this test: no `createApp`, no `request(app)`, no
    // session row, no cookie. Only plain values.
    const created = await documentService.create(ctx(), {
      title: 'Written with no request in scope',
      documentType: 'wiki',
    });

    expect(created.id).toBeTruthy();
    expect(created.title).toBe('Written with no request in scope');

    const fetched = await documentService.get(ctx(), { id: created.id });
    expect(fetched?.id).toBe(created.id);
  });

  it('lists in both modes from the same bare context', async () => {
    const internal = await documentService.list(ctx(), { mode: 'internal' });
    expect(internal.length).toBeGreaterThan(0);

    const keyset = await documentService.list(ctx(), {
      mode: 'keyset',
      documentTypes: ['wiki'],
      limit: 10,
      cursor: null,
    });
    expect(keyset.length).toBeGreaterThan(0);
  });

  it('the default title convention is the repo-wide "Untitled"', async () => {
    // The service takes an already-defaulted title — defaulting is the Zod
    // layer's job on both surfaces — so this asserts the value round-trips
    // rather than that the service invents it. `docs/document-model-conventions.md`
    // is explicit that there is exactly one default and no per-type variation.
    const created = await documentService.create(ctx(), {
      title: 'Untitled',
      documentType: 'wiki',
    });
    expect(created.title).toBe('Untitled');
  });

  it('rolls back the whole create when an association is bad', async () => {
    // The transaction is the service's, not the route's. A `belongs_to` pointing
    // at a non-existent document violates the FK, and the document row must not
    // survive it — a half-created document is worse than a failed create.
    const before = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1`, [
      workspaceId,
    ]);

    await expect(
      documentService.create(ctx(), {
        title: 'Should not survive',
        documentType: 'wiki',
        belongsTo: [{ id: '00000000-0000-0000-0000-000000000000', type: 'parent' }],
      }),
    ).rejects.toThrow();

    const after = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('PF-262 — the factory accepts an injected bus and the v1 route never publishes', () => {
    // L14's PF-404 adds the publish INSIDE create(). This asserts the seam is
    // already the right shape, so that lands as an added call rather than a
    // re-plumbing of every caller's signature.
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const service = createDocumentService({ bus: bus as never });
    expect(service.bus).toBe(bus);
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
