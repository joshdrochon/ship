#!/usr/bin/env node
/**
 * ship — the reference integration and the proof the platform works.
 * May import ONLY @ship/sdk (enforced by the workspace dependency rule +
 * ESLint boundary rule). If a command needs something the SDK cannot do,
 * that is an SDK gap — fix it there, never by importing server code.
 *
 * The demo story (and the TTFE drill):
 *   ship login                 device flow → tokens in ~/.ship/credentials.json
 *   ship docs create --title   create through the SDK
 *   ship webhooks tail         stream verified signed deliveries to stdout
 */

const USAGE = `ship — Ship platform CLI

Commands:
  ship login                     Authenticate via device flow
  ship docs ls                   List documents
  ship docs get <id>             Show one document
  ship docs create --title <t>   Create a document
  ship webhooks tail             Stream signed webhook deliveries (verified)

TODO(josh) E6: wire commands to @ship/sdk (deviceLogin, documents.*, verifyWebhook).
Consider commander/oclif; plain argv parsing is acceptable for the week.
`;

const [, , command, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'login':
    case 'docs':
    case 'webhooks':
      console.error(`ship ${command} ${rest.join(' ')}`.trim());
      console.error('not implemented yet — see TODO(josh) E6 in integrations/cli/src/index.ts');
      process.exitCode = 1;
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
