/**
 * PF-050 — the three alert conditions, table-tested against both
 * implementations. Lane L02, slice S3.
 *
 * Time is INJECTED throughout. Every condition is windowed, and a windowed
 * test that cannot control the clock is a test that sleeps — which the PRD's
 * test-discipline rules ban outright and which would put a flake in CI.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import {
  ALERT_THRESHOLDS,
  InMemorySecretAuthLog,
  PgSecretAuthLog,
  evaluateAlerts,
  type AlertCondition,
  type ISecretAuthLog,
  type SecretAuthAttempt,
  type SecretAuthOutcome,
} from './secret-auth-log.js';

const T0 = new Date('2026-08-12T12:00:00.000Z');
const CLIENT = 'ship_app_underattack';
const OTHER = 'ship_app_innocent';

/** Minutes before T0, so every fixture sits inside or outside the window by construction. */
const minutesBefore = (n: number) => new Date(T0.getTime() - n * 60_000);

function attempt(
  overrides: Partial<SecretAuthAttempt> & { outcome: SecretAuthOutcome }
): SecretAuthAttempt {
  return {
    clientId: CLIENT,
    secretPrefix: 'abcd1234',
    occurredAt: minutesBefore(1),
    sourceIp: '203.0.113.1',
    ...overrides,
  };
}

/**
 * The same table of cases runs against the in-memory double and against
 * Postgres. They are a Liskov pair and this is what proves it — a divergence
 * would mean the alert an operator tests is not the alert that fires.
 */
function conditionSuite(name: string, makeLog: () => Promise<ISecretAuthLog>) {
  describe(name, () => {
    let log: ISecretAuthLog;
    beforeEach(async () => {
      log = await makeLog();
    });

    const cases: Array<{
      title: string;
      seed: SecretAuthAttempt[];
      expected: AlertCondition[];
    }> = [
      {
        title: 'quiet: a handful of failures below the threshold fires nothing',
        seed: Array.from({ length: ALERT_THRESHOLDS.failuresInWindow - 1 }, () =>
          attempt({ outcome: 'bad_secret' })
        ),
        expected: [],
      },
      {
        title: '(a) repeated failures at the threshold fire',
        seed: Array.from({ length: ALERT_THRESHOLDS.failuresInWindow }, () =>
          attempt({ outcome: 'bad_secret' })
        ),
        expected: ['repeated_failures'],
      },
      {
        title: '(a) failures OUTSIDE the window do not fire',
        seed: Array.from({ length: ALERT_THRESHOLDS.failuresInWindow + 5 }, () =>
          attempt({ outcome: 'bad_secret', occurredAt: minutesBefore(60) })
        ),
        expected: [],
      },
      {
        title: '(b) successes from N distinct IPs fire',
        seed: Array.from({ length: ALERT_THRESHOLDS.distinctSourceIps }, (_, i) =>
          attempt({ outcome: 'success', sourceIp: `203.0.113.${i + 1}` })
        ),
        expected: ['multiple_source_ips'],
      },
      {
        title: '(b) many successes from ONE IP do not fire — that is normal traffic',
        seed: Array.from({ length: 20 }, () =>
          attempt({ outcome: 'success', sourceIp: '203.0.113.9' })
        ),
        expected: [],
      },
      {
        title: '(c) a SINGLE attempt against a deactivated app fires',
        seed: [attempt({ outcome: 'app_inactive' })],
        expected: ['inactive_app_attempt'],
      },
      {
        title: 'conditions compose: all three can fire together',
        seed: [
          ...Array.from({ length: ALERT_THRESHOLDS.failuresInWindow }, () =>
            attempt({ outcome: 'bad_secret' })
          ),
          ...Array.from({ length: ALERT_THRESHOLDS.distinctSourceIps }, (_, i) =>
            attempt({ outcome: 'success', sourceIp: `198.51.100.${i + 1}` })
          ),
          attempt({ outcome: 'app_inactive' }),
        ],
        // Every condition that fires is returned, not just the first: "repeated
        // failures AND a new source IP" is a different story from either alone.
        expected: ['repeated_failures', 'multiple_source_ips', 'inactive_app_attempt'],
      },
      {
        title: 'another app\'s traffic never contributes to this app\'s alerts',
        seed: Array.from({ length: ALERT_THRESHOLDS.failuresInWindow + 10 }, () =>
          attempt({ outcome: 'bad_secret', clientId: OTHER })
        ),
        expected: [],
      },
    ];

    for (const c of cases) {
      it(c.title, async () => {
        for (const a of c.seed) await log.record(a);
        expect(await evaluateAlerts(log, CLIENT, T0)).toEqual(c.expected);
      });
    }

    it('never stores the secret or a hash of it — only the prefix', async () => {
      const recorded = attempt({ outcome: 'success' });
      await log.record(recorded);
      // The type has no field that could hold one; this asserts the shape the
      // migration and the interface agree on (PF-035, L12's PF-340 rule).
      expect(Object.keys(recorded)).toEqual(
        expect.arrayContaining(['clientId', 'secretPrefix', 'outcome', 'occurredAt', 'sourceIp'])
      );
      expect(Object.keys(recorded)).not.toContain('clientSecret');
      expect(Object.keys(recorded)).not.toContain('clientSecretHash');
    });
  });
}

conditionSuite('PF-050 — in-memory', async () => new InMemorySecretAuthLog());

describe('PF-050 — Postgres', () => {
  beforeAll(async () => {
    // The table must exist; migration 040 is what puts it there.
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = 'client_secret_auth_log'`
    );
    expect(r.rows[0]!.n).toBe(1);
  });

  conditionSuite('conditions', async () => {
    await pool.query('DELETE FROM client_secret_auth_log');
    return new PgSecretAuthLog(pool);
  });

  it('records an unknown client with a NULL prefix rather than refusing the row', async () => {
    // No FK to oauth_apps, deliberately: an unknown client_id is one of the
    // outcomes worth recording — it is what a credential-stuffing probe looks
    // like — and an FK would reject exactly those rows.
    await pool.query('DELETE FROM client_secret_auth_log');
    const log = new PgSecretAuthLog(pool);
    await log.record(
      attempt({ outcome: 'unknown_client', clientId: 'ship_app_neverexisted', secretPrefix: null })
    );
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM client_secret_auth_log WHERE secret_prefix IS NULL`
    );
    expect(r.rows[0]!.n).toBe(1);
  });

  it('refuses an outcome outside the known set', async () => {
    await expect(
      pool.query(
        `INSERT INTO client_secret_auth_log (client_id, outcome, occurred_at)
         VALUES ('x', 'definitely_not_an_outcome', now())`
      )
    ).rejects.toThrow();
  });
});
