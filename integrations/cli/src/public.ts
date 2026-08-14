/**
 * PF-581 — the CLI's importable surface, for L20's TTFE drill.
 *
 * p.7 puts the example drill at `integrations/cli/tests/ttfe.drill.ts` — inside
 * this package's directory, but written by L20. These exports are what let that
 * drill instrument the REAL command paths. A drill that re-implemented
 * `runLogin` would be timing a code path the demo does not run, and it would
 * drift the first time this lane changed anything.
 *
 * Everything here takes an injectable `OutputSink` and `CliClock` and reads no
 * `process.argv`.
 */
export { run, type RunOptions } from './run.js';
export { runLogin, userCodeLine, USER_CODE_LINE_PREFIX, type LoginOptions } from './commands/login.js';
export {
  runDocsLs,
  runDocsGet,
  runDocsCreate,
  DEFAULT_LIMIT,
  PRINTED_DOCUMENT_FIELDS,
  type DocsLsOptions,
  type DocsCreateOptions,
} from './commands/docs.js';
export {
  runWebhooksTail,
  ownedByThisCli,
  signatureTimestampOf,
  DEFAULT_EVENT,
  LISTEN_PATH_PREFIX,
  POLL_INTERVAL_MS,
  type WebhooksTailOptions,
} from './commands/webhooksTail.js';

export { EXIT_CODES, EXIT_CODE_NAMES, type ExitCode, type ExitCodeName } from './exitCodes.js';
export { USAGE, COMMANDS } from './usage.js';
export { parseArgv, firstValue, integerValue, type ParsedArgv } from './argv.js';
export {
  processSink,
  RecordingSink,
  realClock,
  type OutputSink,
  type CliClock,
} from './io.js';
export {
  contextDefaults,
  buildClient,
  credentialsPathOf,
  tokenStoreOf,
  type CommandContext,
  type BuiltClient,
} from './context.js';
export {
  resolveInstance,
  resolveClientId,
  CLIENT_ID_ENV_VAR,
  type ResolvedInstance,
  type CliBaseUrlSource,
} from './config.js';
export {
  readSettings,
  writeSettings,
  defaultSettingsPath,
  type CliSettings,
} from './settings.js';
export {
  withCredentialLock,
  lockPathFor,
  lockHolderPid,
  STALE_AFTER_MS,
  ACQUIRE_TIMEOUT_MS,
  POLL_INTERVAL_MS as LOCK_POLL_INTERVAL_MS,
} from './credentialLock.js';
export { renderFailure, reportFailure, offendingField, type RenderedFailure } from './errors.js';
export {
  renderDeliveryBlock,
  deliveryJson,
  verifyDelivery,
  formatLocalTime,
  localOffsetMinutes,
  MAX_COLUMNS,
  type DeliveryBlockInput,
  type EventEnvelope,
  type VerificationResult,
  type VerificationFailure,
} from './render/delivery.js';
