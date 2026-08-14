/**
 * PF-721's second half: **exactly one** listener implementation exists across
 * `integrations/**`.
 *
 * The first half — one good implementation — is `listener.test.ts`. This is the
 * half that keeps it true. Two listeners do not announce themselves; they
 * diverge on raw-body handling first, one of them starts verifying over
 * re-serialised JSON, and the integration that uses it rejects every legitimate
 * delivery while every test in its own package still passes.
 *
 * ── Why the grep is for the SERVER, not for the word "listener" ────────────
 * A second implementation is not identified by its name. It is identified by a
 * second thing that binds a socket and reads a request body, whatever it is
 * called — `createServer` from `node:http`/`node:https`, or an `express()` app
 * being `.listen()`ed. Those are the constructs, so those are what this looks
 * for.
 *
 * ── Named exceptions, and why each one is not a hole ──────────────────────
 * An integration whose PRODUCT is an HTTP server is not a duplicate fixture.
 * Two exist, both listed by exact path, so a third anywhere — including a second
 * one inside an already-listed package — fails this test:
 *
 *   testkit/src/listener.ts            the fixture itself
 *   cli/src/commands/webhooksTail.ts   L19's `ship webhooks tail --listen`. A
 *                                      user-facing command that receives real
 *                                      deliveries on a developer's laptop, not a
 *                                      test double. It predates this rule and it
 *                                      is not something the testkit can replace:
 *                                      a CLI cannot import a dev dependency.
 *
 * `slack/src/server.ts` joins the list when PF-739 lands — PF-739 requires a
 * real Express process, because the point of choosing Slack (p.8) is a genuinely
 * EXTERNAL process receiving signed deliveries. It is deliberately NOT
 * pre-listed: the third assertion below fails on an allow-list entry that names
 * a file which does not exist, so the list cannot accumulate names nobody checks.
 *
 * ── Comments are stripped first (L99 F113) ────────────────────────────────
 * The paragraph above says `.listen(` out loud, and an unstripped grep failed on
 * this very file for the sin of explaining itself. F113 records the same shape
 * from L22 and the "fix" a hurried author reaches for is deleting the honest
 * prose.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INTEGRATIONS_ROOT = dirname(PACKAGE_ROOT);

/** The packages that are legitimately their own HTTP server. See the header. */
const ALLOWED_SERVER_FILES = [
  'testkit/src/listener.ts',
  'cli/src/commands/webhooksTail.ts',
  // PF-739 — the Slack integration IS an HTTP server; that is the point of
  // choosing it (p.8 wants a genuinely external process receiving signed
  // deliveries). `src/server.ts` only BUILDS the app; the two files below are
  // the only ones that bind a socket, and neither is a delivery-capture fixture.
  'slack/src/index.ts',
  'slack/tests/support/harness.ts',
];

/** Line and block comments removed, so honest prose cannot fail the grep (F113). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (SOURCE.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return out.sort();
}

/** `createServer(` from node:http/https, or `app.listen(` / `server.listen(`. */
const SERVER_CONSTRUCTS = [/\bcreateServer\s*\(/, /\.listen\s*\(/];

describe('PF-721 — one listener, repository-wide', () => {
  const files = sourceFiles(INTEGRATIONS_ROOT);

  it('finds source files at all, so the grep is not vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no file outside the allow-list binds a socket', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(INTEGRATIONS_ROOT, file).split(/[\\/]/).join('/');
      if (ALLOWED_SERVER_FILES.includes(rel)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      if (SERVER_CONSTRUCTS.some((re) => re.test(source))) offenders.push(rel);
    }
    expect(
      offenders,
      'A second HTTP listener under integrations/. PF-721: one implementation of "the delivery ' +
        'arrived", imported by every webhook-receiving integration. Two diverge on raw-body ' +
        'handling first, and that is the failure PF-741 exists to prevent. Import ' +
        '@ship/integration-testkit instead, or add the path to ALLOWED_SERVER_FILES with a reason.',
    ).toEqual([]);
  });

  it('the allow-listed files exist — a stale entry is a hole, not a comment', () => {
    const present = new Set(
      files.map((f) => relative(INTEGRATIONS_ROOT, f).split(/[\\/]/).join('/')),
    );
    // `slack/src/server.ts` lands with PF-739. Until then the entry names a file
    // that does not exist, and the assertion below says so out loud rather than
    // letting the allow-list quietly accumulate names nobody checks.
    const missing = ALLOWED_SERVER_FILES.filter((f) => !present.has(f));
    expect(missing, 'allow-listed paths that no longer exist').toEqual([]);
  });
});
