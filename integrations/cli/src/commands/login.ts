/**
 * `ship login` — PF-562 through PF-567. p.6's second line, p.11's §7.
 *
 * ── The whole auth path is one SDK call ─────────────────────────────────────
 * `ShipClient.deviceLogin()` (L18's PF-537). This file contains no `fetch(`, no
 * `/oauth/` literal, no `device_code` handling and no polling loop — asserted
 * by grep over `src/**` in `boundary.test.ts`. Any auth logic that landed here
 * would be an L18 gap that got worked around, and the CLI's whole value is that
 * it has no privileged path available to it.
 *
 * ── The user code goes to STDERR ────────────────────────────────────────────
 * PF-563 and PF-571 together. stdout is reserved for the `--json` contract, so
 * the block a human reads — and that the TTFE drill scrapes — is on stderr in
 * both output modes. The code is echoed VERBATIM: no lowercasing and no
 * stripping of RFC 8628's grouping hyphen, because the user pastes it into
 * `/oauth/device/verify` and the server compares it after its own
 * normalisation, not after ours.
 */
import { ShipClient, oauthErrorCode } from '@ship/sdk';
import { EXIT_CODES, type ExitCode } from '../exitCodes.js';
import { reportFailure } from '../errors.js';
import { resolveClientId, resolveInstance } from '../config.js';
import { writeSettings } from '../settings.js';
import { credentialsPathOf, tokenStoreOf, type CommandContext } from '../context.js';
import { withCredentialLock } from '../credentialLock.js';

/**
 * The machine-readable line PF-563 requires when stdout is not a TTY.
 *
 * One line, one stable prefix, two fields. L20's drill and PF-564's test both
 * read it, and a format that changed would break them loudly rather than
 * silently — which is why it is a constant here and not an inline template.
 */
export const USER_CODE_LINE_PREFIX = 'ship: device-code-ready';

export function userCodeLine(code: string, verifyUrl: string): string {
  return `${USER_CODE_LINE_PREFIX} user_code=${code} verification_uri=${verifyUrl}`;
}

/** Where `login` persisted the instance and app, so later commands need no flags. */
export interface LoginResult {
  baseUrl: string;
  clientId: string;
  scopes: string[];
}

export interface LoginOptions {
  /** Space- or comma-separated on the command line; an array here. */
  scopes?: string[] | undefined;
  /** Injected in tests; defaults to `writeSettings`. */
  saveSettings?: (update: { baseUrl: string; clientId: string }) => void;
}

export async function runLogin(
  context: CommandContext,
  options: LoginOptions = {},
): Promise<ExitCode> {
  const instance = resolveInstance({
    flag: context.baseUrl,
    ...(context.env !== undefined ? { env: context.env } : {}),
    ...(context.settings !== undefined ? { settings: context.settings } : {}),
  });
  const clientId = resolveClientId({
    flag: context.clientId,
    ...(context.env !== undefined ? { env: context.env } : {}),
    ...(context.settings !== undefined ? { settings: context.settings } : {}),
  });

  if (clientId === null) {
    context.sink.err('ship: no OAuth client id.');
    context.sink.err(
      'Pass --client-id <id>, or export SHIP_CLIENT_ID. The README lists the ids ' +
        'pre-registered on the deployed instance.',
    );
    return EXIT_CODES.usage;
  }

  const tokenStore = tokenStoreOf(context);

  context.sink.err(`ship: authenticating against ${instance.baseUrl} as ${clientId}`);

  try {
    // The lock is held across the whole flow (D14): a second terminal running
    // `ship login` at the same moment would otherwise race this one's single
    // write to `~/.ship/credentials.json`.
    const { result } = await withCredentialLock(
      credentialsPathOf(context),
      { clock: context.clock },
      async () =>
        ShipClient.deviceLogin({
          baseUrl: instance.baseUrl,
          clientId,
          tokenStore,
          clock: context.clock,
          ...(options.scopes !== undefined && options.scopes.length > 0
            ? { scopes: options.scopes }
            : {}),
          onUserCode: (code, verifyUrl) => {
            // A visually separated block for a human...
            context.sink.err('');
            context.sink.err('  To authorize this device, enter the code:');
            context.sink.err('');
            context.sink.err(`      ${code}`);
            context.sink.err('');
            context.sink.err('  at:');
            context.sink.err('');
            // ...with the URL alone on its line and NO trailing punctuation, so
            // a terminal linkifies the whole thing and not the URL plus a dot.
            context.sink.err(`      ${verifyUrl}`);
            context.sink.err('');
            // ...and one stable, parseable line for everything that is not a
            // human. Printed unconditionally, TTY or not: a format that depends
            // on `isTTY` is a format that is only ever tested one way.
            context.sink.err(userCodeLine(code, verifyUrl));
            context.sink.err('');
            context.sink.err('  Waiting for authorization…');
          },
        }),
    );

    // The flow returns a ready `ShipClient`; the CLI does not need it here,
    // because every later command builds its own from the same store.
    void result;

    const tokens = await tokenStore.load();
    const scopes = tokens?.scopes ?? [];

    // Persisted so `ship docs ls` needs neither flag nor environment (PF-559).
    const save = options.saveSettings ?? ((u) => void writeSettings(u));
    save({ baseUrl: instance.baseUrl, clientId });

    if (context.json) {
      // The ONE JSON value on stdout. No token in it — PF-572.
      context.sink.out(
        JSON.stringify({ base_url: instance.baseUrl, client_id: clientId, scopes }),
      );
    } else {
      context.sink.err('');
      context.sink.err(`ship: authenticated. Credentials in ${credentialsPathOf(context)}`);
      context.sink.err(`      scopes: ${scopes.join(', ') || '(none reported)'}`);
    }
    return EXIT_CODES.success;
  } catch (error) {
    // PF-565 — denied, expired, or abandoned. Each says which, each exits
    // non-zero, and NONE of them writes a credential: the SDK's flow calls
    // `save()` exactly once at the very end (PF-540), so every path that
    // reaches this catch has written nothing.
    const oauth = oauthErrorCode(error);
    if (oauth === 'access_denied') {
      context.sink.err('ship: authorization was denied.');
      context.sink.err('Nothing was saved. Run `ship login` again to retry.');
      return EXIT_CODES.auth;
    }
    if (oauth === 'expired_token') {
      context.sink.err('ship: the device code expired before it was authorized.');
      context.sink.err('Nothing was saved. Run `ship login` again to get a fresh code.');
      return EXIT_CODES.auth;
    }
    return reportFailure(error, context.sink, { nowMs: context.clock.now() });
  }
}
