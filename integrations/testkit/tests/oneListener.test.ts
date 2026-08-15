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
 * An integration whose PRODUCT is an HTTP server is not a duplicate fixture, and
 * neither is a stub of the ORIGIN the client calls. Every exception is listed by
 * exact path with a written reason, so a socket bound anywhere else — including
 * inside an already-listed package — fails this test.
 *
 * `slack/src/server.ts` was deliberately NOT pre-listed before PF-739 landed:
 * the third assertion fails on an allow-list entry naming a file that does not
 * exist, so the list cannot accumulate names nobody checks.
 *
 * ── An allow-list is not a place to put things (L24) ──────────────────────
 * Three assertions guard the list itself, because the failure mode of a guard is
 * a growing exception list nobody re-reads:
 *
 *   · every entry names a file that exists              (assertion 3)
 *   · every entry carries a usable written reason       (assertion 4)
 *   · the DELIVERY-CAPTURE set is pinned by exact path  (assertion 5)
 *
 * The last one is the sharp one. PF-721 is not about sockets in general; it is
 * about a second implementation of "the signed delivery arrived" — the thing that
 * diverges on raw-body handling. `cli/tests/ttfe/listener.ts` is one of those and
 * is recorded here as a debt with its blocker named, not as a blessing. Because
 * assertion 5 pins the set, adding a third such file fails even if someone also
 * adds it to the allow-list.
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

/**
 * The files that are legitimately allowed to bind a socket.
 *
 * Every entry carries a WRITTEN reason, and the reason is enforced: the fourth
 * assertion below rejects an entry whose reason is missing or too short to be
 * one. A path added with `// TODO` next to it is the shape this guard exists to
 * refuse, because that is how an allow-list stops being a decision and becomes a
 * place to put things.
 *
 * `capturesDeliveries` is the sharper half. PF-721 is not about sockets in
 * general — it is about a SECOND implementation of "the signed delivery
 * arrived", because that is the one that diverges on raw-body handling and takes
 * an integration down while its own suite stays green. A file that binds a
 * socket to talk to the CLI is a different animal from one that captures
 * deliveries and hands the bytes to a verifier. The flag records which is which,
 * and the fifth assertion pins the delivery-capture set so a real violation
 * cannot be smuggled in behind an allow-list line.
 */
interface AllowedServerFile {
  path: string;
  /** Why this file binds a socket, and why the testkit cannot do it instead. */
  reason: string;
  /**
   * True when the file captures inbound deliveries and preserves the raw bytes
   * for signature verification — i.e. when it is doing the testkit's job.
   */
  capturesDeliveries: boolean;
}

const ALLOWED_SERVER_FILES: AllowedServerFile[] = [
  {
    path: 'testkit/src/listener.ts',
    reason:
      'The fixture itself. This is the one implementation PF-721 requires exist, and every ' +
      'other delivery-capture entry on this list is measured against it.',
    capturesDeliveries: true,
  },
  {
    path: 'cli/src/commands/webhooksTail.ts',
    reason:
      "L19's `ship webhooks tail --listen`. A user-facing command that receives real deliveries " +
      'on a developer laptop, not a test double. A shipped CLI cannot import a devDependency, ' +
      'so the testkit is not available to it at any price.',
    capturesDeliveries: false,
  },
  // PF-739 — the Slack integration IS an HTTP server; that is the point of
  // choosing it (p.8 wants a genuinely external process receiving signed
  // deliveries). `src/server.ts` only BUILDS the app; the two files below are
  // the only ones that bind a socket, and neither is a delivery-capture fixture.
  {
    path: 'slack/src/index.ts',
    reason:
      'The Slack integration\'s process entry point. p.8 chose Slack precisely because it is a ' +
      'genuinely EXTERNAL process receiving signed deliveries; a fixture that stood in for it ' +
      'would delete the property the option was chosen for. It consumes the testkit in its own ' +
      'tests rather than reimplementing capture.',
    capturesDeliveries: false,
  },
  {
    path: 'slack/tests/support/harness.ts',
    reason:
      "Boots the Slack integration's real Express app so the suite exercises the shipped " +
      'process. It binds the app under test — it does not capture deliveries of its own, and it ' +
      'imports @ship/integration-testkit for the receiving half.',
    capturesDeliveries: false,
  },
  {
    path: 'cli/tests/support/stubShip.ts',
    reason:
      'A stub of SHIP, not a subscriber. It is the ORIGIN the CLI calls — /oauth/token, the ' +
      'delivery log — and the three claims it exists for (PF-564 slow_down timing, PF-567 ' +
      'exactly-one-refresh, PF-578 a tampered delivery) are counting and negative cases a real ' +
      'server cannot be asked to produce. It records form bodies and stamps every request with ' +
      "L17's INJECTED clock; the testkit captures raw bytes off the wire and knows nothing " +
      'about either. Different direction, different data, not a second delivery listener.',
    capturesDeliveries: false,
  },
  {
    path: 'cli/tests/ttfe/listener.ts',
    reason:
      'KNOWN DUPLICATE, recorded rather than blessed — this one IS a delivery-capture fixture ' +
      "(it hands its captured body to the SDK's verifyWebhook at ttfe.drill.ts:296) and it " +
      'belongs in the testkit. It is here because the swap is not a rename: the drill computes ' +
      'TTFE as `delivery.receivedAt - documentCreatedAt` against `performance.now()`, while the ' +
      "testkit's CapturedRequest stamps `Date.now()`. Mixing those two clocks silently corrupts " +
      "a GRADED measurement (p.7), so routing it through the testkit means changing the " +
      'testkit\'s public CapturedRequest contract, which the Slack suite also consumes. That is ' +
      'a slice of its own. Until it lands, the assertion below keeps this the LAST such entry.',
    capturesDeliveries: true,
  },
];

