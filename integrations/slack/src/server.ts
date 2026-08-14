/**
 * PF-739 / PF-741 / PF-742 / PF-744 — the listener.
 *
 * ── RAW BODY, AT THE ROUTE, AND THIS IS THE WHOLE FILE'S REASON TO EXIST ──
 * The classic bug in this integration is an app-wide `express.json()` that
 * parses the body before the handler sees it. The handler then holds an OBJECT,
 * re-serialises it to verify, and computes an HMAC over bytes the server never
 * signed — different key order, different whitespace, different unicode escapes.
 * Every legitimate delivery is rejected, and the integration looks broken end to
 * end while each half looks correct in isolation.
 *
 * So there is NO app-wide body parser here. `express.raw()` is mounted on the
 * webhook route and on nothing else, and `signatureGate` only accepts a
 * `Buffer` — a caller holding a parsed object gets a type error at the keyboard.
 * `rawBody.test.ts` asserts the app has no app-level parser by walking the
 * router stack, because a comment saying "do not add express.json()" is not a
 * mechanism.
 *
 * ── The order of operations, and why each step is where it is ────────────
 *   1. verify the Ship signature over the raw bytes      — nothing before this
 *   2. parse                                             — only now are the bytes trusted
 *   3. filter the event type                             — a third type posts nothing
 *   4. post to Slack
 *   5. map Slack's failure onto Ship's retry contract     — PF-744
 *
 * Step 1 first is not stylistic. A listener that parses first is one an
 * unauthenticated caller can make do work; a listener that filters first is one
 * that has already trusted the `type` field of an unverified payload.
 */
import express, { type Express, type Request, type Response } from 'express';
import { verifyWebhook, DEFAULT_TOLERANCE_SECONDS } from '@ship/sdk';
import type { SlackIntegrationConfig } from './config.js';
import { classifyUpstream } from './classify.js';
import { renderMessage } from './render.js';
import type { InstallationStore, SlackGateway } from './slack.js';

export const WEBHOOK_PATH = '/ship/webhooks';
export const INSTALL_PATH = '/slack/install';
export const OAUTH_CALLBACK_PATH = '/slack/oauth/callback';

/** The scopes the bot needs to post. Narrow on purpose. */
export const SLACK_INSTALL_SCOPES = ['chat:write', 'chat:write.public'];

export interface ServerDeps {
  config: SlackIntegrationConfig;
  slack: SlackGateway;
  installations: InstallationStore;
  /** Where messages go. One channel; a real app would map per subscription. */
  channel: string;
  /**
   * Unix SECONDS, injected.
   *
   * PF-741's stale-timestamp case is a six-minute-old `t`, and p.11 rules out
   * waiting six minutes to produce it. Passing a clock makes that case
   * instantaneous and deterministic.
   */
  nowSeconds?: () => number;
}

/** Everything the listener did, so a test can assert on more than a status. */
export interface ListenerLog {
  posts: { channel: string; text: string }[];
  rejected: { reason: string; status: number }[];
  ignored: { type: string }[];
  /**
   * Every delivery as it arrived, BEFORE verification.
   *
   * Recorded pre-verification on purpose: PF-741's tampered and stale cases are
   * assertions about deliveries that were REJECTED, and a log that only kept the
   * accepted ones could not tell "rejected it" from "never received it".
   */
  deliveries: { headers: Record<string, string>; rawBody: Buffer }[];
}

