/**
 * PF-411 / PF-412 — the rule this lane exists for, mechanised.
 *
 * PRD p.3: *"Domain layer publishes on writes — **never the route layer**."*
 * `docs/architecture.md` draws it (`SVC->>BUS: publish(document.created) —
 * domain publishes, never the route layer`), and the spine's Sequencing Risks
 * table calls it out by name. This file is the difference between a rule that is
 * drawn and one that holds.
 *
 * ## The vacuity problem, which is the whole design of PF-411
 *
 * A scan that only says "no route file contains `.publish(`" passes perfectly on
 * a codebase where NOTHING publishes anywhere. That is not a hypothetical — it
 * was the state of this repo until this lane landed, and a green fitness test
 * over it would have been actively misleading. So the test has three parts and
 * needs all three:
 *
 *   1. no `.publish(`, no `IEventBus`, no events-module import under
 *      `platform/api/v1/**` or `routes/**`
 *   2. the allowlist of domain modules permitted to publish is NON-EMPTY
 *   3. every module on that allowlist really does contain a publish call
 *
 * Drop (2) and (3) and the rule rots the moment someone deletes the last
 * publisher — the suite stays green and the architecture claim becomes false
 * silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../services/documents.js';
import { mountDocuments } from '../api/v1/documents/routes.js';
import { RecordingEventBus } from './bus.js';
import { eventEnvelopeSchema } from './events.js';

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The ONLY modules allowed to publish. Domain services, by definition.
 *
 * Adding an entry here is a deliberate act and should be argued for in review:
 * the question is always "is this a domain service, or is it a handler that
 * wants to be one".
 */
const PUBLISH_ALLOWLIST = [
  join('services', 'documents.ts'),
  join('services', 'sprints.ts'),
];

