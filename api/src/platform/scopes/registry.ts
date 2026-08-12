/**
 * PF-061 / PF-063 / PF-065 — the `ScopeRegistry` data structure.
 *
 * Scopes are data. The PRD's design pressure for this module is one sentence
 * (p.3): *"New scopes register at module load, never edit middleware."* That is
 * only true if the thing holding the scopes knows nothing about HTTP — so this
 * file imports nothing from `express` and nothing from `../api/v1/`, and a unit
 * test imports it in a bare Node context with no HTTP stack at all.
 *
 * The registration surface is deliberately four methods and no more:
 *
 *   register(def)  — throws on a duplicate, and on a name that does not
 *                    round-trip `${resource}:${action}`
 *   has(scope)     — type predicate, so a validated string narrows to the
 *                    registry's scope union
 *   get(scope)     — the definition, which is what the 403 reads for its
 *                    human-readable `scope_description`
 *   list()         — every definition, in registration order
 *
 * The class is generic over its scope union so a *fresh* registry in a test can
 * carry scopes the production one has never heard of (`plugins:read`) without
 * either casting or widening the production type. That is what makes PF-066's
 * Open/Closed proof a real test rather than a restatement: the middleware is
 * bound to a registry, not to a hard-coded list.
 *
 * The seven canonical scopes are NOT here — they are in `./scopes.ts`. Adding a
 * scope is an edit to that file and to nothing else, which is the whole claim
 * `docs/architecture.md` makes about this module under Open/Closed.
 */

/** One scope, as data. `scope` is always exactly `${resource}:${action}`. */
export interface ScopeDefinition<S extends string = string> {
  /** The wire name — what appears in a token, a consent screen and a 403. */
  readonly scope: S;
  /** The public resource the scope governs (`documents`, `sprints`, …). */
  readonly resource: string;
  /** What the scope permits on that resource (`read`, `write`, `manage`). */
  readonly action: string;
  /**
   * Consent-grade prose, reused verbatim in two places: the `/oauth/authorize`
   * consent screen (L04) and the `details.scope_description` field of the 403
   * (PF-070). Written as a phrase that completes "This app will be able to …",
   * because a description that only reads well in one of the two ends up
   * duplicated, and then the two copies drift.
   */
  readonly description: string;
}

/**
 * A second registration of an already-registered name.
 *
 * Its own class rather than a bare `Error` because the failure is specific and
 * the caller may want to distinguish it: a silent overwrite would change the
 * description the 403 reads, and nothing downstream would ever notice.
 */
export class DuplicateScopeError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(
      `Scope "${scope}" is already registered. Scopes are registered once at module load; ` +
        `a second registration would silently shadow the first, including the description the ` +
        `403 body reads back to callers.`,
    );
    this.name = 'DuplicateScopeError';
    this.scope = scope;
  }
}

/** A registration whose name does not agree with its `resource`/`action` pair. */
export class MalformedScopeError extends Error {
  readonly scope: string;

  constructor(scope: string, resource: string, action: string) {
    super(
      `Scope "${scope}" does not round-trip: resource "${resource}" + action "${action}" ` +
        `produces "${resource}:${action}". The wire name and its parts must agree — the parts ` +
        `are what a consent screen groups by and what an audit row filters on.`,
    );
    this.name = 'MalformedScopeError';
    this.scope = scope;
  }
}

export class ScopeRegistry<S extends string = string> {
  readonly #defs = new Map<string, ScopeDefinition<S>>();

  /**
   * Register a scope. Throws rather than overwrites.
   *
   * Called at module load, so a throw here is a boot failure — which is the
   * intent. An unregistered or double-registered scope is a defect in the
   * program, not a condition to handle at request time.
   */
  register(def: ScopeDefinition<S>): void {
    if (`${def.resource}:${def.action}` !== def.scope) {
      throw new MalformedScopeError(def.scope, def.resource, def.action);
    }
    if (def.description.trim() === '') {
      throw new Error(
        `Scope "${def.scope}" has an empty description. The description is shown verbatim on the ` +
          `consent screen and in the 403 body; an empty one makes both meaningless.`,
      );
    }
    if (this.#defs.has(def.scope)) {
      throw new DuplicateScopeError(def.scope);
    }
    this.#defs.set(def.scope, def);
  }

  /** Type predicate: a validated string narrows to this registry's union. */
  has(scope: string): scope is S {
    return this.#defs.has(scope);
  }

  /** The definition, or `undefined` if the name was never registered. */
  get(scope: string): ScopeDefinition<S> | undefined {
    return this.#defs.get(scope);
  }

  /** Every definition, in registration order. */
  list(): ScopeDefinition<S>[] {
    return [...this.#defs.values()];
  }

  /** Just the names — what a token, a consent payload and a 403 carry. */
  names(): S[] {
    return this.list().map((d) => d.scope);
  }

  /** How many scopes are registered. PF-065 asserts a failed register leaves this unchanged. */
  get size(): number {
    return this.#defs.size;
  }
}
