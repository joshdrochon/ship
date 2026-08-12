/**
 * PF-215 — turning body-parser failures into the envelope, with the right code.
 *
 * ## Why this file exists
 *
 * `express.json()` rejects a bad body by calling `next(err)` with a
 * `raw-body`/`body-parser` error — `PayloadTooLargeError`, `SyntaxError`,
 * `UnsupportedMediaTypeError`. None of them is an `ApiError`, so the terminal
 * handler correctly treats them as unknown and scrubs them into
 * `server_error` / 500.
 *
 * That is the wrong answer, and wrong in a way that costs a consumer real time:
 * a 500 means "we broke, retry" and an SDK with a retry ladder will retry a 2 MB
 * body forever, at exponentially increasing intervals, until it gives up. The
 * request is a CLIENT error. It will never succeed unchanged, and the caller has
 * to be told that.
 *
 * The fix belongs here rather than inside `apiErrorMiddleware`: that handler's
 * contract is "anything I do not recognise is a server error", which is exactly
 * right and must stay right. Recognising specific upstream error types is a
 * translation concern, and it is mounted directly under the parser that produces
 * them so the coupling is visible.
 *
 * ## The 413 that is a 422, and why
 *
 * HTTP's answer for an oversized body is 413. The public error code set is CLOSED
 * at six codes (PRD p.7, printed verbatim), and `STATUS_BY_CODE` derives the
 * status FROM the code, so there is no route to a 413 that does not add a seventh
 * code. Adding one is a three-lane change and contradicts a page the PRD prints
 * literally, to buy a status nobody branches on — an SDK's `catch` asks "is this
 * my fault and can I fix it", and `validation_failed` answers yes to both.
 *
 * So: 422 with `details.fields[{ field: 'body', … }]`, and a message that names
 * the actual limit. This is a real cost of the closed code set and is recorded
 * as such rather than hidden — see `docs/architecture.md`.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './errors.js';

/** The `type` values body-parser stamps onto its errors. */
interface BodyParserError extends Error {
  type?: string;
  limit?: number;
  length?: number;
  status?: number;
  statusCode?: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && typeof (err as BodyParserError).type === 'string';
}

/** Bytes → a short human unit, for a message a developer can act on. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Error middleware. Mount IMMEDIATELY below the public body parser — an error
 * handler only sees failures raised above it.
 *
 * Anything it does not recognise is passed straight through to the terminal
 * handler unchanged, so this cannot become a second place that decides what a
 * server error is.
 */
export function bodyErrorMiddleware() {
  return (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    if (!isBodyParserError(err)) {
      next(err);
      return;
    }

    switch (err.type) {
      case 'entity.too.large':
        next(
          new ApiError(
            'validation_failed',
            'Request body is too large for the public API.',
            {
              details: {
                fields: [
                  {
                    field: 'body',
                    message:
                      `Body exceeds the ${humanBytes(err.limit ?? 0)} limit` +
                      (typeof err.length === 'number' ? ` (received ${humanBytes(err.length)})` : '') +
                      '. The public API does not accept payloads this size; the internal ' +
                      'editor surface is not the same limit.',
                  },
                ],
              },
              cause: err,
            },
          ),
        );
        return;

      case 'entity.parse.failed':
        next(
          new ApiError('validation_failed', 'Request body is not valid JSON.', {
            details: {
              fields: [{ field: 'body', message: 'Could not parse the request body as JSON.' }],
            },
            cause: err,
          }),
        );
        return;

      case 'encoding.unsupported':
      case 'charset.unsupported':
        next(
          new ApiError('validation_failed', 'Unsupported request body encoding.', {
            details: {
              fields: [{ field: 'content-type', message: `Unsupported encoding: ${err.message}` }],
            },
            cause: err,
          }),
        );
        return;

      default:
        // Unrecognised. The terminal handler's judgement stands.
        next(err);
    }
  };
}