export function createSlackListener(deps: ServerDeps): { app: Express; log: ListenerLog } {
  const app = express();
  const log: ListenerLog = { posts: [], rejected: [], ignored: [], deliveries: [] };

  // ── The install flow (PF-740) ────────────────────────────────────────────
  app.get(INSTALL_PATH, (_req: Request, res: Response) => {
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', deps.config.slackClientId);
    url.searchParams.set('scope', SLACK_INSTALL_SCOPES.join(','));
    url.searchParams.set('redirect_uri', `${deps.config.publicUrl}${OAUTH_CALLBACK_PATH}`);
    res.redirect(302, url.toString());
  });

  app.get(OAUTH_CALLBACK_PATH, (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    if (code === null) {
      res.status(400).json({ error: 'missing_code' });
      return;
    }
    void deps.slack
      .exchangeInstallCode(code, `${deps.config.publicUrl}${OAUTH_CALLBACK_PATH}`)
      .then((installation) => {
        deps.installations.save(installation);
        res.status(200).json({ ok: true, team_id: installation.teamId });
      })
      .catch((err: unknown) => {
        res.status(502).json({ error: 'slack_oauth_failed', detail: String(err) });
      });
  });

  // ── The delivery route. `express.raw` HERE and nowhere else. ─────────────
  app.post(
    WEBHOOK_PATH,
    express.raw({ type: '*/*', limit: '1mb' }),
    (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = req.headers as Record<string, string>;
      log.deliveries.push({ headers, rawBody });

      // 1. Signature, over the bytes that arrived.
      //
      // `verifyWebhook` straight from `@ship/sdk` — the published front door,
      // and a RUNTIME dependency. The testkit has a `signatureGate` convenience
      // that wraps exactly this, and it is deliberately NOT used here: the
      // testkit is a dev dependency (it is a fixture), so importing it from
      // `src/` would put a test-only package on the production import path.
      const verified =
        deps.nowSeconds === undefined
          ? verifyWebhook(headers, rawBody, deps.config.shipWebhookSigningSecret)
          : verifyWebhook(
              headers,
              rawBody,
              deps.config.shipWebhookSigningSecret,
              DEFAULT_TOLERANCE_SECONDS,
              { nowSeconds: deps.nowSeconds },
            );
      if (!verified) {
        // 401 is a permanent 4xx under L16's classifier (D9), so Ship
        // dead-letters rather than retrying a secret that will not become
        // correct — and a stale timestamp will not become fresh either.
        log.rejected.push({ reason: 'signature_or_timestamp', status: 401 });
        res.status(401).json({ error: 'signature_did_not_verify' });
        return;
      }

      // 2. Only now are the bytes worth parsing.
      let envelope: { id?: unknown; type?: unknown; data?: unknown };
      try {
        envelope = JSON.parse(rawBody.toString('utf8')) as typeof envelope;
      } catch {
        // Signed by us and unparseable is our bug, not a retryable condition.
        res.status(400).json({ error: 'unparseable_payload' });
        return;
      }

      // 3. Two event types post. A third posts nothing and is ACKNOWLEDGED —
      //    200, not 4xx: the subscription is somebody's deliberate act and a
      //    4xx would dead-letter a delivery Ship was right to send.
      const message = renderMessage(envelope, deps.config.shipBaseUrl);
      if (message === null) {
        log.ignored.push({ type: String(envelope.type) });
        res.status(200).json({ ok: true, posted: false, reason: 'event_type_not_posted' });
        return;
      }

      // 4 & 5. Post, then map the upstream failure onto Ship's contract.
      const installation = deps.installations.any();
      if (installation === undefined) {
        // No workspace has installed the app yet. Transient by construction: a
        // human is about to click Install, and dead-lettering the events that
        // arrived first would lose them permanently.
        res.status(502).json({ error: 'no_slack_installation' });
        return;
      }

      void deps.slack
        .postMessage(installation.botToken, deps.channel, message.text)
        .then((result) => {
          if (result.ok) {
            log.posts.push({ channel: result.channel, text: message.text });
            res.status(200).json({ ok: true, posted: true });
            return;
          }
          const decision = classifyUpstream(result);
          res
            .status(decision.status)
            .json({ error: 'slack_post_failed', disposition: decision.disposition, reason: decision.reason });
        })
        .catch((err: unknown) => {
          const decision = classifyUpstream({ slackError: null, status: null });
          res
            .status(decision.status)
            .json({ error: 'slack_post_threw', disposition: decision.disposition, detail: String(err) });
        });
    },
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, installations: deps.installations.size() });
  });

  return { app, log };
}
