import { describe, it, expect } from 'vitest';
import { reconnectDelayMs, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './useRealtimeEvents';

/**
 * Rule 7, WebSocket surface — the `/events` reconnect.
 *
 * It used to retry on a flat 3000 ms forever with no jitter. The collaboration
 * server rate-limits connections at 30 per minute per IP
 * (api/src/collaboration/index.ts, RATE_LIMIT.MAX_CONNECTIONS_PER_IP), and a flat
 * 3 s retry is 20 attempts a minute from a single tab: two tabs exceed the limit
 * on their own, and the resulting 429s are themselves attempts, so an outage left
 * a user rate-limited against their own workspace and slowed recovery.
 */
describe('/events reconnect backoff (Rule 7)', () => {
  it('backs off exponentially', () => {
    // Sampled because of the jitter; compare windows, not points. Walking a
    // running minimum instead of indexing pairs keeps the assertion identical
    // (each window's floor strictly above the previous one) without reaching for
    // `windows[i]!`, which noUncheckedIndexedAccess types as possibly undefined.
    let previousMin = 0;

    for (const attempt of [1, 2, 3, 4]) {
      const samples = Array.from({ length: 200 }, () => reconnectDelayMs(attempt));
      const min = Math.min(...samples);

      expect(min).toBeGreaterThan(previousMin);
      previousMin = min;
    }

    // The first window's floor is half the base delay, by construction.
    const firstMin = Math.min(...Array.from({ length: 200 }, () => reconnectDelayMs(1)));
    expect(firstMin).toBeGreaterThanOrEqual(RECONNECT_BASE_MS / 2);
  });

  it('caps the delay so a long outage settles at a fixed low rate', () => {
    for (const attempt of [10, 25, 100, 10_000]) {
      const delay = reconnectDelayMs(attempt);
      expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(RECONNECT_MAX_MS / 2);
    }
  });

  it('stays under the server\'s 30-connections-per-minute limit during an outage', () => {
    // The regression this guards: a retry rate that trips the server's own
    // limiter. Rate is cumulative, not per attempt, so count attempts inside a
    // 60 s window using the shortest delay each step can produce (worst case).
    const MAX_CONNECTIONS_PER_IP = 30;
    const shortestDelay = (attempt: number) =>
      Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS) / 2;

    const countInWindow = (windowMs: number) => {
      let elapsed = 0;
      let attempts = 0;
      while (true) {
        elapsed += shortestDelay(attempts + 1);
        if (elapsed > windowMs) break;
        attempts++;
      }
      return attempts;
    };

    // A single tab, and four tabs behind the same session, both fit.
    expect(countInWindow(60_000)).toBeLessThan(MAX_CONNECTIONS_PER_IP);
    expect(countInWindow(60_000) * 4).toBeLessThan(MAX_CONNECTIONS_PER_IP);

    // The old flat 3000 ms delay did not: 20 attempts a minute per tab.
    expect(Math.floor(60_000 / 3_000)).toBeGreaterThan(countInWindow(60_000));
  });

  it('jitters, so tabs that dropped together do not retry together', () => {
    const samples = new Set(Array.from({ length: 100 }, () => reconnectDelayMs(5)));
    expect(samples.size).toBeGreaterThan(50);
  });

  it('never returns a non-positive or non-finite delay', () => {
    for (const attempt of [-5, 0, 1, 7, 64]) {
      const delay = reconnectDelayMs(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});
