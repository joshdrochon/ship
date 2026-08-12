/**
 * Fitness tests for the OAuth app registry — lane L02.
 *
 * These assert properties of the SOURCE, not of a running system: "there is
 * exactly one hashing site", "no weak randomness under platform/apps", "the
 * projection is defined once". Ordinary unit tests cannot express those, and
 * every one of them is a property a well-meaning later edit can break without
 * failing anything else.
 *
 * Covers PF-033, PF-034, PF-036, PF-037, PF-038, PF-041.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS_DIR = join(HERE, '..', 'platform', 'apps');
const API_SRC = join(HERE, '..');

/** Source files under platform/apps/, excluding the tests themselves. */
function appsSourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(APPS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(APPS_DIR, name), 'utf-8') }));
}

/** Every .ts file under api/src, recursively, excluding tests and migrations. */
function allApiSources(dir = API_SRC): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'migrations') continue;
      out.push(...allApiSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push({ path: full, text: readFileSync(full, 'utf-8') });
    }
  }
  return out;
}

/**
 * Strips block and line comments.
 *
 * Every one of these files carries a long header explaining the very rule being
 * asserted — the D1 write-up in secrets.ts says the words "Math.random" and
 * "createHash" in prose. Counting those would make the tests fail on their own
 * documentation, so the checks run against code only. This helper is crude but
 * adequate: these files contain no regex or string literal holding `//`.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('PF-033 — no weak randomness under platform/apps/', () => {
  it('uses no Math.random, no Date.now-derived seed, and no uuid', () => {
    // The entropy claim in D1 is the whole no-salt defense. A secret seeded
    // from Math.random or a timestamp has nothing like 256 bits behind it, and
    // the defense would be false rather than merely weaker.
    const offenders: string[] = [];
    for (const { name, text } of appsSourceFiles()) {
      const code = stripComments(text);
      if (/Math\.random/.test(code)) offenders.push(`${name}: Math.random`);
      if (/Date\.now\s*\(\s*\)/.test(code)) offenders.push(`${name}: Date.now()`);
      if (/\buuid\b|randomUUID/.test(code)) offenders.push(`${name}: uuid`);
    }
    expect(offenders).toEqual([]);
  });

  it('draws its randomness from crypto.randomBytes', () => {
    const secrets = readFileSync(join(APPS_DIR, 'secrets.ts'), 'utf-8');
    expect(stripComments(secrets)).toContain('crypto.randomBytes');
  });
});

describe('PF-034 — exactly one client-secret hashing site', () => {
  it('defines hashClientSecret once', () => {
    const definitions = appsSourceFiles().filter(({ text }) =>
      /export function hashClientSecret/.test(stripComments(text))
    );
    expect(definitions.map((d) => d.name)).toEqual(['secrets.ts']);
  });

  it('has no second createHash(sha256) call under platform/apps/', () => {
    // One site means one place to audit and one place to change. A second call
    // is how an algorithm change ships half-applied.
    const sites: string[] = [];
    for (const { name, text } of appsSourceFiles()) {
      const matches = stripComments(text).match(/createHash\(\s*['"]sha256['"]\s*\)/g) ?? [];
      for (let i = 0; i < matches.length; i++) sites.push(name);
    }
    expect(sites).toEqual(['secrets.ts']);
  });

  it('does not import the internal middleware hasher (L01 PF-010 boundary)', () => {
    // The duplication with api/src/middleware/auth.ts is DELIBERATE. platform/**
    // may not import internal middleware, so the algorithm matches by
    // convention. This test pins the boundary, and secrets.ts's header records
    // why the duplication is not an oversight.
    for (const { name, text } of appsSourceFiles()) {
      expect(stripComments(text), `${name} must not import internal middleware`).not.toMatch(
        /from\s+['"].*middleware\//
      );
    }
  });

  it('the migration creates no salt column', () => {
    const migration = readFileSync(
      join(API_SRC, 'db', 'migrations', '039_oauth_apps.sql'),
      'utf-8'
    );
    // Comments in the migration explain WHY there is no salt, so the check has
    // to look at the column definitions rather than at the prose.
    const body = migration.replace(/^\s*--.*$/gm, '');
    expect(body).not.toMatch(/\bsalt\b/i);
  });
});

describe('PF-036 — exactly one client-secret comparison site', () => {
  it('calls timingSafeEqual from exactly one function, and never uses === on digests', () => {
    const sites: string[] = [];
    for (const { name, text } of appsSourceFiles()) {
      const matches = stripComments(text).match(/timingSafeEqual/g) ?? [];
      for (let i = 0; i < matches.length; i++) sites.push(name);
    }
    expect(sites).toEqual(['secrets.ts']);
  });

  it('the repo module compares digests only through digestsEqual', () => {
    const repo = stripComments(readFileSync(join(APPS_DIR, 'repo.ts'), 'utf-8'));
    expect(repo).toContain('digestsEqual');
    // A === between two *Digest variables is the regression this catches.
    expect(repo).not.toMatch(/Digest\s*===/);
  });
});

describe('PF-037 — the repository is constructed in the composition root only', () => {
  it('PgOAuthAppRepo is instantiated nowhere but deps.ts', () => {
    const sites = allApiSources()
      .filter(({ text }) => /new PgOAuthAppRepo\(/.test(stripComments(text)))
      .map(({ path }) => path.slice(API_SRC.length + 1));
    expect(sites).toEqual(['deps.ts']);
  });

  it('InMemoryOAuthAppRepo is instantiated nowhere but deps.ts', () => {
    const sites = allApiSources()
      .filter(({ text }) => /new InMemoryOAuthAppRepo\(/.test(stripComments(text)))
      .map(({ path }) => path.slice(API_SRC.length + 1));
    expect(sites).toEqual(['deps.ts']);
  });

  it('no Express or pg type appears in the repository interface', () => {
    // This is what lets L04/L05/L06 build against the interface with no HTTP
    // stack and no database.
    const repo = stripComments(readFileSync(join(APPS_DIR, 'repo.ts'), 'utf-8'));
    expect(repo).not.toMatch(/from\s+['"]express['"]/);
    expect(repo).not.toMatch(/from\s+['"]pg['"]/);
    expect(repo).not.toMatch(/\b(Request|Response|NextFunction|QueryResult|Pool)\b/);
  });
});

describe('PF-038 — the public projection is one allowlist', () => {
  it('oauthAppPublicSchema is defined exactly once', () => {
    const definitions = allApiSources()
      .filter(({ text }) => /export const oauthAppPublicSchema/.test(stripComments(text)))
      .map(({ path }) => path.slice(API_SRC.length + 1));
    expect(definitions).toEqual(['platform/apps/schema.ts']);
  });

  it('is an allowlist with .strict(), not an omission list', () => {
    const schema = stripComments(readFileSync(join(APPS_DIR, 'schema.ts'), 'utf-8'));
    expect(schema).toContain('.strict()');
    // The shapes that would make it an exclusion list.
    expect(schema).not.toMatch(/\.omit\(/);
    expect(schema).not.toMatch(/delete\s+\w+\.client_secret/);
  });

  it('publishes no field whose name contains "secret" other than secret_prefix/secret_version', () => {
    const schema = readFileSync(join(APPS_DIR, 'schema.ts'), 'utf-8');
    const block = schema.slice(
      schema.indexOf('export const oauthAppPublicSchema'),
      schema.indexOf('export type OAuthAppPublic')
    );
    const secretFields = [...block.matchAll(/^\s{4}(\w*secret\w*):/gm)].map((m) => m[1]);
    expect(secretFields.sort()).toEqual(['secret_prefix', 'secret_version']);
  });

  it('never selects * from oauth_apps (L99 F17)', () => {
    // RETURNING * is exactly how yjs_state and deleted_at nearly shipped to
    // external consumers from api/src/routes/documents.ts.
    const pg = stripComments(readFileSync(join(APPS_DIR, 'pg-repo.ts'), 'utf-8'));
    expect(pg).not.toMatch(/SELECT\s+\*/i);
    expect(pg).not.toMatch(/RETURNING\s+\*/i);
  });
});

describe('PF-041 — no scope-name literal under platform/apps/', () => {
  it('derives scope names from the ScopeRegistry rather than restating them', () => {
    // L03's OCP claim is that adding a scope touches only the registration
    // file. A literal 'documents:read' here would silently break it.
    const offenders: string[] = [];
    for (const { name, text } of appsSourceFiles()) {
      const code = stripComments(text);
      const matches = code.match(/['"](?:documents|issues|sprints|webhooks):\w+['"]/g);
      if (matches) offenders.push(`${name}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