const ALLOWED_PATHS = ALLOWED_SERVER_FILES.map((entry) => entry.path);

/**
 * The delivery-capture files this repository has agreed to carry, by exact path.
 *
 * Two, and the second one is a debt with a name. Adding a third means editing
 * this line, which is the point: an allow-list entry alone can no longer buy a
 * second implementation of "the delivery arrived".
 */
const KNOWN_DELIVERY_CAPTURE = ['testkit/src/listener.ts', 'cli/tests/ttfe/listener.ts'];

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
      if (ALLOWED_PATHS.includes(rel)) continue;
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
    const missing = ALLOWED_PATHS.filter((f) => !present.has(f));
    expect(missing, 'allow-listed paths that no longer exist').toEqual([]);
  });

  it('every allow-list entry carries a written reason', () => {
    // An entry with no reason is an entry nobody can review. Thirty characters
    // is not a quality bar — it is a floor that `// TODO` and `legacy` fail.
    const unreasoned = ALLOWED_SERVER_FILES.filter((e) => e.reason.trim().length < 30).map(
      (e) => e.path,
    );
    expect(
      unreasoned,
      'ALLOWED_SERVER_FILES entries with no usable reason. Say why this file binds a socket AND ' +
        'why @ship/integration-testkit cannot do it instead. An allow-list without reasons is a ' +
        'list of things nobody decided.',
    ).toEqual([]);
  });

  it('no NEW delivery-capture fixture hides behind an allow-list entry', () => {
    // The actual shape PF-721 polices: something that keeps the RAW body around
    // and lets a test wait for it. `rawBody` plus `waitFor` is that shape, and it
    // is what separates a second "the delivery arrived" from a stub origin server
    // or a booted product process.
    const captureShaped = ALLOWED_SERVER_FILES.filter((entry) => {
      const source = stripComments(readFileSync(join(INTEGRATIONS_ROOT, entry.path), 'utf8'));
      return /\brawBody\b/.test(source) && /\bwaitFor\b/.test(source);
    }).map((entry) => entry.path);

    expect(
      [...captureShaped].sort(),
      'A file on ALLOWED_SERVER_FILES captures deliveries (raw body + waitFor). That is the ' +
        'testkit\'s job and PF-721 allows exactly one implementation of it. Import ' +
        '@ship/integration-testkit — do not add a path here.',
    ).toEqual([...KNOWN_DELIVERY_CAPTURE].sort());

    // …and the flag must agree with the code, so the reasons stay honest.
    const declared = ALLOWED_SERVER_FILES.filter((e) => e.capturesDeliveries).map((e) => e.path);
    expect(
      [...declared].sort(),
      'capturesDeliveries disagrees with what the file actually does',
    ).toEqual([...captureShaped].sort());
  });
});
