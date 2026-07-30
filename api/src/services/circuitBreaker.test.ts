import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';

/**
 * Tests for the Rule 7 circuit breaker guarding the AWS Bedrock call
 * (api/src/services/ai-analysis.ts, the only third-party call in the request
 * path — it had no timeout, no retry and no breaker).
 *
 * Rule 3 requires stable fakes rather than live external calls, so the dependency
 * is a plain function and the clock is injected: nothing here waits, and nothing
 * depends on network conditions.
 */
describe('CircuitBreaker (Rule 7)', () => {
  function make(overrides: Partial<{ failureThreshold: number; cooldownMs: number }> = {}) {
    let clock = 1_000;
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: overrides.failureThreshold ?? 3,
      cooldownMs: overrides.cooldownMs ?? 60_000,
      now: () => clock,
    });
    return { breaker, advance: (ms: number) => { clock += ms; } };
  }

  const fail = () => Promise.reject(new Error('dependency down'));
  const ok = () => Promise.resolve('result');

  it('passes calls through while the dependency is healthy', async () => {
    const { breaker } = make();
    await expect(breaker.run(ok)).resolves.toBe('result');
    expect(breaker.state).toBe('closed');
  });

  it('stays closed while failures are below the threshold', async () => {
    const { breaker } = make({ failureThreshold: 3 });
    await expect(breaker.run(fail)).rejects.toThrow('dependency down');
    await expect(breaker.run(fail)).rejects.toThrow('dependency down');
    expect(breaker.state).toBe('closed');
  });

  it('opens after the threshold and then stops calling the dependency at all', async () => {
    const { breaker } = make({ failureThreshold: 3 });
    const dependency = vi.fn(fail);

    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(dependency)).rejects.toThrow('dependency down');
    }
    expect(breaker.state).toBe('open');
    expect(dependency).toHaveBeenCalledTimes(3);

    // This is the point of the breaker: the next caller fails immediately without
    // paying the dependency's timeout.
    await expect(breaker.run(dependency)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(dependency).toHaveBeenCalledTimes(3);
  });

  it('reports how long is left before the next probe', async () => {
    const { breaker, advance } = make({ failureThreshold: 1, cooldownMs: 60_000 });
    await expect(breaker.run(fail)).rejects.toThrow();
    advance(20_000);
    await expect(breaker.run(fail)).rejects.toMatchObject({ retryAfterMs: 40_000 });
  });

  it('lets one probe through after the cooldown and closes on success', async () => {
    const { breaker, advance } = make({ failureThreshold: 2, cooldownMs: 60_000 });
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.state).toBe('open');

    advance(60_000);
    expect(breaker.state).toBe('half-open');

    await expect(breaker.run(ok)).resolves.toBe('result');
    expect(breaker.state).toBe('closed');
    expect(breaker.stats.consecutiveFailures).toBe(0);
  });

  it('re-opens for a full cooldown when the probe also fails', async () => {
    const { breaker, advance } = make({ failureThreshold: 2, cooldownMs: 60_000 });
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();

    advance(60_000);
    await expect(breaker.run(fail)).rejects.toThrow('dependency down');
    // Not half-open again immediately: otherwise every caller becomes a probe and
    // the breaker stops protecting the dependency.
    expect(breaker.state).toBe('open');

    advance(59_999);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half-open');
  });

  it('admits only one probe at a time', async () => {
    const { breaker, advance } = make({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(breaker.run(fail)).rejects.toThrow();
    advance(10_000);

    let release: (v: string) => void = () => {};
    const slow = () => new Promise<string>((resolve) => { release = resolve; });

    const first = breaker.run(slow);
    // A second caller arriving while the probe is in flight must not also be sent.
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    release('result');
    await expect(first).resolves.toBe('result');
    expect(breaker.state).toBe('closed');
  });

  it('resets the failure count on any success, so unrelated blips do not accumulate', async () => {
    const { breaker } = make({ failureThreshold: 3 });
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(ok)).resolves.toBe('result');
    expect(breaker.stats.consecutiveFailures).toBe(0);

    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.state).toBe('closed');
  });

  it('reset() clears the circuit', async () => {
    const { breaker } = make({ failureThreshold: 1 });
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
  });
});
