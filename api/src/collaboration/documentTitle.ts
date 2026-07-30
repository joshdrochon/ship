import * as Y from 'yjs';

/**
 * The document title as a Yjs shared type.
 *
 * Background (W6-9): the body lives in `yjs_state` as a CRDT and merges two
 * concurrent writers correctly. The title lived only on the `documents.title`
 * column, written by a debounced `PATCH /api/documents/:id`, with nothing
 * reconciling two writers — the last PATCH to land overwrote the column, so one
 * user's typing was silently destroyed in 13 of 13 measured runs.
 *
 * The fix puts the title in the same Y.Doc as the body under the key `title`, so
 * it merges the same way. This module is the server's half of that: seed the
 * shared type from the column when a room is first created, read it back when
 * persisting, and replace it when a non-collaborative caller (a sidebar rename
 * over REST) changes the title.
 *
 * Kept as pure functions over a Y.Doc, with no database or socket access, so the
 * merge behaviour is unit-testable without a server.
 */
export const TITLE_FIELD = 'title';

/** Transaction origins, so `doc.on('update')` handlers can attribute a change. */
export const TITLE_SEED_ORIGIN = 'ship:title-seed';
export const TITLE_REST_ORIGIN = 'ship:title-rest';

/**
 * `Untitled` is the stored default for a new document, and the editor renders it
 * as an empty field with placeholder styling. It therefore means "no title yet"
 * and must never be seeded into the CRDT, or the placeholder turns into literal
 * text the user has to delete.
 */
function isRealTitle(title: unknown): title is string {
  return typeof title === 'string' && title.length > 0 && title !== 'Untitled';
}

export function getTitleText(doc: Y.Doc): Y.Text {
  return doc.getText(TITLE_FIELD);
}

/**
 * Put the column's title into the Y.Doc when the shared type is still empty.
 *
 * Call this once, at room creation, before any client has synced — the server is
 * the only writer at that moment, so exactly one seed happens. Seeding from a
 * client instead would let two clients seed the same string concurrently, and Yjs
 * would keep both ("TitleTitle").
 *
 * @returns true if a seed was written.
 */
export function seedTitleIntoDoc(doc: Y.Doc, dbTitle: unknown): boolean {
  const ytitle = getTitleText(doc);
  if (ytitle.length > 0) return false;
  if (!isRealTitle(dbTitle)) return false;

  doc.transact(() => ytitle.insert(0, dbTitle), TITLE_SEED_ORIGIN);
  return true;
}

/**
 * Bring a freshly loaded room's title into agreement with the column.
 *
 * Call this at room creation instead of `seedTitleIntoDoc` alone. Three cases:
 *
 *   - The CRDT is empty -> seed from the column (a document nobody has edited
 *     collaboratively yet).
 *   - They already agree -> nothing to do. This is the normal case: every persist
 *     writes `yjs_state` and `title` in the same statement.
 *   - They disagree and the column holds a real title -> the column wins.
 *     Divergence can only mean a REST write (a rename from the document tree, an
 *     import) landed after the last persist, because that is the only writer that
 *     touches the column without touching `yjs_state`. Trusting `yjs_state` here
 *     would silently revert the rename on the next persist — which is how the
 *     first cut of the W6-9 fix behaved, and the measurement harness caught it.
 *
 * A column reading `Untitled` or empty never overrides a CRDT title, so a title
 * typed in the editor cannot be blanked by a document row that was never renamed.
 *
 * @returns which branch was taken, for the log line.
 */
export function reconcileTitleOnLoad(
  doc: Y.Doc,
  dbTitle: unknown
): 'seeded' | 'agreed' | 'column-wins' | 'kept-crdt' {
  const current = getTitleText(doc).toString();

  if (!isRealTitle(dbTitle)) return current.length > 0 ? 'kept-crdt' : 'agreed';
  if (current === dbTitle) return 'agreed';
  if (current.length === 0) {
    seedTitleIntoDoc(doc, dbTitle);
    return 'seeded';
  }

  replaceTitleInDoc(doc, dbTitle);
  return 'column-wins';
}

/**
 * The title to persist, or null when the column must be left alone.
 *
 * Null covers documents whose CRDT title has never been populated (an untouched
 * `Untitled` document): writing an empty string there would blank a title that
 * REST may legitimately hold.
 */
export function readTitleFromDoc(doc: Y.Doc): string | null {
  const text = getTitleText(doc).toString();
  return text.length > 0 ? text : null;
}

/**
 * Replace the CRDT title with `title`.
 *
 * Used for writes that carry no character-level intent — a rename from the
 * document tree, an import, an admin fix — where last-writer-wins is the correct
 * semantic. Without this, a REST rename would be silently undone: the live room
 * still holds the old string and the next debounced persist writes it back over
 * the rename.
 *
 * @returns true if the document was changed.
 */
export function replaceTitleInDoc(doc: Y.Doc, title: unknown): boolean {
  const ytitle = getTitleText(doc);
  const next = isRealTitle(title) ? title : '';
  if (ytitle.toString() === next) return false;

  doc.transact(() => {
    if (ytitle.length > 0) ytitle.delete(0, ytitle.length);
    if (next.length > 0) ytitle.insert(0, next);
  }, TITLE_REST_ORIGIN);
  return true;
}
