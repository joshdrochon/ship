/**
 * The Slack half: the OAuth install (PF-740) and `chat.postMessage` (PF-742).
 *
 * Built on `@slack/bolt`'s own `WebClient`, not on a hand-rolled `fetch`. p.10
 * names the stack, and it earns its place here: the same request builder, the
 * same `SlackAPIError` shape and the same retry policy that production uses are
 * what PF-743 and PF-744 assert against. A `fetch` double would let this file's
 * tests agree with themselves and disagree with Slack.
 *
 * ── The tests point the real client at a stub host ────────────────────────
 * `WebClient` takes a `slackApiUrl`, so `SLACK_API_URL` redirects every call to
 * a stubbed Slack served by PF-721's listener. That is what "a stubbed Slack
 * API" in PF-743 means here: a real client, a real HTTP request, a fake server.
 *
 * ── Installations are per workspace, in memory ────────────────────────────
 * PF-740 rules out a pasted `SLACK_BOT_TOKEN`: p.8 names Slack OAuth as part of
 * what this integration IS, and a pasted token proves neither the install flow
 * nor the multi-workspace shape. The store below is a `Map`, which is honest for
 * a single-process listener and is the seam a durable store would replace — it
 * is an interface for that reason, not for symmetry.
 */
// ── DEVIATION FROM PF-739's LITERAL WORDING, and it is deliberate ────────
//
// The ticket says "Express + `@slack/bolt`", following p.10's stack table.
// Bolt is a framework for apps that RECEIVE from Slack — events, slash
// commands, interactivity, socket mode. This integration receives from SHIP and
// only SENDS to Slack: two calls, `chat.postMessage` and `oauth.v2.access`.
//
// Measured before deciding: `@slack/bolt@5` does not re-export `WebClient` at
// all (`tsc` says so — TS2614), so using Bolt here would mean either depending
// on it AND on `@slack/web-api` (which Bolt itself depends on for exactly this
// class), or standing up an `App` + `ExpressReceiver` whose entire receiving
// half is dead code. The first makes the manifest and the import graph disagree
// — a phantom dependency, which is the thing PF-716's whole check exists to
// catch. The second is weight with no consumer.
//
// So: `@slack/web-api`, which is the Slack-published client Bolt would have
// handed over anyway. Recorded here rather than quietly done, and filed as F153.
import { WebClient } from '@slack/web-api';

export interface Installation {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string | null;
  installedAt: string;
}

export interface InstallationStore {
  save(installation: Installation): void;
  get(teamId: string): Installation | undefined;
  /** The one used when a delivery names no workspace. */
  any(): Installation | undefined;
  size(): number;
}

export function createInstallationStore(): InstallationStore {
  const byTeam = new Map<string, Installation>();
  return {
    save: (installation) => void byTeam.set(installation.teamId, installation),
    get: (teamId) => byTeam.get(teamId),
    any: () => byTeam.values().next().value,
    size: () => byTeam.size,
  };
}

export interface PostResult {
  ok: boolean;
  /** Slack's own `error` string when it answered with one. */
  slackError: string | null;
  status: number | null;
  channel: string;
}

export interface SlackGateway {
  /** `oauth.v2.access` — the install exchange. */
  exchangeInstallCode(code: string, redirectUri: string): Promise<Installation>;
  postMessage(botToken: string, channel: string, text: string): Promise<PostResult>;
}

interface SlackErrorish {
  data?: { error?: unknown; ok?: unknown };
  code?: unknown;
  message?: string;
}

/** Pulls Slack's `error` out of whatever the client threw, without guessing. */
function slackErrorOf(err: unknown): { slackError: string | null; status: number | null } {
  const e = err as SlackErrorish & { status?: unknown };
  const fromData = typeof e?.data?.error === 'string' ? e.data.error : null;
  const status = typeof e?.status === 'number' ? e.status : null;
  return { slackError: fromData, status };
}

export function createSlackGateway(options: { slackApiUrl?: string } = {}): SlackGateway {
  const clientOptions = options.slackApiUrl !== undefined ? { slackApiUrl: options.slackApiUrl } : {};

  return {
    async exchangeInstallCode(code, redirectUri): Promise<Installation> {
      // Unauthenticated call — the client id and secret ride in the body.
      const client = new WebClient(undefined, clientOptions);
      const result = (await client.oauth.v2.access({
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
        code,
        redirect_uri: redirectUri,
      })) as unknown as {
        access_token?: string;
        bot_user_id?: string;
        team?: { id?: string; name?: string };
      };

      const teamId = result.team?.id;
      const botToken = result.access_token;
      if (typeof teamId !== 'string' || typeof botToken !== 'string') {
        throw new Error('Slack returned no team id or bot token from oauth.v2.access');
      }

      return {
        teamId,
        teamName: result.team?.name ?? null,
        botToken,
        botUserId: result.bot_user_id ?? null,
        installedAt: new Date().toISOString(),
      };
    },

    async postMessage(botToken, channel, text): Promise<PostResult> {
      const client = new WebClient(botToken, {
        ...clientOptions,
        // Zero retries HERE, deliberately. The retry policy that matters is
        // SHIP's ladder, and PF-744's whole shape is this process telling Ship
        // whether to use it. A client-side retry would blur a transient failure
        // into a slow success and hide the decision.
        retryConfig: { retries: 0 },
      });
      try {
        await client.chat.postMessage({ channel, text });
        return { ok: true, slackError: null, status: 200, channel };
      } catch (err) {
        const { slackError, status } = slackErrorOf(err);
        return { ok: false, slackError, status, channel };
      }
    },
  };
}
