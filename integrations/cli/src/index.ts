#!/usr/bin/env node
/**
 * ship — the reference integration and the proof the platform works.
 *
 * May import ONLY @ship/sdk (PRD p.11's Critical Guidance, enforced by ESLint
 * fence 3 and by the workspace-dependency check in
 * `scripts/check-boundary-lint.mjs`). If a command needs something the SDK
 * cannot do, that is an SDK gap — it gets fixed in L18, never by importing
 * server code. The CLI is the only consumer in this repository with no
 * privileged path available to it, and that is precisely what makes it proof.
 *
 * p.6's five-line developer story is this binary:
 *
 *     $ pnpm install @ship/sdk
 *     $ ship login                             # Device flow
 *     $ ship docs create --title "hello"       # Uses the SDK under the hood
 *     $ ship webhooks tail                     # Streams signed deliveries to stdout
 *     → document.created event arrives, signature verified ✓
 *
 * ── This file is argv and process wiring, and nothing else ──────────────────
 * PF-581: every command is an importable function with an injectable sink and
 * clock, so L20's TTFE drill instruments the real command paths. The dispatch
 * table is `run.ts`; the commands are `commands/`. Nothing here decides
 * anything.
 */
import { run } from './run.js';
import { processSink } from './io.js';
import { EXIT_CODES } from './exitCodes.js';

/** Ctrl-C and SIGTERM resolve this; `webhooks tail` unsubscribes and returns. */
function stopSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  // `process.exitCode` rather than `process.exit`: the latter truncates a
  // pending stdout write on a pipe, which is exactly the case
  // `ship webhooks tail | head -20` is (PF-579).
  process.exitCode = await run(process.argv.slice(2), {
    sink: processSink,
    stopSignal: stopSignal(),
  });
}

main().catch((error: unknown) => {
  // The last resort. A stack trace never reaches the terminal (PF-560).
  process.stderr.write(
    `ship: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = EXIT_CODES.unexpected;
});
