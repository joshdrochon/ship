#!/usr/bin/env node
/**
 * Audit seed augmentation — Category 3 (API Response Time) prerequisite.
 *
 * The brief (p.4) calls for "500+ documents, 100+ issues, 20+ users, 10+ sprints"
 * before benchmarking. `pnpm db:seed` produces 257 / 104 / 11 / 35, so documents
 * and users fall short. This tops both up without touching api/src/db/seed.ts.
 *
 * It also gives the new documents realistic bodies. The stock seed leaves
 * issue/sprint/project content at the 51-byte empty-paragraph default, which
 * would make any response-time measurement optimistic.
 *
 * Idempotent: augmented rows carry properties->>'_audit_fixture' = 'true' and are
 * deleted before re-inserting, so running twice does not double the volume.
 *
 *   node docs/audit/scripts/augment-seed.mjs          # top up to targets
 *   node docs/audit/scripts/augment-seed.mjs --clean  # remove augmented rows only
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const require = createRequire(join(REPO, 'api', 'package.json'));
const { Pool } = require('pg');

// Targets from the brief, p.4. Set above the minimum so incidental deletions
// during testing don't silently drop us under the bar.
const TARGET = { documents: 600, issues: 120, users: 25, sprints: 35 };
const MARKER = '_audit_fixture';

function databaseUrl() {
  for (const f of ['api/.env.local', 'api/.env']) {
    try {
      const m = readFileSync(join(REPO, f), 'utf8').match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* next */ }
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error('No DATABASE_URL found in api/.env.local, api/.env, or the environment');
}

// -- deterministic PRNG so successive runs produce identical data ------------
let seed = 20260728;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const NOUNS = ['pipeline', 'schema', 'index', 'cache', 'session', 'migration', 'endpoint',
  'validator', 'listener', 'renderer', 'scheduler', 'collector', 'gateway', 'resolver'];
const VERBS = ['refactor', 'harden', 'instrument', 'benchmark', 'document', 'decouple',
  'consolidate', 'backfill', 'deprecate', 'stabilise'];
const AREAS = ['auth', 'collaboration', 'documents', 'search', 'weeks', 'admin', 'billing',
  'notifications', 'exports', 'audit-log'];
const STATES = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const sentence = () =>
  `The ${pick(AREAS)} ${pick(NOUNS)} needs work before we can ${pick(VERBS)} the ${pick(NOUNS)}. ` +
  `Current behaviour depends on the ${pick(NOUNS)} staying warm, which does not hold under load.`;

/** TipTap doc JSON with headings, prose, lists and code — 1–8 KB, like a real page. */
function body(paragraphs) {
  const content = [];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 4 === 0) {
      content.push({
        type: 'heading',
        attrs: { level: i === 0 ? 2 : 3 },
        content: [{ type: 'text', text: `${pick(VERBS)} the ${pick(AREAS)} ${pick(NOUNS)}` }],
      });
    }
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: `${sentence()} ${sentence()}` }],
    });
    if (i % 5 === 3) {
      content.push({
        type: 'bulletList',
        content: Array.from({ length: int(2, 5) }, () => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: sentence() }] }],
        })),
      });
    }
    if (i % 7 === 5) {
      content.push({
        type: 'codeBlock',
        attrs: { language: 'sql' },
        content: [{
          type: 'text',
          text: `SELECT id, title FROM documents\n WHERE workspace_id = $1\n   AND document_type = '${pick(['issue', 'sprint', 'project'])}'\n ORDER BY updated_at DESC\n LIMIT 50;`,
        }],
      });
    }
  }
  return { type: 'doc', content };
}

function properties(type) {
  const base = { [MARKER]: true };
  switch (type) {
    case 'issue':
      return { ...base, state: pick(STATES), priority: pick(PRIORITIES), estimate: int(1, 13), area: pick(AREAS) };
    case 'project':
      return { ...base, status: pick(['planning', 'active', 'paused', 'shipped']), vision: sentence(), goals: [sentence(), sentence()] };
    case 'program':
      return { ...base, status: pick(['active', 'archived']), owner_area: pick(AREAS) };
    case 'wiki':
      return { ...base, tags: [pick(AREAS), pick(AREAS)] };
    default:
      return { ...base, summary: sentence() };
  }
}

