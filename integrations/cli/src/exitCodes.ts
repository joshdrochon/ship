/**
 * PF-561 — exit codes as exported data, one per failure class.
 *
 * L20's TTFE drill and any CI harness branch on these. Publishing them as a
 * frozen table from the first commit is the difference between a contract and
 * something a drill reverse-engineers from `!== 0`: `!== 0` cannot tell
 * "the user needs to run `ship login`" from "the signature did not verify",
 * and those two want opposite responses from a harness.
 *
 * `Object.freeze` because `readonly` is erased by `tsc`. A consumer that can
 * reassign `EXIT_CODES.auth` can make a harness assert on a number the CLI
 * never produces.
 */
export const EXIT_CODES = Object.freeze({
  /** The command did what it was asked. */
  success: 0,
  /** Anything this CLI did not anticipate. Reserved for genuine surprises. */
  unexpected: 1,
  /** The invocation was wrong — unknown command, missing required flag. */
  usage: 2,
  /** No usable credential. The remedy is always `ship login`. */
  auth: 3,
  /** The instance rate-limited us. Retry after the reset time. */
  rateLimited: 4,
  /** `webhooks tail --exit-on-invalid` saw a delivery that failed verification. */
  signature: 5,
} as const);

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

/** The names, as data, so a test can enumerate them rather than copy them. */
export const EXIT_CODE_NAMES = Object.keys(EXIT_CODES) as ExitCodeName[];
