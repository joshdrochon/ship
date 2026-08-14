/**
 * PF-050 — the leaked-`client_secret` audit signal and the three conditions
 * worth alerting on. Lane L02, slice S3.
 *
 * PRD p.17: "How do you detect and respond to a leaked client_secret … What's
 * the audit signal you'd alert on?"
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A FILTER OVER L12's PUBLIC AUDIT TRAIL.
 * ---------------------------------------------------------------------------
 * Measured, not assumed. L12's audit middleware (PF-336) is the second
 * middleware of the `/api/v1` stack, so it sees only `/api/v1` traffic. A
 * `client_secret` is presented at `/oauth/token`, which `createApp()` mounts at
 * `app.use('/oauth', …)` — outside `/api/v1` entirely. No `public_api_calls`
 * row can ever record a secret authentication, so this lane has to own the
 * recording path or p.17's question has no answer.
 *
 * If L04 or L06 later route the token endpoint through the v1 stack, this
 * module collapses into a query over L12's table and should be deleted rather
 * than kept alongside it.
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMIT, stated rather than implied.
 * ---------------------------------------------------------------------------
 * This ships the conditions and the rows that satisfy them. It does not ship
 * alert DELIVERY: the platform has no `/metrics` endpoint and no notifier, so
 * these are queryable and testable, not paged. p.18 asks where observability
 * "shows up (logs, /metrics, dev portal)" and the truthful answer for this
 * signal today is "logs and a query". The missing piece is a surface, and
 * inventing one is not this lane's work.
 */
import type { QueryRunner } from '../../db/client.js';

/** What happened on one client-secret verification attempt. */
export type SecretAuthOutcome = 'success' | 'unknown_client' | 'bad_secret' | 'app_inactive';

export interface SecretAuthAttempt {
  clientId: string;
  /** Null when no app matched — there is no secret it could have prefixed. */
  secretPrefix: string | null;
  outcome: SecretAuthOutcome;
  /** Injected, never `now()` — every alert condition is windowed. */
  occurredAt: Date;
  sourceIp: string | null;
}

export interface ISecretAuthLog {
  record(attempt: SecretAuthAttempt): Promise<void>;
  /** (a) Failed verifications for one client_id inside a window. */
  countFailures(clientId: string, since: Date, until: Date): Promise<number>;
  /** (b) Distinct source IPs with a SUCCESSFUL verification inside a window. */
  countDistinctSuccessIps(clientId: string, since: Date, until: Date): Promise<number>;
  /** (c) Any attempt at all against a deactivated app inside a window. */
  countInactiveAttempts(clientId: string, since: Date, until: Date): Promise<number>;
}

/**
 * Thresholds. Named constants rather than literals at the call site, because
 * these are the numbers an operator tunes and they should be findable.
 *
 * Deliberately not derived from anything — there is no production traffic to
 * derive them from. They are starting points, and saying so is more useful than
 * a fabricated justification.
 */
export const ALERT_THRESHOLDS = {
  /** (a) Repeated failures: the shape a rotated-then-retried thief makes. */
  failuresInWindow: 10,
  /** (b) One secret in use from more places than an integration should have. */
  distinctSourceIps: 3,
  /** (c) Any attempt against a deactivated app is itself the signal. */
  inactiveAttempts: 1,
  windowMs: 15 * 60 * 1000,
} as const;

export type AlertCondition = 'repeated_failures' | 'multiple_source_ips' | 'inactive_app_attempt';

/**
 * Evaluates all three conditions for one `client_id` over one window.
 *
 * Returns every condition that fires, not the first — an operator responding to
 * a leak wants the whole picture, and "repeated failures AND a new source IP"
 * is a materially different story from either alone.
 */
export async function evaluateAlerts(
  log: ISecretAuthLog,
  clientId: string,
  now: Date,
  windowMs: number = ALERT_THRESHOLDS.windowMs
): Promise<AlertCondition[]> {
  const since = new Date(now.getTime() - windowMs);
  const fired: AlertCondition[] = [];

  if ((await log.countFailures(clientId, since, now)) >= ALERT_THRESHOLDS.failuresInWindow) {
    fired.push('repeated_failures');
  }
  if (
    (await log.countDistinctSuccessIps(clientId, since, now)) >= ALERT_THRESHOLDS.distinctSourceIps
  ) {
    fired.push('multiple_source_ips');
  }
  if (
    (await log.countInactiveAttempts(clientId, since, now)) >= ALERT_THRESHOLDS.inactiveAttempts
  ) {
    fired.push('inactive_app_attempt');
  }
  return fired;
}

/** Postgres-backed log. Constructed in the composition root only. */
export class PgSecretAuthLog implements ISecretAuthLog {
  constructor(private db: QueryRunner) {}

  async record(attempt: SecretAuthAttempt): Promise<void> {
    // No secret and no hash — `secret_prefix` is the identifier (PF-035),
    // honouring L12's PF-340 rule for the same reason.
    await this.db.query(
      `INSERT INTO client_secret_auth_log
         (client_id, secret_prefix, outcome, source_ip, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attempt.clientId,
        attempt.secretPrefix,
        attempt.outcome,
        attempt.sourceIp,
        attempt.occurredAt,
      ]
    );
  }

  async countFailures(clientId: string, since: Date, until: Date): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM client_secret_auth_log
        WHERE client_id = $1 AND outcome <> 'success'
          AND occurred_at > $2 AND occurred_at <= $3`,
      [clientId, since, until]
    );
    return r.rows[0]?.n ?? 0;
  }

  async countDistinctSuccessIps(clientId: string, since: Date, until: Date): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `SELECT count(DISTINCT source_ip)::int AS n FROM client_secret_auth_log
        WHERE client_id = $1 AND outcome = 'success' AND source_ip IS NOT NULL
          AND occurred_at > $2 AND occurred_at <= $3`,
      [clientId, since, until]
    );
    return r.rows[0]?.n ?? 0;
  }

  async countInactiveAttempts(clientId: string, since: Date, until: Date): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM client_secret_auth_log
        WHERE client_id = $1 AND outcome = 'app_inactive'
          AND occurred_at > $2 AND occurred_at <= $3`,
      [clientId, since, until]
    );
    return r.rows[0]?.n ?? 0;
  }
}

/** In-memory double — the same contract, for tests and for lanes downstream. */
export class InMemorySecretAuthLog implements ISecretAuthLog {
  readonly entries: SecretAuthAttempt[] = [];

  async record(attempt: SecretAuthAttempt): Promise<void> {
    this.entries.push({ ...attempt });
  }

  private inWindow(clientId: string, since: Date, until: Date): SecretAuthAttempt[] {
    return this.entries.filter(
      (e) =>
        e.clientId === clientId &&
        e.occurredAt.getTime() > since.getTime() &&
        e.occurredAt.getTime() <= until.getTime()
    );
  }

  async countFailures(clientId: string, since: Date, until: Date): Promise<number> {
    return this.inWindow(clientId, since, until).filter((e) => e.outcome !== 'success').length;
  }

  async countDistinctSuccessIps(clientId: string, since: Date, until: Date): Promise<number> {
    const ips = new Set(
      this.inWindow(clientId, since, until)
        .filter((e) => e.outcome === 'success' && e.sourceIp !== null)
        .map((e) => e.sourceIp)
    );
    return ips.size;
  }

  async countInactiveAttempts(clientId: string, since: Date, until: Date): Promise<number> {
    return this.inWindow(clientId, since, until).filter((e) => e.outcome === 'app_inactive').length;
  }
}
