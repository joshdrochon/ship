/**
 * Opaque cursor pagination for every public list endpoint.
 *
 * Shape: { data: T[], next_cursor: string | null }
 *
 * The cursor is base64url over { id, ts } — opaque so consumers never build on
 * our page arithmetic, keyset-based so pages stay correct while rows are
 * inserted/deleted/reordered mid-read, and O(1) at any depth with an index on
 * (created_at, id).
 */

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface CursorPayload {
  /** Tie-breaker id of the last row on the previous page. */
  id: string;
  /** ISO timestamp of the last row on the previous page. */
  ts: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof raw === 'object' && raw !== null &&
      typeof (raw as CursorPayload).id === 'string' &&
      typeof (raw as CursorPayload).ts === 'string'
    ) {
      return { id: (raw as CursorPayload).id, ts: (raw as CursorPayload).ts };
    }
    return null;
  } catch {
    return null; // malformed cursor → caller raises ApiError('validation_failed')
  }
}

/** Default and maximum page sizes for public list endpoints. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
