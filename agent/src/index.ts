/**
 * FleetGraph — a project intelligence agent for Ship.
 *
 * Ship shows you what is happening; it does not tell you what is wrong. This
 * package watches project state, decides what is worth a human's attention, and
 * knows when to act and when to stay quiet.
 *
 * Architecture and the reasoning behind it: PRESEARCH.md at the repo root.
 * Execution plan: TICKETS.md.
 *
 * Two entrypoints, one graph. The difference is the trigger, not the graph:
 *
 *   src/entrypoints/cron.ts   proactive — Render cron, every 3 minutes
 *   (API route)               on-demand — invoked from chat in the Ship UI
 *
 * Both converge at the context node, which is what keeps "one graph, two
 * triggers" true rather than aspirational.
 */

export const FLEETGRAPH_VERSION = '0.0.0';
