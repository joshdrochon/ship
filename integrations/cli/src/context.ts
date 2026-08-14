/**
 * PF-581 — the seam every command shares, and the one L20's drill instruments.
 *
 * Each `run*` function takes a `CommandContext` and returns an exit code. It
 * reads no `process.argv`, calls no `console.*`, and constructs no clock. That
 * is what lets the TTFE drill (p.7, `integrations/cli/tests/ttfe.drill.ts`,
 * written by L20) time the code path the demo actually runs instead of a
 * parallel re-implementation that can drift from it.
 */
import { FileTokenStore, ShipClient, defaultCredentialsPath, type ITokenStore } from '@ship/sdk';
import { realClock, type CliClock, type OutputSink } from './io.js';
import { resolveClientId, resolveInstance } from './config.js';
import type { CliSettings } from './settings.js';

export interface CommandContext {
  sink: OutputSink;
  clock: CliClock;
  /** `--json`: one JSON value on stdout, every human word on stderr (PF-571). */
  json: boolean;
  /** `--base-url`, when passed. */
  baseUrl?: string | undefined;
  /** `--client-id`, when passed. */
  clientId?: string | undefined;
  /** Injected in tests so no test reads the developer's real environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. `undefined` means "read `~/.ship/config.json`". */
  settings?: CliSettings | null | undefined;
  /**
   * Injected in tests. `undefined` means `FileTokenStore` at
   * `credentialsPath`, which is what a real invocation uses.
   */
  tokenStore?: ITokenStore | undefined;
  /** Defaults to the SDK's `~/.ship/credentials.json`. */
  credentialsPath?: string | undefined;
}

export function contextDefaults(overrides: Partial<CommandContext> & { sink: OutputSink }): CommandContext {
  return {
    clock: realClock,
    json: false,
    ...overrides,
  };
}

export function credentialsPathOf(context: CommandContext): string {
  return context.credentialsPath ?? defaultCredentialsPath();
}

export function tokenStoreOf(context: CommandContext): ITokenStore {
  return context.tokenStore ?? new FileTokenStore({ path: credentialsPathOf(context) });
}

export interface BuiltClient {
  client: ShipClient;
  baseUrl: string;
  clientId: string | null;
  tokenStore: ITokenStore;
}

/**
 * The authenticated client every non-`login` command uses.
 *
 * `tokenStore` and not `token`: the store is what makes PF-567 possible — an
 * expired access token refreshes once and the rotated pair is written back, so
 * the NEXT process is still authenticated. Passing a static token would disable
 * refresh (the SDK says so on `ShipClientOptions.token`) and turn every expiry
 * into a fresh device flow.
 *
 * No client secret is ever passed. A CLI is a public client (RFC 6749 §2.1) and
 * has nowhere to keep one; if the instance demands a secret to refresh, that is
 * a server-side registration problem, not something to work around here.
 */
export function buildClient(context: CommandContext): BuiltClient {
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
  const tokenStore = tokenStoreOf(context);

  const client = new ShipClient({
    baseUrl: instance.baseUrl,
    tokenStore,
    ...(clientId !== null ? { clientId } : {}),
    clock: context.clock,
    userAgentSuffix: 'ship-cli/0.1.0',
  });

  return { client, baseUrl: instance.baseUrl, clientId, tokenStore };
}
