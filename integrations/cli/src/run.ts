/**
 * Dispatch — PF-556, PF-581.
 *
 * Argv in, exit code out, and NO business logic. Every branch below resolves to
 * one of the five exported `run*` functions, which is what lets L20's TTFE
 * drill call the real command paths (PF-581) instead of re-implementing them
 * and timing a code path the demo does not run.
 *
 * `src/index.ts` is this file plus `process.exit`. That separation is the whole
 * of PF-581's "runs with `process.argv` untouched" clause.
 */
import { EXIT_CODES, type ExitCode } from './exitCodes.js';
import { USAGE } from './usage.js';
import { firstValue, integerValue, parseArgv } from './argv.js';
import { realClock, type CliClock, type OutputSink } from './io.js';
import { contextDefaults, type CommandContext } from './context.js';
import { runLogin } from './commands/login.js';
import { runDocsCreate, runDocsGet, runDocsLs } from './commands/docs.js';
import { runWebhooksTail } from './commands/webhooksTail.js';
import type { ShipEventType } from '@ship/sdk';

export interface RunOptions {
  sink: OutputSink;
  clock?: CliClock;
  env?: NodeJS.ProcessEnv;
  /** Resolves when the process is asked to stop. `webhooks tail` honours it. */
  stopSignal?: Promise<void>;
}

/** `--scope a --scope b` and `--scope a,b` are the same list. */
function scopeList(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const flat = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
  return flat.length > 0 ? flat : undefined;
}

export async function run(argv: string[], options: RunOptions): Promise<ExitCode> {
  const parsed = parseArgv(argv);
  const sink = options.sink;

  if (parsed.error !== null) {
    sink.err(`ship: ${parsed.error}`);
    sink.err(USAGE);
    return EXIT_CODES.usage;
  }

  // `--help` anywhere, and a bare `ship`, both print usage and exit 0. PF-556 is
  // explicit that a binary which does not resolve fails p.8's first drill stage
  // before the drill starts, so "no arguments" is a success, not an error.
  if (parsed.booleans.has('help') || parsed.booleans.has('h') || parsed.path.length === 0) {
    sink.out(USAGE);
    return EXIT_CODES.success;
  }

  const context: CommandContext = contextDefaults({
    sink,
    clock: options.clock ?? realClock,
    json: parsed.booleans.has('json'),
    baseUrl: firstValue(parsed, 'baseUrl'),
    clientId: firstValue(parsed, 'clientId'),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const [group, sub] = parsed.path;

  switch (group) {
    case 'login': {
      const scopes = scopeList(parsed.values.scope);
      return runLogin(context, scopes !== undefined ? { scopes } : {});
    }

    case 'docs': {
      switch (sub) {
        case 'ls': {
          const limit = integerValue(parsed, 'limit');
          if (!limit.ok) {
            sink.err(`ship: ${limit.message}`);
            return limit.exitCode;
          }
          return runDocsLs(context, {
            limit: limit.value,
            all: parsed.booleans.has('all'),
          });
        }
        case 'get':
          return runDocsGet(context, parsed.operands[0] ?? '');
        case 'create':
          return runDocsCreate(context, { title: firstValue(parsed, 'title') });
        default:
          return unknown(sink, `docs ${sub ?? ''}`.trim());
      }
    }

    case 'webhooks': {
      if (sub !== 'tail') return unknown(sink, `webhooks ${sub ?? ''}`.trim());
      return runWebhooksTail(context, {
        listen: parsed.booleans.has('listen'),
        poll: parsed.booleans.has('poll'),
        cleanup: parsed.booleans.has('cleanup'),
        exitOnInvalid: parsed.booleans.has('exitOnInvalid'),
        event: firstValue(parsed, 'event') as ShipEventType | undefined,
        ...(options.stopSignal !== undefined ? { stopSignal: options.stopSignal } : {}),
      });
    }

    default:
      return unknown(sink, group ?? '');
  }
}

/** PF-556: exit 2, and usage on STDERR — stdout stays clean for `--json`. */
function unknown(sink: OutputSink, command: string): ExitCode {
  sink.err(`ship: unknown command ${JSON.stringify(command)}`);
  sink.err(USAGE);
  return EXIT_CODES.usage;
}
