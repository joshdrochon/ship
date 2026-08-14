/**
 * PF-739 — the listener boots from named variables, or it does not boot.
 *
 * *"A missing variable fails at boot naming the variable, never at first
 * delivery, because a listener that boots and then silently drops signed
 * deliveries is the worst failure available during a graded demo."*
 *
 * Every variable is reported at once rather than one per restart: a boot that
 * names one missing variable, and then another, and then another, is four
 * restarts to learn something the first one already knew.
 *
 * Same failure shape L99 F91 records against `WEBHOOK_SECRET_KEY` on the server
 * side — resolved lazily, so the deployment boots green and 500s three layers
 * from the cause. This is that lesson applied on the subscriber side.
 */

export interface SlackIntegrationConfig {
  /** Slack app credentials — the install flow (PF-740). */
  slackClientId: string;
  slackClientSecret: string;
  /** Slack's own request signing secret. Not Ship's. */
  slackSigningSecret: string;

  /** Ship OAuth app, so the listener can create its own subscriptions. */
  shipClientId: string;
  shipClientSecret: string;
  shipBaseUrl: string;

  /** The subscription's signing secret, shown once by `webhooks.create`. */
  shipWebhookSigningSecret: string;

  /** Where the listener listens. */
  port: number;
  /** Public base for the install redirect URI. */
  publicUrl: string;
  /**
   * Overrides the Slack Web API host.
   *
   * Present so PF-743 can point the REAL `@slack/bolt` `WebClient` at a stubbed
   * Slack rather than at a hand-written double: the test then exercises the same
   * request builder, the same retry policy and the same error mapping that
   * production uses, and only the host differs. `WebClient` takes it as
   * `slackApiUrl`, so this is that option and not a fork of the client.
   */
  slackApiUrl?: string;
}

const REQUIRED = {
  slackClientId: 'SLACK_CLIENT_ID',
  slackClientSecret: 'SLACK_CLIENT_SECRET',
  slackSigningSecret: 'SLACK_SIGNING_SECRET',
  shipClientId: 'SHIP_CLIENT_ID',
  shipClientSecret: 'SHIP_CLIENT_SECRET',
  shipBaseUrl: 'SHIP_BASE_URL',
  shipWebhookSigningSecret: 'SHIP_WEBHOOK_SIGNING_SECRET',
} as const;

export class MissingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `integrations/slack cannot boot. Missing: ${missing.join(', ')}.\n` +
        'All of them are named in integrations/slack/README.md. This fails HERE, at boot, ' +
        'rather than at the first delivery — a listener that starts and then silently drops ' +
        'signed deliveries is the worst failure available during a graded demo.',
    );
    this.name = 'MissingConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SlackIntegrationConfig {
  const missing = Object.values(REQUIRED).filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) throw new MissingConfigError(missing);

  const port = Number.parseInt(env.PORT ?? '3200', 10);

  return {
    slackClientId: env[REQUIRED.slackClientId] as string,
    slackClientSecret: env[REQUIRED.slackClientSecret] as string,
    slackSigningSecret: env[REQUIRED.slackSigningSecret] as string,
    shipClientId: env[REQUIRED.shipClientId] as string,
    shipClientSecret: env[REQUIRED.shipClientSecret] as string,
    shipBaseUrl: (env[REQUIRED.shipBaseUrl] as string).replace(/\/+$/, ''),
    shipWebhookSigningSecret: env[REQUIRED.shipWebhookSigningSecret] as string,
    port: Number.isFinite(port) && port > 0 ? port : 3200,
    publicUrl: (env.SLACK_INTEGRATION_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    ...(env.SLACK_API_URL !== undefined && env.SLACK_API_URL !== ''
      ? { slackApiUrl: env.SLACK_API_URL }
      : {}),
  };
}

/** The variable names, exported so the README and a test can agree on them. */
export const REQUIRED_ENV_VARS = Object.values(REQUIRED);
