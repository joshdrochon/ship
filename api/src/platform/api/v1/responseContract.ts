/**
 * PF-360 — the declared response schema is the object the handler actually
 * returns.
 *
 * ## Why this ticket exists at all
 *
 * PF-373's parity test proves an operation EXISTS for every route. It does not
 * prove the operation is TRUE. Without this file, a handler can add a field, drop
 * a field, or rename one, and every test in L13 stays green while the published
 * contract quietly becomes fiction — which is the same failure as a hand-written
 * spec, arriving by a different door.
 *
 * ## The decision: enforce in test and dev, log-only in production
 *
 * **Ours, not the PRD's** — the PRD does not discuss response validation. Two
 * facts drive it:
 *
 *   - MVP gate item 9 (p.6) caps the public API at +10% P95 against the Part 1
 *     baseline. Parsing every response body through Zod on every request is a
 *     real cost against a real budget, and the budget is graded.
 *   - The failure this catches is a code change, not a data condition. A drifted
 *     handler drifts for every request, so it is caught by the first test run and
 *     the first dev request. Production enforcement would buy almost nothing and
 *     could turn a cosmetic drift into a 500 for a paying consumer.
 *
 * So production logs and serves; everywhere else it throws. The log line is
 * deliberately loud and names the route, because a production violation means
 * the test suite has a hole.
 */
import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

/** True where a contract violation must fail the request rather than be logged. */
export function isResponseContractEnforced(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Raised when a 2xx body does not match the route's declared response schema.
 *
 * A distinct class rather than a bare `Error` so a test can assert on the type,
 * and so `apiErrorMiddleware` sees something with a recognisable name in the
 * server log when it scrubs it into a 500.
 */
export class ResponseContractViolation extends Error {
  constructor(
    readonly route: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(
      `${route} returned a body that does not match its declared response schema:\n` +
        issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n') +
        `\n\nThe schema is the published contract — it is what /api/v1/openapi.json ` +
        `serves and what every SDK type is generated from. A handler and its declared ` +
        `response cannot disagree: either the handler is wrong, or the declaration is ` +
        `stale and the change is a breaking one that needs saying out loud.`,
    );
    this.name = 'ResponseContractViolation';
  }
}

/**
 * Wraps `res.json` so a 2xx body is checked against `schema` before it is sent.
 *
 * Only 2xx. Error bodies are produced by `apiErrorMiddleware` from
 * `apiErrorBodySchema` and are already the one shape; checking them here would
 * assert a resource's success schema against an error envelope and fail every
 * 404.
 *
 * `res.json` rather than `res.send` because every public handler uses `res.json`
 * — enforced by the envelope clause and by the `Content-Type` assertions in the
 * resource tests. A handler reaching for `res.send` with a JSON string would slip
 * past this, and that is a known limit rather than an oversight: it would also
 * slip past `express.json`'s own serialization and is not a shape the router
 * produces today.
 */
export function responseContract(schema: z.ZodTypeAny, route: string): RequestHandler {
  return function responseContractLayer(_req: Request, res: Response, next): void {
    const originalJson = res.json.bind(res);

    res.json = function contractedJson(body?: unknown) {
      // Restore immediately: a handler that calls res.json twice would otherwise
      // re-wrap, and Express itself calls res.json from res.send in some paths.
      res.json = originalJson;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }));
          const violation = new ResponseContractViolation(route, issues);

          if (isResponseContractEnforced()) {
            // Thrown, not `next()`ed: we are inside the handler's own call stack,
            // so the throw unwinds through `asyncRoute`'s catch into
            // `apiErrorMiddleware` and the caller gets the envelope. Calling
            // `next(err)` here would send the body first and then try to send an
            // error after headers were already flushed.
            throw violation;
          }

          // Production: serve the body, shout about it. A violation reaching
          // production means the test suite has a hole, and that is the thing
          // worth knowing.
          console.error(`[api/v1] response contract violation: ${violation.message}`);
        }
      }

      return originalJson(body);
    } as Response['json'];

    next();
  };
}
