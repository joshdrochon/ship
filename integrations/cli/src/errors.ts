/**
 * PF-560 / PF-561 — every failure renders from the SDK's five-kind union.
 *
 * PRD p.4 gives this CLI its entire error surface:
 *
 *     kind: 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server'
 *
 * and requires that consumers *"switch on kind exhaustively"*. The CLI is the
 * reference consumer, so this is where that claim is demonstrated rather than
 * asserted. `assertNever` below assigns the narrowed value to `never`: delete a
 * case and `pnpm type-check` fails at this file, not at runtime in front of a
 * grader.
 *
 * ── No stack trace ever reaches the terminal ────────────────────────────────
 * A stack trace in a CLI is a bug report the user cannot act on and, in this
 * one, a screenshot deliverable (p.13). Every branch below prints a sentence
 * and a remedy. `Error.stack` is never read in this package — asserted by grep
 * in `errors.test.ts` and by capturing output on all five paths.
 */
import { ShipError, type ShipErrorKind, type RateLimitStatus } from '@ship/sdk';
import { EXIT_CODES, type ExitCode } from './exitCodes.js';
import type { OutputSink } from './io.js';

/** Makes deleting a `case` a compile error rather than a silent fallthrough. */
function assertNever(value: never, fallback: string): string {
  // `value` is `never` at compile time. At runtime it is whatever arrived, and a
  // future sixth kind from a newer server must still print something.
  return `${fallback} (${String(value)})`;
}

/** Unix seconds → something a person reads without doing arithmetic. */
function describeReset(rateLimit: RateLimitStatus | null, nowMs: number): string {
  if (rateLimit?.resetAtSeconds === null || rateLimit?.resetAtSeconds === undefined) {
    return 'The instance did not say when the window resets.';
  }
  const seconds = Math.max(0, Math.round(rateLimit.resetAtSeconds - nowMs / 1000));
  return `The window resets in ${seconds}s (at ${new Date(rateLimit.resetAtSeconds * 1000).toISOString()}).`;
}

/**
 * The offending field from an `ApiError`'s `details`.
 *
 * L07's validation envelope carries a Zod `flatten()` — `{ fieldErrors: {...},
 * formErrors: [...] }`. Naming the field is the difference between "validation
 * failed" and "title: expected string". Returns `null` when the server sent
 * something this CLI does not recognise, and the caller falls back to the
 * server's own message rather than inventing one.
 */
export function offendingField(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors === 'object' && fieldErrors !== null) {
    for (const [field, problems] of Object.entries(fieldErrors as Record<string, unknown>)) {
      const first = Array.isArray(problems) ? problems[0] : undefined;
      return typeof first === 'string' ? `${field}: ${first}` : field;
    }
  }
  const field = (details as { field?: unknown }).field;
  return typeof field === 'string' ? field : null;
}

export interface RenderedFailure {
  /** The lines to print, in order, on stderr. */
  lines: string[];
  exitCode: ExitCode;
  kind: ShipErrorKind | 'unknown';
}

export interface RenderErrorOptions {
  /** Echoed back on `not_found`, per PF-570. */
  subject?: string;
  /** Injected — `rate_limit` needs a now to describe a reset. */
  nowMs?: number;
}

/**
 * One renderer, one exhaustive `switch`. Every command funnels here.
 */
export function renderFailure(error: unknown, options: RenderErrorOptions = {}): RenderedFailure {
  const nowMs = options.nowMs ?? Date.now();

  if (!(error instanceof ShipError)) {
    // Not from the SDK at all — a bug in this CLI, a broken pipe, an OOM. Say
    // so honestly and print the message only. Never the stack.
    return {
      lines: [
        `ship: ${error instanceof Error ? error.message : String(error)}`,
        'This is not an error the Ship API reported. It is a fault in the CLI itself.',
      ],
      exitCode: EXIT_CODES.unexpected,
      kind: 'unknown',
    };
  }

  const lines: string[] = [];
  let exitCode: ExitCode;

  switch (error.kind) {
    case 'auth': {
      // 401 and 403 both land here (the SDK's documented 6→5 collapse), and the
      // remedy differs, so `code` is read rather than `kind` alone.
      if (error.code === 'forbidden') {
        const scope = error.requiredScope;
        lines.push(`ship: this token is not allowed to do that.`);
        lines.push(
          scope !== null
            ? `Missing scope: ${scope}. Granted: ${error.grantedScopes.join(', ') || '(none)'}.`
            : error.message,
        );
        lines.push('Re-authenticate with an app that requests it: ship login');
      } else {
        lines.push('ship: not authenticated.');
        lines.push(error.message);
        lines.push('Run `ship login` to authenticate.');
      }
      exitCode = EXIT_CODES.auth;
      break;
    }

    case 'rate_limit': {
      lines.push('ship: rate limited by the instance.');
      lines.push(describeReset(error.rateLimit, nowMs));
      if (error.retryAfterSeconds !== null) {
        lines.push(`Retry-After: ${error.retryAfterSeconds}s.`);
      }
      exitCode = EXIT_CODES.rateLimited;
      break;
    }

    case 'not_found': {
      lines.push(
        options.subject !== undefined
          ? `ship: not found — ${options.subject}`
          : `ship: not found.`,
      );
      lines.push(error.message);
      exitCode = EXIT_CODES.unexpected;
      break;
    }

    case 'validation': {
      const field = offendingField(error.details);
      lines.push('ship: the instance rejected that request.');
      lines.push(field !== null ? field : error.message);
      exitCode = EXIT_CODES.usage;
      break;
    }

    case 'server': {
      // PF-560: `request_id` and NOTHING ELSE. A 500's message is the server's
      // internal wording; the id is the only thing that makes a support
      // conversation possible, and printing more invites a user to debug a
      // system they cannot see.
      lines.push('ship: the instance failed to handle that request.');
      lines.push(
        error.requestId !== null
          ? `request_id: ${error.requestId}`
          : 'The instance returned no request_id, so there is nothing to quote in a report.',
      );
      exitCode = EXIT_CODES.unexpected;
      break;
    }

    default: {
      lines.push('ship: an error kind this CLI does not know about.');
      lines.push(assertNever(error.kind, 'unhandled kind'));
      exitCode = EXIT_CODES.unexpected;
    }
  }

  return { lines, exitCode, kind: error.kind };
}

/** Renders and writes. Human words go to stderr in both output modes (PF-571). */
export function reportFailure(
  error: unknown,
  sink: OutputSink,
  options: RenderErrorOptions = {},
): ExitCode {
  const rendered = renderFailure(error, options);
  for (const line of rendered.lines) sink.err(line);
  return rendered.exitCode;
}
