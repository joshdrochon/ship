/**
 * PF-743's first hop: create a document through Ship's **INTERNAL** UI path.
 *
 * The whole point of the ticket is that the walk starts where a human starts —
 * `POST /api/documents` with a session cookie, the route the React app calls —
 * and NOT at `/api/v1`. p.13's interview question asks for exactly that walk,
 * and L14's one-publish-both-surfaces rule is only proven from this side: if the
 * event bus were wired into the public router rather than into the domain
 * service, this script would produce a document and no delivery.
 *
 * ── Why it lives in `scripts/` ────────────────────────────────────────────
 * It opens a Ship SESSION, which needs `DATABASE_URL` and has no public
 * endpoint. PRD p.11 says `integrations/**` imports only `@ship/sdk`, so the
 * privileged half is a subprocess with its own module graph — the same split
 * `l19-device-approve.ts` and `l24-browser-demo-setup.ts` use, and for the same
 * reason: it makes "the integration has no privileged path" true by
 * construction rather than true by an import list nobody re-reads.
 *
 * Usage:
 *   tsx scripts/l24-internal-document.ts --base-url http://localhost:3000 \
 *       --title "PF-743"
 *
 * Prints the created document's JSON on stdout. Exit 0 on success.
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

/** Migration 041's fixed ids — the grader workspace and its owner. */
const GRADER_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const GRADER_OWNER_USER_ID = '00000000-0000-4000-8000-0000000000b1';

function arg(name: string, fallback?: string): string {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`l24-internal-document: --${name} is required`);
  }
  return value;
}

class CookieJar {
  private readonly jar = new Map<string, string>();
  set(name: string, value: string): void {
    this.jar.set(name, value);
  }
  absorb(response: Response): void {
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

async function main(): Promise<void> {
  const baseUrl = arg('base-url', 'http://localhost:3000').replace(/\/+$/, '');
  const title = arg('title', 'PF-743 — the whole path');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'l24-internal-document: DATABASE_URL is required — this script opens a Ship session, ' +
        'which is an operator action with no public endpoint.',
    );
  }

  // ── the session. Inserting the row IS logging in; `users.password_hash` is
  //    NULL for this account and there is no internal login endpoint that would
  //    accept a password. Same mechanism as l19-device-approve.ts.
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const sessionId = `l24-internal-${randomUUID()}`;
  try {
    await db.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, GRADER_OWNER_USER_ID, GRADER_WORKSPACE_ID],
    );
  } finally {
    await db.end();
  }

  const jar = new CookieJar();
  jar.set('session_id', sessionId);

  // ── CSRF. `api/src/app.ts` skips the check for a Bearer request; this one is
  //    a cookie request on purpose, so it goes through the same csrf-sync the
  //    browser does.
  const csrfResponse = await fetch(`${baseUrl}/api/csrf-token`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(csrfResponse);
  // `{ token }`, not `{ csrfToken }` — checked against `api/src/routes/documents.test.ts`
  // and `admin-credentials.ts`, both of which read `.token`. Guessing the field
  // name produces a 403 with an HTML body, which reads as "the session is wrong".
  const csrfBody = (await csrfResponse.json().catch(() => ({}))) as { token?: string };
  const csrfToken = csrfBody.token;
  if (csrfToken === undefined) {
    throw new Error(
      `l24-internal-document: /api/csrf-token returned no token. csrf-sync stores the value in ` +
        `the express-session the SAME response set, so the session cookie from this response must ` +
        `be carried into the POST — that is what the jar below is for.`,
    );
  }

  const created = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: jar.header(),
      ...(csrfToken !== undefined ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify({ title, document_type: 'wiki' }),
  });

  const text = await created.text();
  if (created.status < 200 || created.status >= 300) {
    throw new Error(`l24-internal-document: POST /api/documents answered ${created.status}: ${text}`);
  }
  process.stdout.write(`${text}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
