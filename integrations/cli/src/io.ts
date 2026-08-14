/**
 * The output seam — PF-571, PF-581.
 *
 * ── Why every command takes a sink instead of calling `console.log` ─────────
 * Two graded properties depend on stdout and stderr being separable:
 *
 *   PF-571  `--json` puts EXACTLY ONE JSON value on stdout and every human
 *           word on stderr, so `ship docs ls --json | jq .` parses.
 *   PF-572  a test concatenates both streams and asserts no token or signing
 *           secret appears in either.
 *
 * `console.log` inside a command makes both of those a subprocess-capture
 * exercise. A sink makes them an in-process assertion, and L20's drill gets the
 * same seam for free (PF-581).
 */

/** Where a command writes. Two streams, deliberately. */
export interface OutputSink {
  /** Machine-readable results. Under `--json` this carries JSON and nothing else. */
  out(line: string): void;
  /** Everything a human reads: progress, prompts, diagnostics, errors. */
  err(line: string): void;
}

/**
 * The real one. Line-flushed via `write` + `\n` rather than `console.log`
 * because PF-579 requires `ship webhooks tail | head -20` not to lose the first
 * block — a buffered stdout on a pipe holds it until the process exits, which
 * is exactly the case the screenshot is taken in.
 */
export const processSink: OutputSink = {
  out(line: string): void {
    process.stdout.write(`${line}\n`);
  },
  err(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

/** Captures both streams for assertions. PF-571 and PF-572 both read this. */
export class RecordingSink implements OutputSink {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  out(line: string): void {
    this.stdout.push(line);
  }

  err(line: string): void {
    this.stderr.push(line);
  }

  /** stdout as one string, newline-joined — what `jq` would receive. */
  get stdoutText(): string {
    return this.stdout.join('\n');
  }

  get stderrText(): string {
    return this.stderr.join('\n');
  }

  /** Both streams, for the leak assertion. */
  get allText(): string {
    return `${this.stdoutText}\n${this.stderrText}`;
  }
}

/**
 * The clock every command reads — PF-564, PF-577, PF-579, and p.11's rule that
 * a timing-based test is a flaky test.
 *
 * Structurally identical to the SDK's `SdkClock`, and deliberately declared
 * here rather than re-exported: this is the CLI's own seam and the SDK's is the
 * SDK's. Anything satisfying one satisfies the other, so `--listen`'s renderer
 * and the SDK's device-flow poller can share a single fake in a test.
 */
export interface CliClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Jitter source in [0, 1), for the SDK's retry backoff.
   *
   * Present because `SdkClock` declares it and the CLI hands its clock straight
   * to `ShipClient` — one clock for the whole process, so a test that freezes
   * time freezes it for the SDK's retries as well as for this CLI's own waits.
   * A second, separate fake would let those two drift apart, and the bug that
   * hides is a retry ladder that "passes" against a clock nothing else uses.
   */
  random(): number;
}

export const realClock: CliClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      // The one timer in the package, and it is in the REAL clock — which no
      // test uses. Every test injects a fake, so `fitness.test.ts` can assert
      // zero timers in the test files themselves (p.11).
      const timer = setTimeout(resolve, ms);
      // Do not hold the event loop open on a pending sleep during shutdown.
      if (typeof timer.unref === 'function') timer.unref();
    }),
};
