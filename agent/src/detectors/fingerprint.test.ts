/**
 * The suppression key's contract.
 *
 * These assertions are the cost cliff from PRESEARCH.md Q32 expressed as tests.
 * If stability breaks, nothing is ever suppressed and every finding is re-judged
 * every three minutes. If bucketing breaks, a worsening condition is silently
 * swallowed by the first mild observation of it. Both fail as a cost graph
 * rather than an error, so they are asserted here rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import { fingerprint, bucketOf, countBucket } from './fingerprint.js';

const TARGET = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

describe('bucketOf', () => {
  it('groups business-day counts into coarse bands', () => {
    expect(bucketOf(0)).toBe('<5d');
    expect(bucketOf(4)).toBe('<5d');
    expect(bucketOf(5)).toBe('5-9d');
    expect(bucketOf(9)).toBe('5-9d');
    expect(bucketOf(10)).toBe('10-19d');
    expect(bucketOf(19)).toBe('10-19d');
    expect(bucketOf(20)).toBe('20d+');
    expect(bucketOf(400)).toBe('20d+');
  });

  it('does NOT change band merely because a day passed', () => {
    // The reason bucketing exists. Keying on the raw count would give an idle
    // issue a new fingerprint every single day, so it would re-surface daily —
    // the alert-fatigue failure, dressed as new information.
    expect(bucketOf(5)).toBe(bucketOf(6));
    expect(bucketOf(6)).toBe(bucketOf(9));
  });

  it('changes band when the situation materially worsens', () => {
    expect(bucketOf(9)).not.toBe(bucketOf(10));
  });
});

describe('countBucket', () => {
  it('bands magnitudes', () => {
    expect(countBucket(1)).toBe('<=2');
    expect(countBucket(2)).toBe('<=2');
    expect(countBucket(3)).toBe('3-4');
    expect(countBucket(5)).toBe('5-8');
    expect(countBucket(20)).toBe('9+');
  });
});

describe('fingerprint', () => {
  it('is STABLE — identical inputs give an identical key', () => {
    // Without this nothing is ever suppressed.
    expect(fingerprint('stalled_work', TARGET, '5-9d')).toBe(
      fingerprint('stalled_work', TARGET, '5-9d')
    );
  });

  it('is BUCKETED — a worse bucket is a different finding', () => {
    expect(fingerprint('stalled_work', TARGET, '5-9d')).not.toBe(
      fingerprint('stalled_work', TARGET, '20d+')
    );
  });

  it('separates targets', () => {
    expect(fingerprint('stalled_work', TARGET, '5-9d')).not.toBe(
      fingerprint('stalled_work', OTHER, '5-9d')
    );
  });

  it('separates signal types on the same target', () => {
    // A stalled issue and a rework-churn issue are different findings about the
    // same document and must both be able to be open at once.
    expect(fingerprint('stalled_work', TARGET, '5-9d')).not.toBe(
      fingerprint('rework_churn', TARGET, '5-9d')
    );
  });

  it('cannot be confused by component boundaries', () => {
    // Concatenating without a separator would let ('a','bc') collide with
    // ('ab','c'). Asserted because the failure would be invisible: two unrelated
    // findings would silently suppress each other.
    expect(fingerprint('stalled_work', 'ab', 'c')).not.toBe(
      fingerprint('stalled_work', 'a', 'bc')
    );
  });

  it('is a bounded-width hex key, not the raw components', () => {
    const fp = fingerprint('stalled_work', TARGET, '5-9d');
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(fp).not.toContain(TARGET);
  });
});