async function counts(db) {
  const { rows: [d] } = await db.query('SELECT count(*)::int n FROM documents');
  const { rows: [i] } = await db.query("SELECT count(*)::int n FROM documents WHERE document_type='issue'");
  const { rows: [u] } = await db.query('SELECT count(*)::int n FROM users');
  const { rows: [s] } = await db.query("SELECT count(*)::int n FROM documents WHERE document_type='sprint'");
  return { documents: d.n, issues: i.n, users: u.n, sprints: s.n };
}

async function clean(db) {
  const { rowCount: docs } = await db.query(
    `DELETE FROM documents WHERE properties->>'${MARKER}' = 'true'`);
  const { rowCount: users } = await db.query(
    `DELETE FROM users WHERE email LIKE 'audit.fixture+%@ship.local'`);
  return { docs, users };
}

async function main() {
  const db = new Pool({ connectionString: databaseUrl() });
  const cleanOnly = process.argv.includes('--clean');

  try {
    const before = await counts(db);
    console.log('before:', before);

    const removed = await clean(db);
    if (removed.docs || removed.users) {
      console.log(`removed prior fixtures: ${removed.docs} documents, ${removed.users} users`);
    }
    if (cleanOnly) {
      console.log('after: ', await counts(db));
      return;
    }

    const { rows: [ws] } = await db.query('SELECT id FROM workspaces ORDER BY created_at LIMIT 1');
    if (!ws) throw new Error('No workspace found — run `pnpm db:seed` first');

    // --- users ---------------------------------------------------------------
    const cur = await counts(db);
    const needUsers = Math.max(0, TARGET.users - cur.users);
    const userIds = [];
    for (let i = 0; i < needUsers; i++) {
      const { rows: [u] } = await db.query(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        [`audit.fixture+${i}@ship.local`, `Fixture User ${i + 1}`,
         '$2b$10$K7L1OJ0/9wXQKZq1sVh0kOaZ8gGqZ3qYqZ3qYqZ3qYqZ3qYqZ3qYq']);
      userIds.push(u.id);
      await db.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [ws.id, u.id]);
    }
    console.log(`+${needUsers} users`);

    // --- documents -----------------------------------------------------------
    const { rows: allUsers } = await db.query('SELECT id FROM users');
    const authors = allUsers.map((r) => r.id);
    const { rows: parents } = await db.query(
      `SELECT id, document_type FROM documents
        WHERE document_type IN ('project','sprint','program') AND properties->>'${MARKER}' IS NULL`);

    const needIssues = Math.max(0, TARGET.issues - cur.issues);
    const needDocs = Math.max(0, TARGET.documents - cur.documents);
    const mix = [
      ...Array(needIssues).fill('issue'),
      ...Array(Math.max(0, needDocs - needIssues)).fill(null),
    ].map((t) => t ?? pick(['wiki', 'issue', 'project', 'program', 'weekly_plan', 'weekly_retro', 'standup']));

    let assoc = 0;
    for (let i = 0; i < mix.length; i++) {
      const type = mix[i];
      const { rows: [doc] } = await db.query(
        `INSERT INTO documents (workspace_id, document_type, title, content, properties, created_by, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ws.id, type,
         `${pick(VERBS)[0].toUpperCase()}${pick(VERBS).slice(1)} ${pick(AREAS)} ${pick(NOUNS)} #${i + 1}`,
         JSON.stringify(body(int(3, 14))),
         JSON.stringify(properties(type)),
         pick(authors), i]);

      // Exercise the junction table the batch loader reads (F15).
      if (parents.length && rnd() < 0.7) {
        const p = pick(parents);
        const rel = p.document_type === 'sprint' ? 'sprint'
                  : p.document_type === 'project' ? 'project' : 'program';
        await db.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [doc.id, p.id, rel]);
        assoc++;
      }
      if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${mix.length} documents`);
    }
    console.log(`+${mix.length} documents, +${assoc} associations`);

    const after = await counts(db);
    console.log('after: ', after);

    const short = Object.entries({ documents: 500, issues: 100, users: 20, sprints: 10 })
      .filter(([k, min]) => after[k] < min);
    if (short.length) {
      console.error('BELOW BRIEF MINIMUMS:', short.map(([k, m]) => `${k} ${after[k]}<${m}`).join(', '));
      process.exitCode = 1;
    } else {
      console.log('All p.4 minimums met (500+ docs, 100+ issues, 20+ users, 10+ sprints)');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
