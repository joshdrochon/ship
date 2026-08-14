/**
 * PF-556 — the `--help` text, and the five commands p.8's menu names.
 *
 * p.8, verbatim: *"CLI tool with device flow — ship login, ship docs ls/get/create,
 * ship webhooks tail (must-ship)."* Every one of those five appears below, and
 * `usage.test.ts` asserts it by reading this constant rather than by reading a
 * copy of the list — so deleting a command fails the suite instead of quietly
 * shrinking the demo.
 */

/** The five commands, as data. The test iterates this. */
export const COMMANDS = [
  { name: 'login', summary: 'Authenticate this machine via the OAuth device flow' },
  { name: 'docs ls', summary: 'List documents' },
  { name: 'docs get <id>', summary: 'Show one document' },
  { name: 'docs create --title <t>', summary: 'Create a document' },
  { name: 'webhooks tail', summary: 'Stream signed webhook deliveries, verified' },
] as const;

export const USAGE = `ship — the Ship platform CLI

  The reference integration. Every command below goes through @ship/sdk and the
  public API — the same front door any external developer uses.

Usage
  ship <command> [options]

Commands
  ship login                       Authenticate this machine via the OAuth device flow
  ship docs ls                     List documents
  ship docs get <id>               Show one document
  ship docs create --title <t>     Create a document
  ship webhooks tail               Stream signed webhook deliveries, verified

Global options
  --base-url <url>     The Ship instance. Falls back to SHIP_BASE_URL, then to
                       the instance saved by \`ship login\`, then to the published
                       default.
  --client-id <id>     The OAuth app. Falls back to SHIP_CLIENT_ID, then to the
                       app saved by \`ship login\`.
  --json               One JSON value on stdout; every human word on stderr.
  -h, --help           This text.

ship login
  --scope <s>          Repeatable, or comma-separated. Defaults to the app's
                       registered scopes.

ship docs ls
  --limit <n>          Rows per page (default 25).
  --all                Walk every page. There is no --cursor: the SDK handles
                       cursors internally and consumer code never sees them.

ship docs create
  --title <t>          Required.

ship webhooks tail
  --listen             (default) Bind 127.0.0.1, subscribe to it, and verify each
                       signed delivery as it arrives. Needs an instance that can
                       reach this machine — a local or containerised Ship.
  --poll               Tail the delivery log instead, for an instance that cannot
                       reach you. Signatures are NOT verifiable in this mode and
                       the output says so.
  --event <type>       Event to subscribe to (default document.created).
  --exit-on-invalid    Exit 5 on the first delivery that fails verification.
  --cleanup            Delete tail subscriptions this CLI created and abandoned.

Exit codes
  0 success · 1 unexpected · 2 usage · 3 auth required · 4 rate limited
  5 signature verification failed
`;
