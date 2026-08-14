/**
 * Composes several resource mounts into the one `mountResources` callback
 * `createPublicRouter` takes.
 *
 * ## Why this exists rather than a second hook
 *
 * `PublicRouterDeps.mountResources` is a single function, and that is right:
 * the hook's job is to guarantee resource routes land ABOVE the unknown-path
 * catch-all and the terminal error handler, and one hook is one place that
 * ordering is decided. Widening it to an array would put the composition
 * decision inside L07's router; keeping it single and composing here leaves the
 * router's contract alone and makes the composition root's list of resources a
 * list.
 *
 * ## Why order does not matter here, and where it would
 *
 * These mounts register disjoint paths (`/documents*`, `/me`, later `/issues*`
 * and `/sprints*`), so their relative order is not observable. It WOULD matter
 * for two routes whose Express patterns overlap — `/sprints/current` after
 * `/sprints/:id` never matches, because `:id` accepts the literal `current`. If
 * a resource ever grows such a pair, the fix is inside that resource's own mount
 * function where both routes are visible, not in the order of this array.
 */
import type { Router } from 'express';

export type ResourceMount = (router: Router) => void;

export function mountAllResources(mounts: readonly ResourceMount[]): ResourceMount {
  return (router: Router) => {
    for (const mount of mounts) mount(router);
  };
}
