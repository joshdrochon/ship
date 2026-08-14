/**
 * The agent's composition root — PF-704. ONE flag, ONE name, ONE read site.
 *
 * ---------------------------------------------------------------------------
 * `SHIP_AGENT_VIA_SDK`, boolean, DEFAULT OFF.
 * ---------------------------------------------------------------------------
 * PRD p.11: the rewire lands *"behind a feature flag so Part 2's tests pass with
 * the flag on or off."*
 *
 * Off is the shipped Part 2 behaviour — direct SQL reads, real comments, real
 * `document_history` rows. An environment that has never heard of this variable
 * keeps working exactly as it did, and turning the rewire on is a deliberate
 * act by someone who knows what changes. The reverse default would make every
 * existing deployment silently adopt a behavioural change (D5b) at the next
 * deploy, which is the one thing a flag exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * READ IN EXACTLY ONE NON-TEST MODULE, AND `flagSite.test.ts` GREPS FOR IT.
 * ---------------------------------------------------------------------------
 * A flag read in five places is five places to be inconsistent — and worse, the
 * CI matrix in PF-706 would then be exercising a combination no deployment ever
 * has: reader on, actions off. Every consumer takes the RESOLVED value as an
 * argument, so a test drives both states by passing a boolean rather than by
 * mutating `process.env` and hoping module load order cooperates.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSE IS STRICT.
 * ---------------------------------------------------------------------------
 * `'1'` and `'true'` are on; everything else — including `'yes'`, `'TRUE '` with
 * a stray space, and an empty string — is off. A permissive parser turns a typo
 * into a silent no-op in the direction of the OLD behaviour, which is the
 * failure that gets diagnosed as "the rewire does nothing" three days later.
 * Being strict means a typo behaves like the default, which is the safe
 * direction, and the operator can see the exact accepted values here.
 */

/** The one environment variable this lane introduces. */
export const AGENT_VIA_SDK_ENV_VAR = 'SHIP_AGENT_VIA_SDK';

/** The two spellings that mean on. Anything else is off. */
const TRUTHY = new Set(['1', 'true']);

/**
 * Resolves the flag. The ONLY place `process.env.SHIP_AGENT_VIA_SDK` is read.
 *
 * Takes an environment rather than reading the global directly so the parse
 * itself is testable without touching the process — and so the one grep that
 * pins the single read site has one obvious file to find it in.
 */
export function agentViaSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AGENT_VIA_SDK_ENV_VAR];
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
