/**
 * L19 — the server-side half of the device grant, as a SUBPROCESS.
 *
 * `ship login` prints a `user_code` and waits for a human with a browser. In a
 * test, and in an unattended demo capture, there is no human. This script is
 * that human: it signs in as a real user of the grader workspace, submits the
 * code, and clicks Allow.
 *
 * ── Why this file lives in `scripts/` and not under `integrations/` ─────────
 * PRD p.11's Critical Guidance: `integrations/**` imports ONLY `@ship/sdk`.
 * Approving a grant needs a database credential (`DATABASE_URL`), a `sessions`
 * INSERT and the app's own CSRF transport — all of which are OPERATOR concerns,
 * not things a third-party CLI can do. The ESLint fence is import-scoped, so a
 * file here that the CLI's tests merely SPAWN could technically have sat next to
 * them without tripping it. It sits here anyway: a subprocess with its own
 * module graph makes "the CLI cannot reach the database" true by construction
 * rather than true by an import list nobody re-reads. Same split, and same
 * reason, as `scripts/l24-browser-demo-setup.ts` (PF-722).
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 * It does not touch `oauth_device_codes`. Flipping the row directly would make
 * the test green while proving nothing about `/oauth/device/verify`, which is
 * the surface TS-3 (p.5) and PF-564 are actually about. Every state change here
 * goes through the two POSTs a browser would send, with the CSRF token the
 * server minted and the session cookie the server set. The only thing written
 * directly is the `sessions` row — that is Ship's INTERNAL login, which has no
 * public endpoint and is not what is under test.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   tsx scripts/l19-device-approve.ts --user-code ABCD-1234 \
 *       [--base-url http://localhost:3919] [--decision allow|deny]
 *
 * Environment: `DATABASE_URL`. Exit 0 on the decision being recorded, 1 on
 * anything else, with the server's own message on stderr.
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * The workspace and owner migration 041 creates. Duplicated as literals rather
 * than imported from `api/src/db/platformApps.ts` on purpose: this script runs
 * under `tsx` against a DEPLOYED instance too, where the API source may not be
 * on disk. They are fixed UUIDs precisely so they can be written down.
 */
const GRADER_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const GRADER_OWNER_USER_ID = '00000000-0000-4000-8000-0000000000b1';

interface Args {
  userCode: string;
  baseUrl: string;
  decision: 'allow' | 'deny';
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }

  const userCode = out['user-code'];
  if (!userCode) {
    throw new Error(
      'l19-device-approve: --user-code is required. It is the code `ship login` printed ' +
        '(scrape it from the `ship: device-code-ready user_code=…` line on stderr).',
    );
  }

  const decision = out['decision'] ?? 'allow';
  if (decision !== 'allow' && decision !== 'deny') {
    throw new Error(`l19-device-approve: --decision must be allow or deny, got ${decision}`);
  }

  return {
    userCode,
    baseUrl: (out['base-url'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
    decision,
  };
}

/**
 * A logged-in Ship session for the grader workspace's owner.
 *
 * The user and workspace already exist — migration 041 creates both, because the
 * platform apps need an owner. All that is missing is the `sessions` row, which
 * `middleware/auth.ts` and `validateSessionForConnection` both read by cookie id
 * and nothing else. Inserting one IS logging in; there is no password to know
 * (`users.password_hash` is NULL for this account) and no internal login
 * endpoint that would accept one.
 */
async function openSession(db: Client): Promise<string> {
  const found = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [
    GRADER_OWNER_USER_ID,
  ]);
  if (found.rowCount === 0) {
    throw new Error(
      `l19-device-approve: user ${GRADER_OWNER_USER_ID} does not exist. That row is created by ` +
        'migration 041 — run `pnpm --filter @ship/api db:migrate` against this DATABASE_URL.',
    );
  }

  const sessionId = `l19-approve-${randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
     VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
    [sessionId, GRADER_OWNER_USER_ID, GRADER_WORKSPACE_ID],
  );
  return sessionId;
}

/** Every cookie the server has set so far, as one request header. */
class CookieJar {
  private readonly jar = new Map<string, string>();

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  absorb(response: Response): void {
    // `getSetCookie` keeps the cookies separate; a joined `set-cookie` header
    // cannot be split on `,` because `Expires=Wed, 01 Jan …` contains one.
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq === -1) continue;
      this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * The `_csrf` value the server just minted, read off the form it rendered.
 *
 * Read from the RESPONSE, never carried over from the previous page: csrf-sync
 * rotates the synchroniser token, and reusing a stale one is the failure this
 * function exists to avoid.
 */
function csrfTokenOf(html: string, where: string): string {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(
      `l19-device-approve: no _csrf field on the ${where} page. The server answered:\n` +
        `${html.slice(0, 400)}`,
    );
  }
  return match[1];
}

/** The `<h1>`/`<p>` a result page renders, for a legible failure. */
function summarise(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 300);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'l19-device-approve: DATABASE_URL is required — this script opens a Ship session, ' +
        'which is an operator action with no public endpoint.',
    );
  }

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  let sessionId: string;
  try {
    sessionId = await openSession(db);
  } finally {
    await db.end();
  }

  const jar = new CookieJar();
  jar.set('session_id', sessionId);

  // 1 ── GET the entry form. This is what mints the express-session cookie and
  //      the first synchroniser token.
  const entryUrl = `${args.baseUrl}/oauth/device/verify?user_code=${encodeURIComponent(args.userCode)}`;
  const entry = await fetch(entryUrl, { headers: { cookie: jar.header() }, redirect: 'manual' });
  jar.absorb(entry);
  if (entry.status === 302) {
    throw new Error(
      `l19-device-approve: the entry page bounced to login (${entry.headers.get('location')}). ` +
        'The session cookie was not accepted — check DATABASE_URL points at the same database ' +
        'the API is running against.',
    );
  }
  const entryHtml = await entry.text();
  if (!entry.ok) throw new Error(`l19-device-approve: GET verify → ${entry.status}: ${summarise(entryHtml)}`);

  // 2 ── POST the code. The server re-looks it up and renders consent.
  const consent = await fetch(`${args.baseUrl}/oauth/device/verify`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: args.userCode,
      _csrf: csrfTokenOf(entryHtml, 'entry'),
    }),
  });
  jar.absorb(consent);
  const consentHtml = await consent.text();
  if (!consent.ok) {
    throw new Error(
      `l19-device-approve: POST verify → ${consent.status}: ${summarise(consentHtml)}`,
    );
  }

  // 3 ── Allow (or deny). The server re-looks the code up a SECOND time; the
  //      hidden field is input, not evidence.
  const decided = await fetch(`${args.baseUrl}/oauth/device/verify/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: args.userCode,
      decision: args.decision,
      _csrf: csrfTokenOf(consentHtml, 'consent'),
    }),
  });
  const decidedHtml = await decided.text();
  if (!decided.ok) {
    throw new Error(
      `l19-device-approve: POST decision → ${decided.status}: ${summarise(decidedHtml)}`,
    );
  }

  process.stderr.write(`l19-device-approve: ${args.decision} recorded — ${summarise(decidedHtml)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
