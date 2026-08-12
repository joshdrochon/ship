/**
 * PF-077 / PF-078 — the one place where a public contract name is translated
 * into Ship's internal vocabulary.
 *
 * ## The rule
 *
 * **A public resource name is a contract. An internal name is an implementation
 * detail.** They are allowed to differ, they are allowed to keep differing, and
 * the only sanctioned place to know that they differ is this file. A route
 * handler that reaches for an internal name directly has copied a fact that now
 * exists twice, and the copy is what breaks when either side is renamed.
 *
 * ## What actually differs, verified against the repo
 *
 * Exactly one name: the public `sprints` is Ship's internal `weeks`.
 *
 *   internal HTTP path   `/api/weeks` — `api/src/app.ts:293` (two routers mount
 *                        there: `weeksRoutes` and `iterationsRoutes`)
 *   document_type        already `'sprint'` — `api/src/db/schema.sql:100`
 *
 * That second line is the one that keeps this file small. The *table* does not
 * need translating; `document_type` has said `'sprint'` since Part 1. What
 * diverges is the route path and the surrounding vocabulary — variable names,
 * router file names, the word a Ship engineer says out loud. So this is a
 * route-path-and-vocabulary map, not a column map, and building it as a general
 * name-translation layer would be inventing a problem the schema does not have.
 *
 * `documents` and `issues` are listed even though they are identity mappings.
 * A map holding one entry reads as an exception someone bolted on; a map holding
 * every public resource makes the single divergence visible as a divergence,
 * and gives the next resource an obvious place to land.
 *
 * ## Ownership (PF-078)
 *
 * **L03 owns this file. L10 consumes it.** L10's `/api/v1/sprints` routes import
 * `internalPathFor('sprints')` rather than restating `/api/weeks`, and a fitness
 * test asserts the sprints route module contains no `weeks` literal. Do not
 * split the knowledge across both lanes — one half drifting from the other is
 * the exact failure this file exists to prevent.
 *
 * ## Why it lives in `api/v1/` and not in `scopes/` (dispute B7)
 *
 * The lane file originally placed it under `platform/scopes/`, because
 * `docs/architecture.md` put the sprints/weeks note beside the scope registry.
 * L10 independently concluded it belongs here, and L10 is right: this map's key
 * is a URL path segment and its value is an internal route, which is the public
 * router's business. It shares only a substring with the scope name
 * `sprints:read`. Nothing in `scopes/` reads it — `requireScope` takes a scope
 * name and never resolves a resource. PF-077's grep fitness test covers all of
 * `platform/**`, so it holds under either path; the directory was the only thing
 * in question, and this is the answer both lanes reached.
 */

/** One public resource, and everything that is true about its internal shape. */
export interface PublicResourceMapping {
  /** The public contract name. Also the URL segment under `/api/v1/`. */
  readonly resource: string;
  /**
   * Ship's internal Express mount for the same data, or `null` for a resource
   * that has no internal counterpart.
   *
   * The public router does not proxy to it — the boundary lint forbids
   * `platform/` importing an internal route file at all. This records where the
   * internal surface lives so the two can be reasoned about together, and so
   * nobody has to grep `app.ts` to find out.
   */
  readonly internalRoutePath: string | null;
  /**
   * The `document_type` enum value this resource is stored as, or `null` when
   * the resource does not correspond to exactly one enum value.
   *
   * Present because it is the field people *assume* needs translating for
   * sprints and does not — `document_type` has said `'sprint'` since Part 1.
   */
  readonly documentType: string | null;
}

/**
 * The map. Adding a public resource is an entry here.
 *
 * `as const satisfies` rather than a bare annotation, so `PublicResourceName`
 * below is derived from the data and the two cannot drift — the same discipline
 * `Scope` gets in `platform/scopes/scopes.ts`.
 */
export const PUBLIC_RESOURCES = [
  {
    // `documentType: null` is a fact, not a gap. The public `documents`
    // resource spans the documents table rather than one enum value — Ship
    // stores wiki, program, project and the rest in the same table (see
    // CLAUDE.md, "everything is a document"). L09 decides which types it
    // exposes; inventing a single value here would be guessing on its behalf.
    resource: 'documents',
    internalRoutePath: '/api/documents',
    documentType: null,
  },
  {
    resource: 'issues',
    internalRoutePath: '/api/issues',
    documentType: 'issue',
  },
  {
    // The only divergence on the public surface. See the module header.
    resource: 'sprints',
    internalRoutePath: '/api/weeks',
    documentType: 'sprint',
  },
  {
    // Not a document and no internal counterpart — webhook subscriptions are
    // new in Week 6 and exist only on the public surface.
    resource: 'webhooks',
    internalRoutePath: null,
    documentType: null,
  },
] as const satisfies readonly PublicResourceMapping[];

/** The public resource names, derived from the data above. */
export type PublicResourceName = (typeof PUBLIC_RESOURCES)[number]['resource'];

/** Thrown when something asks about a resource the public surface does not have. */
export class UnknownPublicResourceError extends Error {
  constructor(resource: string) {
    super(
      `"${resource}" is not a public resource. The public surface is defined by ` +
        `PUBLIC_RESOURCES in platform/api/v1/resource-map.ts; adding a resource is an ` +
        `entry there, not a string somewhere else.`,
    );
    this.name = 'UnknownPublicResourceError';
  }
}

export function resourceMapping(resource: PublicResourceName): PublicResourceMapping {
  const found = PUBLIC_RESOURCES.find((r) => r.resource === resource);
  if (!found) throw new UnknownPublicResourceError(resource);
  return found;
}

/**
 * Ship's internal route path for a public resource.
 *
 * This is what L10's sprints routes call instead of writing the internal name.
 */
export function internalPathFor(resource: PublicResourceName): string | null {
  return resourceMapping(resource).internalRoutePath;
}

/** The `document_type` a public resource stores as, or null if it is not a document. */
export function documentTypeFor(resource: PublicResourceName): string | null {
  return resourceMapping(resource).documentType;
}

/** Whether a name from an untrusted source is a public resource at all. */
export function isPublicResource(resource: string): resource is PublicResourceName {
  return PUBLIC_RESOURCES.some((r) => r.resource === resource);
}