/** Trees that must never publish. */
const FORBIDDEN_TREES = [join('platform', 'api', 'v1'), 'routes'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments stripped.
 *
 * The route modules DOCUMENT this rule — `routes/weeks.ts` and the public
 * documents router both explain in prose that they must not publish. Grepping
 * raw text would fail them for saying so, which is a fitness test that punishes
 * writing the rule down next to the code it governs.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('PF-411 — nothing under the route layer publishes', () => {
  const routeFiles = FORBIDDEN_TREES.flatMap((tree) => walk(join(API_SRC, tree))).filter(
    (f) => !f.endsWith('.test.ts'),
  );

  it('scans a non-empty set of route files', () => {
    // Part of the same anti-vacuity discipline: a scan over zero files passes.
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it('no route file calls .publish(', () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const code = codeOf(file);
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('.publish(')) {
          offenders.push(`${file.slice(API_SRC.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      'PRD p.3: the domain layer publishes on writes, never the route layer. ' +
        'Move the publish into the domain service the handler already calls — ' +
        'two surfaces mean two publish sites, and the one nobody remembers is ' +
        'the one that stops firing.',
    ).toEqual([]);
  });

  it('no route file names IEventBus', () => {
    // A handler holding the bus TYPE is a handler one line away from using it.
    // The public documents router types its injected bus as `unknown` and hands
    // it straight to the service, which is the shape that keeps this true.
    const offenders: string[] = [];
    for (const file of routeFiles) {
      if (/\bIEventBus\b/.test(codeOf(file))) offenders.push(file.slice(API_SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('no route file imports the bus or the payload builders', () => {
    // `bus.js` and `payloads.js` are the PUBLISH machinery and stay fully
    // banned from the route layer — importing either is the shape of the defect
    // this rule exists to prevent.
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const code = codeOf(file);
      if (/from\s+['"][^'"]*webhooks\/(bus|payloads)\.js['"]/.test(code)) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * NARROWED by L15, and the narrowing is the point rather than an exemption.
   *
   * `events.ts` carries two different things behind one filename: the PUBLISH
   * vocabulary (`EventEnvelope`, `PublishInput`, `EventRegistry`) and the
   * READ-ONLY registry of event-type names (`EVENT_TYPES`, `assertEventType`).
   * The original rule banned the whole module from the route layer, which is
   * right for the first half and wrong for the second — L15's
   * `POST /api/v1/webhooks` has to validate a requested event type, and PF-429
   * requires it to do that by calling `assertEventType` rather than restating
   * the eight names, precisely so that registering a ninth type is not an edit
   * to a route handler. That is the same Open/Closed property PF-395 proves.
   *
   * The two candidate resolutions were: restate the names in the route (banned
   * by PF-429, and the drift PF-395 exists to prevent), or re-export the
   * validation surface from a module outside `webhooks/` (laundering an import
   * to defeat a grep, which is worse than either). So the rule is narrowed to
   * what it is actually about, and the ban on the publish half is now
   * ENFORCED BY NAME rather than by filename — which is stricter than what it
   * replaced, not looser.
   *
   * Filed as a cross-lane amendment in `lane-99-unassigned.md`.
   */
  const REGISTRY_READ_ONLY = new Set([
    'EVENT_TYPES',
    'EventType',
    'isEventType',
    'assertEventType',
    'UnknownEventTypeError',
    'eventPayloadSchemas',
    'eventEnvelopeSchema',
  ]);

  it('a route file may import the event REGISTRY, and nothing else from events.js', () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const code = codeOf(file);
      for (const match of code.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]*webhooks\/events\.js['"]/g,
      )) {
        const named = match[1]!
          .split(',')
          .map((s) => s.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]!.trim())
          .filter(Boolean);
        const forbidden = named.filter((n) => !REGISTRY_READ_ONLY.has(n));
        if (forbidden.length > 0) {
          offenders.push(`${file.slice(API_SRC.length + 1)}: ${forbidden.join(', ')}`);
        }
      }
      // A namespace or default import defeats the name check entirely.
      if (/import\s+\*\s+as[^;]*webhooks\/events\.js/.test(code)) {
        offenders.push(`${file.slice(API_SRC.length + 1)}: namespace import`);
      }
    }
    expect(
      offenders,
      'A route may read the event-type registry (PF-429 requires it) but may not import ' +
        'the publish vocabulary — EventEnvelope, PublishInput or EventRegistry in a handler ' +
        'is a handler one line from publishing.',
    ).toEqual([]);
  });

  it('the read-only allowlist really excludes the publish vocabulary', () => {
    // Anti-vacuity, in the same spirit as the allowlist checks below: an
    // allowlist that happened to contain every export of `events.ts` would pass
    // the scan above and mean nothing.
    for (const name of ['EventEnvelope', 'PublishInput', 'EventRegistry']) {
      expect(REGISTRY_READ_ONLY.has(name), `${name} must not be route-importable`).toBe(false);
    }
  });
});

describe('PF-411 — the allowlist is real, which is what stops the rule rotting', () => {
  it('is non-empty', () => {
    // An empty allowlist over an unwired codebase passes the scan above
    // perfectly. That was literally this repo's state before this lane.
    expect(PUBLISH_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it('every allowlisted module really contains a publish call', () => {
    for (const entry of PUBLISH_ALLOWLIST) {
      const code = codeOf(join(API_SRC, entry));
      expect(
        code.includes('.publish('),
        `${entry} is allowlisted as a publisher but contains no publish call. ` +
          `Either it stopped publishing — in which case an event type has silently ` +
          `lost its producer — or the allowlist is stale.`,
      ).toBe(true);
    }
  });

  it('no module OUTSIDE the allowlist publishes anywhere in api/src', () => {
    // The complement of the route-layer scan, and stronger: it catches a
    // publish that appears in a util, a script or a middleware — places the
    // forbidden-tree list does not name.
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      if (file.endsWith('.test.ts')) continue;
      const relative = file.slice(API_SRC.length + 1);
      if (PUBLISH_ALLOWLIST.includes(relative)) continue;
      // The bus itself declares and implements `publish`; it is not a caller.
      if (relative.startsWith(join('platform', 'webhooks'))) continue;
      if (codeOf(file).includes('.publish(')) offenders.push(relative);
    }
    expect(
      offenders,
      'These modules publish but are not on PUBLISH_ALLOWLIST in publishFitness.test.ts. ' +
        'If one is genuinely a domain service, add it there deliberately.',
    ).toEqual([]);
  });
});

describe('PF-412 — TS-6 substrate: a real public write publishes one valid envelope', () => {
  let harness: BearerTestApp;
  let bus: RecordingEventBus;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L14 ts6 ${runId}`,
    ]);
    workspaceId = ws.rows[0].id;
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'L14 TS6') RETURNING id`,
      [`l14-ts6-${runId}@ship.local`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    bus = new RecordingEventBus();
    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountDocuments(router, { db: pool, service: createDocumentService({ bus }) }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  it('POST /api/v1/documents with a bearer token records exactly one document.created', async () => {
    // TS-6's first half (p.5), and p.8's trigger contract: "Document created;
    // document.created event published on the bus; subscribers receive POST."
    // The signed POST, the 2s budget and the tamper check are L15's.
    //
    // Asserted on the PARSED ENVELOPE, not on a log line — a log line would
    // pass for a malformed payload, which is exactly what would then reach the
    // signer.
    bus.reset();
    const write = `Bearer ${(await harness.mint(['documents:write'])).access_token}`;

    const created = await request(harness.app)
      .post('/api/v1/documents')
      .set('Authorization', write)
      .send({ title: 'TS-6 document' });

    expect(created.status).toBe(201);

    const envelopes = bus.ofType('document.created');
    expect(envelopes).toHaveLength(1);

    const envelope = eventEnvelopeSchema.parse(envelopes[0]);
    expect(envelope.workspace_id).toBe(workspaceId);
    expect((envelope.data as { id: string }).id).toBe(created.body.id);
    expect((envelope.data as { title: string }).title).toBe('TS-6 document');
    expect(envelope.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the envelope is on the bus BEFORE the HTTP response returns', async () => {
    // The publish is synchronous and awaited inside the domain write (PF-399),
    // so by the time supertest has a response the event is already recorded.
    // If publishing were deferred to a timer this would be a race and the
    // assertion would flake — which is why the bus has no timers.
    bus.reset();
    const write = `Bearer ${(await harness.mint(['documents:write'])).access_token}`;

    await request(harness.app)
      .post('/api/v1/documents')
      .set('Authorization', write)
      .send({ title: 'Already there' });

    expect(bus.ofType('document.created')).toHaveLength(1);
  });

  it('a REJECTED public write publishes nothing', async () => {
    // 400 on a bad body. Nothing committed, so nothing may be announced.
    bus.reset();
    const write = `Bearer ${(await harness.mint(['documents:write'])).access_token}`;

    const bad = await request(harness.app)
      .post('/api/v1/documents')
      .set('Authorization', write)
      .send({ title: '' });

    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bus.events).toHaveLength(0);
  });

  it('an UNAUTHENTICATED write publishes nothing', async () => {
    bus.reset();
    const denied = await request(harness.app).post('/api/v1/documents').send({ title: 'No token' });
    expect(denied.status).toBe(401);
    expect(bus.events).toHaveLength(0);
  });

  it('a write with the wrong scope publishes nothing', async () => {
    bus.reset();
    const readOnly = `Bearer ${(await harness.mint(['documents:read'])).access_token}`;
    const denied = await request(harness.app)
      .post('/api/v1/documents')
      .set('Authorization', readOnly)
      .send({ title: 'Wrong scope' });

    expect(denied.status).toBe(403);
    expect(bus.events).toHaveLength(0);
  });
});

describe('PF-405 — one publish, both surfaces', () => {
  it('the internal session route gets a bus-carrying service from the composition root', async () => {
    // `docs/architecture.md` marks the internal path "same service, same
    // publish". Before PF-405 that was true of the public router only: the
    // internal route used the module-level service, which carries no bus, so a
    // document created through the Ship UI — which is where documents are
    // actually created — published nothing at all.
    const { createApp } = await import('../../app.js');
    const { testDeps } = await import('../../deps.js');
    const bus = new RecordingEventBus();
    const app = createApp(testDeps({ bus }));

    const internalService = app.locals.documentService as ReturnType<typeof createDocumentService>;

    expect(
      internalService,
      'createApp did not put a document service on app.locals — the internal ' +
        'surface is back to the module default and publishes nothing.',
    ).toBeTruthy();
    expect(internalService.bus, 'the internal service did not get the injected bus').toBe(bus);
  });

  it('each surface produces exactly ONE document.created, with the same envelope shape', async () => {
    const { createApp } = await import('../../app.js');
    const { testDeps } = await import('../../deps.js');

    const internalBus = new RecordingEventBus();
    const app = createApp(testDeps({ bus: internalBus }));
    const internalService = app.locals.documentService as ReturnType<typeof createDocumentService>;

    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L14 both ${runId}`,
    ]);
    const wsId = ws.rows[0].id;
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Both') RETURNING id`,
      [`l14-both-${runId}@ship.local`],
    );
    const uId = user.rows[0].id;

    try {
      await internalService.create(
        { workspaceId: wsId, userId: uId, db: pool },
        { title: 'Internal write', documentType: 'wiki' },
      );

      // Exactly one — not zero (unwired) and not two (a route publishing on top
      // of the service, which is the duplicate PF-411 exists to prevent).
      expect(internalBus.ofType('document.created')).toHaveLength(1);

      const publicBus = new RecordingEventBus();
      const publicService = createDocumentService({ bus: publicBus });
      await publicService.create(
        { workspaceId: wsId, userId: uId, db: pool },
        { title: 'Public write', documentType: 'wiki' },
      );
      expect(publicBus.ofType('document.created')).toHaveLength(1);

      // Identical envelope SHAPE, differing only in data and id — p.8's contract.
      const a = internalBus.ofType('document.created')[0]!;
      const b = publicBus.ofType('document.created')[0]!;
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      expect(Object.keys(a.data as object).sort()).toEqual(Object.keys(b.data as object).sort());
      expect(a.id).not.toBe(b.id);
    } finally {
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [wsId]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [uId]);
    }
  });
});
