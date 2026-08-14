#!/usr/bin/env node
/**
 * PF-739 — the boot.
 *
 * `loadConfig` throws naming every missing variable BEFORE a socket is opened.
 * That ordering is the ticket: a listener that boots and then silently drops
 * signed deliveries is the worst failure available during a graded demo, and it
 * is the same shape L99 F91 records against `WEBHOOK_SECRET_KEY` on the server
 * side — resolved lazily, so the deployment starts green and 500s three layers
 * from the cause.
 */
import { loadConfig, MissingConfigError } from './config.js';
import { createSlackGateway, createInstallationStore } from './slack.js';
import { createSlackListener } from './server.js';

export { loadConfig, MissingConfigError, REQUIRED_ENV_VARS } from './config.js';
export type { SlackIntegrationConfig } from './config.js';
export { createSlackListener, WEBHOOK_PATH, INSTALL_PATH, OAUTH_CALLBACK_PATH, SLACK_INSTALL_SCOPES } from './server.js';
export type { ServerDeps, ListenerLog } from './server.js';
export { createSlackGateway, createInstallationStore } from './slack.js';
export type { Installation, InstallationStore, PostResult, SlackGateway } from './slack.js';
export { renderMessage, isPostedEventType, POSTED_EVENT_TYPES } from './render.js';
export type { RenderedMessage, PostedEventType } from './render.js';
export {
  classifyUpstream,
  PERMANENT_SLACK_ERRORS,
  TRANSIENT_SLACK_ERRORS,
  PERMANENT_STATUS,
  TRANSIENT_STATUS,
} from './classify.js';
export type { SlackFailure, UpstreamDecision } from './classify.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof MissingConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw err;
  }

  const { app } = createSlackListener({
    config,
    slack: createSlackGateway(
      config.slackApiUrl !== undefined ? { slackApiUrl: config.slackApiUrl } : {},
    ),
    installations: createInstallationStore(),
    channel: process.env.SLACK_CHANNEL ?? '#ship',
  });

  app.listen(config.port, () => {
    process.stdout.write(
      `ship-slack: listening on :${config.port}\n` +
        `  deliveries  POST ${config.publicUrl}/ship/webhooks\n` +
        `  install     GET  ${config.publicUrl}/slack/install\n`,
    );
  });
}

// Only when run as a binary. Importing this module for its exports must not
// bind a port — `oneListener.test.ts` reads the tree, and a module that listens
// on import would also make every test that imports it a server.
if (process.argv[1] !== undefined && process.argv[1].endsWith('index.js')) main();
