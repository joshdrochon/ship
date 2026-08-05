/**
 * A minimal circuit breaker for outbound calls (Implementation Rule 7).
 *
 * Written here rather than pulled in as a dependency: dependency changes are out
 * of scope for this lane, and the whole useful behaviour is 40 lines.
 *
 * Three states, the standard ones:
 *   closed    — calls go through; consecutive failures are counted
 *   open      — calls fail immediately without touching the dependency
 *   half-open — after the cooldown, one call is let through to test the water
 *
 * What a breaker buys that a retry does not: a retry makes a single request more
 * likely to succeed, but when the dependency is *down* it multiplies the load and
 * multiplies the latency every caller waits through. The breaker converts a slow
 * failure into a fast one, and stops piling requests onto something that is
 * already unwell.
 */
export interface CircuitBreakerOptions {
  /** Name used in log lines. */
  name: string;
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before letting one call through. */
  cooldownMs: number;
  /** Injectable clock, so tests do not have to wait out the cooldown. */
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * What `stats` reports.
 *
 * Named rather than inferred because consumers in other packages re-export it.
 * An anonymous inferred type cannot be written into another package's `.d.ts`
 * without a relative path back into `node_modules`, which TypeScript refuses
 * as non-portable (TS2742). It only surfaced on a clean build — incremental
 * builds had the shape cached and stayed quiet.
 */
export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
}

export class CircuitOpenError extends Error {
  constructor(name: string, readonly retryAfterMs: number) {
    super(`Circuit "${name}" is open; retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private halfOpenInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The current decision, carrying the data that goes with it.
   *
   * A discriminated union rather than a bare state string for two reasons: the
   * `open` case is the only one with a remaining cooldown, so the type makes that
   * impossible to read in the other cases; and `run` needs the state and the
   * remaining time together, which two getter calls could not guarantee — the
   * clock can tick between them, and the second call can disagree with the first.
   */
  private evaluate():
    | { state: 'closed' }
    | { state: 'open'; retryAfterMs: number }
    | { state: 'half-open' } {
    const openedAt = this.openedAt;
    if (openedAt === null) return { state: 'closed' };

    const elapsed = this.now() - openedAt;
    if (elapsed >= this.options.cooldownMs) return { state: 'half-open' };
    return { state: 'open', retryAfterMs: this.options.cooldownMs - elapsed };
  }

  get state(): CircuitState {
    return this.evaluate().state;
  }

  /** Diagnostics for a health endpoint or a log line. */
  get stats(): CircuitBreakerStats {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }

  /**
   * Run `fn` unless the circuit is open.
   *
   * @throws CircuitOpenError without calling `fn` when the circuit is open, or
   *         when a half-open probe is already in flight — one probe at a time,
   *         so a recovering dependency is not hit by every waiting caller at once.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const decision = this.evaluate();

    if (decision.state === 'open') {
      throw new CircuitOpenError(this.options.name, decision.retryAfterMs);
    }

    if (decision.state === 'half-open') {
      if (this.halfOpenInFlight) {
        throw new CircuitOpenError(this.options.name, 0);
      }
      this.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  private onSuccess(): void {
    if (this.openedAt !== null) {
      console.log(`[circuit:${this.options.name}] Probe succeeded, closing circuit`);
    }
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      // Re-stamp on every failure while open, so a failing half-open probe starts
      // a fresh cooldown rather than letting a probe through on every call.
      this.openedAt = this.now();
      console.warn(
        `[circuit:${this.options.name}] Opening for ${this.options.cooldownMs}ms ` +
        `after ${this.consecutiveFailures} consecutive failures`
      );
    }
  }

  /** Test and operational escape hatch. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
  }
}
