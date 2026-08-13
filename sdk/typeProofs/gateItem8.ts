/**
 * PF-491 — MVP GATE ITEM 8's OWN EXPRESSION, COMPILED.
 *
 * PRD p.2, verbatim:
 *
 *   "SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token })
 *    .me()` against a running server returns the typed authenticated user."
 *
 * `ShipClientOptions.baseUrl` used to be `string` — required — so that literal
 * expression was a TYPE ERROR (L99 F19). A gate item that does not typecheck
 * fails on a screenshot, before anyone reaches the server.
 *
 * This file is the fixture the ticket asks for: the gate's expression written
 * exactly as p.2 writes it, with no `@ts-expect-error` anywhere near it,
 * compiled by `pnpm type-check`. If `baseUrl` ever becomes required again, this
 * file stops compiling and the SDK build fails — which is the point. It is NOT
 * emitted into `dist`; see `tsconfig.typeproofs.json`.
 *
 * The live half of the gate — that the call returns a real user from a real
 * server — is `src/gate.live.test.ts`. A type proof cannot make that claim and
 * does not try to.
 */
import { ShipClient, type Me } from '../src/index.js';

declare const token: string;

// ── The gate expression, exactly as PRD p.2 writes it ───────────────────────
export const gatePromise: Promise<Me> = new ShipClient({ token }).me();

// ── and the resolved value is the TYPED authenticated user ──────────────────
export async function readsTypedUser(): Promise<string> {
  const me = await new ShipClient({ token }).me();

  // Each of these is only legal because `Me` says so.
  const clientId: string = me.app.client_id;
  const appName: string = me.app.name;
  const scopes: string[] = me.scopes;
  // `user` is nullable — a machine-to-machine token has no consenting user —
  // and the type forces the caller to say what happens then.
  const userName: string = me.user?.name ?? '(no user — machine-to-machine token)';

  // @ts-expect-error — `Me` is a closed shape. A field the server does not
  // return must not compile, or "typed" means nothing.
  void me.app.nonexistent;

  // @ts-expect-error — `user` is `{...} | null`, so an unchecked read is an error.
  void me.user.id;

  return `${clientId} ${appName} ${userName} ${scopes.join(',')}`;
}

// ── The other two construction shapes, also legal ──────────────────────────
export const withBaseUrl = new ShipClient({ token, baseUrl: 'https://ship.example.com/prefix' });
export const withNothing = new ShipClient();
