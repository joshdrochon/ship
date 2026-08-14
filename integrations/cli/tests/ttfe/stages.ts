/**
 * PF-591 — the PRD's six stages, in the PRD's order, as data.
 *
 * p.6, verbatim: *"each stage of the drill (install, login, register
 * subscription, create document, receive webhook, verify signature) records
 * elapsed milliseconds."*
 *
 * One frozen array. `Object.freeze` rather than `as const` alone because
 * `readonly` is erased by `tsc` — a consumer that can `push` onto this can add a
 * seventh stage, and a consumer that can reassign an element can rename one. The
 * drill iterates THIS to decide what it must have recorded, so a dropped stage
 * fails the run instead of shortening it.
 */
export const STAGE_IDS = Object.freeze([
  'install',
  'login',
  'register_subscription',
  'create_document',
  'receive_webhook',
  'verify_signature',
] as const);

export type StageId = (typeof STAGE_IDS)[number];

/**
 * The p.6 wording each id stands for, for the human-readable table (PF-592) and
 * for the first line of a failure (PF-593). Kept next to the ids so the two
 * cannot drift into two different vocabularies.
 */
export const STAGE_LABELS: Readonly<Record<StageId, string>> = Object.freeze({
  install: 'install',
  login: 'login',
  register_subscription: 'register subscription',
  create_document: 'create document',
  receive_webhook: 'receive webhook',
  verify_signature: 'verify signature',
});
