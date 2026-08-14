/**
 * PF-404, PF-408, PF-409, PF-410 — what the document write paths publish, and
 * when.
 *
 * The HTTP-level halves (PF-405 both surfaces, PF-412 the public write) live in
 * `platform/webhooks/publishFitness.test.ts`, because they need an app. What is
 * here is the domain behaviour: the transaction boundary, the pre-delete
 * capture, and the payload policy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/client.js';
import { RecordingEventBus } from '../platform/webhooks/bus.js';
import { eventEnvelopeSchema } from '../platform/webhooks/events.js';
import { createDocumentService, type DomainContext } from './documents.js';

let ctx: DomainContext;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
    `L14 docevents ${runId}`,
  ]);
  workspaceId = ws.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'L14 Doc User') RETURNING id`,
    [`l14-docevents-${runId}@ship.local`],
  );
  userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, userId],
  );
  ctx = { workspaceId, userId, db: pool };
});

afterAll(async () => {
  await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

describe('PF-404 — document.created publishes AFTER COMMIT, never inside the transaction', () => {
  it('a committed create publishes exactly one document.created whose data.id is the row', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    const created = await service.create(ctx, { title: 'Committed', documentType: 'wiki' });

    expect(bus.ofType('document.created')).toHaveLength(1);
    const envelope = bus.ofType('document.created')[0]!;
    expect((envelope.data as { id: string }).id).toBe(created.id);

    const stored = await pool.query(`SELECT id FROM documents WHERE id = $1`, [created.id]);
    expect(stored.rows).toHaveLength(1);
  });

  it('a ROLLED BACK create publishes ZERO events', async () => {
    // The ticket's named case. An association insert against a non-existent
    // `related_id` violates the FK, the transaction rolls back, and no row
    // exists — so an event here would point at nothing forever. This is the
    // assertion that would fail if the publish were moved one line up, inside
    // the try block before COMMIT.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    await expect(
      service.create(ctx, {
        title: 'Doomed',
        documentType: 'wiki',
        belongsTo: [{ id: '00000000-0000-4000-8000-0000000000ff', type: 'parent' }],
      }),
    ).rejects.toThrow();

    expect(bus.events, 'an event was published for a create that rolled back').toHaveLength(0);

    const orphan = await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND title = 'Doomed'`,
      [workspaceId],
    );
    expect(orphan.rows).toHaveLength(0);
  });

  it('the envelope parses against the registry', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    await service.create(ctx, { title: 'Shaped', documentType: 'wiki' });
    expect(() => eventEnvelopeSchema.parse(bus.events[0])).not.toThrow();
  });

  it('a document type outside the public documents resource publishes nothing', async () => {
    // `document.*` describes the public `documents` resource. An `issue` has
    // its own events; a `program` has no public resource and so nothing a
    // subscriber could resolve. Without this gate the internal create of an
    // issue would fail registry validation and take the write down with it.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    const issue = await service.create(ctx, { title: 'An issue', documentType: 'issue' });

    expect(issue.id).toBeTruthy();
    expect(bus.events).toHaveLength(0);
  });

  it('works with no bus injected — the write still happens', async () => {
    const service = createDocumentService();
    const created = await service.create(ctx, { title: 'No bus', documentType: 'wiki' });
    expect(created.id).toBeTruthy();
  });
});

describe('PF-409 — document.deleted carries the row, captured before the delete', () => {
  it('publishes a payload populated from the pre-delete row', async () => {
    // The delete is HARD (finding F10): once it returns, this envelope is the
    // only surviving record. Every field must therefore come from a read taken
    // BEFORE the statement ran.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const created = await service.create(ctx, {
      title: 'To be deleted',
      documentType: 'wiki',
    });
    bus.reset();

    const deleted = await service.delete(ctx, { id: created.id });

    expect(deleted?.id).toBe(created.id);
    expect(bus.ofType('document.deleted')).toHaveLength(1);

    const data = bus.ofType('document.deleted')[0]!.data as Record<string, unknown>;
    expect(data.id).toBe(created.id);
    expect(data.title, 'the title was not captured before the delete').toBe('To be deleted');
    expect(data.document_type).toBe('wiki');
    expect(data.created_by).toBe(userId);
    expect(data.deleted_at).toBeTruthy();
    expect(data.created_at).toBeTruthy();
  });

  it('the row really is gone, so the payload is the only record left', async () => {
    // This is the assertion that makes PF-409 more than a preference: it proves
    // the subscriber cannot fetch what it was not told.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const created = await service.create(ctx, { title: 'Gone', documentType: 'wiki' });

    await service.delete(ctx, { id: created.id });

    const after = await pool.query(`SELECT id FROM documents WHERE id = $1`, [created.id]);
    expect(after.rows, 'the delete was soft — F10 no longer holds, revisit PF-409').toHaveLength(0);
  });

  it('the deleted envelope parses against the registry', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const created = await service.create(ctx, { title: 'Parse me', documentType: 'wiki' });
    await service.delete(ctx, { id: created.id });
    expect(() => eventEnvelopeSchema.parse(bus.ofType('document.deleted')[0])).not.toThrow();
  });

  it('deleting something that is not there returns null and publishes nothing', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const result = await service.delete(ctx, { id: '00000000-0000-4000-8000-0000000000ee' });
    expect(result).toBeNull();
    expect(bus.events).toHaveLength(0);
  });

  it('will not delete across workspaces, and publishes nothing when it declines', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const created = await service.create(ctx, { title: 'Other tenant', documentType: 'wiki' });
    bus.reset();

    const result = await service.delete(
      { workspaceId: '00000000-0000-4000-8000-0000000000ff', userId, db: pool },
      { id: created.id },
    );

    expect(result).toBeNull();
    expect(bus.events).toHaveLength(0);
    const still = await pool.query(`SELECT id FROM documents WHERE id = $1`, [created.id]);
    expect(still.rows).toHaveLength(1);
  });
});

describe('D7 / PF-408 — the payload is the public representation, and never document content', () => {
  const SENTINEL = 'SENTINEL-a7f3e9c1-never-in-an-envelope';

  it('a document body containing a sentinel string appears in NO envelope', async () => {
    // The ticket's named test. D7 ships the public API representation, and that
    // projection (L09's PF-252 allowlist) contains no `content` and no
    // `properties` — so this holds by construction rather than by filtering.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    const created = await service.create(ctx, {
      title: 'Has a body',
      documentType: 'wiki',
      content: { type: 'doc', content: [{ type: 'text', text: SENTINEL }] },
      properties: { secret_note: SENTINEL },
    });

    await service.delete(ctx, { id: created.id });

    expect(bus.events.length).toBeGreaterThanOrEqual(2);
    for (const envelope of bus.events) {
      expect(
        JSON.stringify(envelope),
        `${envelope.type} leaked document content into its payload`,
      ).not.toContain(SENTINEL);
    }
  });

  it('the payload key set is exactly the public projection plus visibility', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    await service.create(ctx, { title: 'Key set', documentType: 'wiki' });

    const data = bus.ofType('document.created')[0]!.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'created_at',
        'created_by',
        'document_type',
        'id',
        'parent_id',
        'title',
        'updated_at',
        'visibility',
      ].sort(),
    );
  });
});

describe('PF-410 — private documents, and why the answer is a field rather than a redaction', () => {
  it('a private document publishes visibility:private, WITH its title', async () => {
    // The ticketed fix was to omit `title` when private. Rejected: the bus is
    // in-process and is not the exposure boundary — L15's matcher is — and a
    // payload whose shape depends on a row's ACL state is one no consumer can
    // type. The matcher gets `visibility` and `created_by` and gates delivery
    // on them, which is also the only thing that can work for
    // `document.deleted`, where F10 leaves no row to read them from.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    await service.create(ctx, {
      title: 'Private plans',
      documentType: 'wiki',
      visibility: 'private',
    });

    const data = bus.ofType('document.created')[0]!.data as Record<string, unknown>;
    expect(data.visibility).toBe('private');
    expect(data.title).toBe('Private plans');
    expect(
      data.created_by,
      'the matcher needs created_by to decide who may receive a private document',
    ).toBe(userId);
  });

  it('a workspace document publishes visibility:workspace', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    await service.create(ctx, { title: 'Shared', documentType: 'wiki', visibility: 'workspace' });
    expect((bus.ofType('document.created')[0]!.data as { visibility: string }).visibility).toBe(
      'workspace',
    );
  });

  it('a deleted private document still reports its visibility', async () => {
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });
    const created = await service.create(ctx, {
      title: 'Private and gone',
      documentType: 'wiki',
      visibility: 'private',
    });
    bus.reset();

    await service.delete(ctx, { id: created.id });

    expect((bus.ofType('document.deleted')[0]!.data as { visibility: string }).visibility).toBe(
      'private',
    );
  });
});
