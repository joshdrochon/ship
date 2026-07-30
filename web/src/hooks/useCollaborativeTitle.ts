import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import * as Y from 'yjs';
import { applyTextDiff } from '@/lib/yTextDiff';

/**
 * Shared-type key for the document title inside the editor's Y.Doc. The server
 * reads and seeds the same key (api/src/collaboration/documentTitle.ts).
 */
export const TITLE_FIELD = 'title';

/** Transaction origin used for edits this client made, so observers can tell them apart. */
export const TITLE_LOCAL_ORIGIN = 'ship:title-local';

/**
 * How long to wait before falling back to a REST save. Only used while the Y.Doc
 * is not yet the source of truth (no collaboration session established), because
 * once it is, the collaboration server persists the title from the CRDT.
 */
export const TITLE_FALLBACK_SAVE_MS = 1500;

interface UseCollaborativeTitleOptions {
  /** The editor's Y.Doc. The title lives in `ydoc.getText('title')`. */
  ydoc: Y.Doc;
  /** Server-rendered title, used only until the CRDT has a value. */
  initialTitle: string;
  /**
   * REST fallback save. Called only when no collaboration session has been
   * established, so the CRDT cannot persist the title itself.
   */
  onFallbackSave?: (title: string) => void;
  /** The title textarea, used to keep the caret stable across remote edits. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Backs the document title with the same CRDT the body already uses.
 *
 * The bug this replaces (W6-9): the title was plain React state saved by a
 * debounced `PATCH /api/documents/:id`, and nothing reconciled two writers — the
 * last PATCH to land overwrote the whole column, so one user's typing was
 * destroyed in 13 of 13 measured runs while the body (Yjs) merged correctly.
 *
 * The title is now a `Y.Text` in the same document as the body, so two writers
 * interleave instead of overwriting, and the collaboration server persists it on
 * the same debounce as the content.
 *
 * `Untitled` is the stored default for a new document and is rendered as an empty
 * field with placeholder styling, so it is treated as "no title yet" here and is
 * never written into the CRDT.
 */
export function useCollaborativeTitle({
  ydoc,
  initialTitle,
  onFallbackSave,
  inputRef,
}: UseCollaborativeTitleOptions) {
  const ytitle = useMemo(() => ydoc.getText(TITLE_FIELD), [ydoc]);

  const [title, setTitle] = useState(initialTitle === 'Untitled' ? '' : initialTitle);
  const titleRef = useRef(title);
  titleRef.current = title;

  /** True once the Y.Doc — not the `initialTitle` prop — owns the value. */
  const crdtReadyRef = useRef(false);
  const userTypedRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caretRef = useRef<number | null>(null);

  // A new Y.Doc means a different document: drop all per-document state.
  useEffect(() => {
    crdtReadyRef.current = false;
    userTypedRef.current = false;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [ytitle]);

  useEffect(() => {
    const onChange = (event?: Y.YTextEvent) => {
      const next = ytitle.toString();

      // A remote insert before the caret would otherwise throw the caret to the
      // end of the field on the next controlled re-render. Shift it instead.
      const isRemote = !event || event.transaction.origin !== TITLE_LOCAL_ORIGIN;
      const el = inputRef?.current;
      if (isRemote && el && el.ownerDocument.activeElement === el) {
        const caret = el.selectionStart ?? el.value.length;
        caretRef.current = Math.max(0, Math.min(next.length, caret + (next.length - el.value.length)));
      }

      crdtReadyRef.current = true;
      setTitle(next);
    };

    ytitle.observe(onChange);
    // A doc restored from IndexedDB or synced before this effect ran already has
    // a value; adopt it rather than waiting for the next change.
    if (ytitle.length > 0) onChange();

    return () => ytitle.unobserve(onChange);
  }, [ytitle, inputRef]);

  useEffect(() => {
    if (caretRef.current === null) return;
    const caret = caretRef.current;
    caretRef.current = null;
    const el = inputRef?.current;
    if (el && el.ownerDocument.activeElement === el) el.setSelectionRange(caret, caret);
  }, [title, inputRef]);

  // Until the CRDT has a value, the server-rendered prop is the best source.
  useEffect(() => {
    if (crdtReadyRef.current || userTypedRef.current) return;
    setTitle(initialTitle === 'Untitled' ? '' : initialTitle);
  }, [initialTitle]);

  /** Feed the textarea's whole new value in; the diff is applied to the CRDT. */
  const setTitleFromInput = useCallback((next: string) => {
    userTypedRef.current = true;
    setTitle(next);

    if (crdtReadyRef.current) {
      applyTextDiff(ytitle, next, TITLE_LOCAL_ORIGIN);
      return;
    }

    // No collaboration session yet, so nothing will persist the CRDT. Save over
    // REST — but re-check on fire, because if the session came up in the meantime
    // the CRDT owns the field and a REST write would clobber other writers.
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      if (crdtReadyRef.current) return;
      onFallbackSave?.(titleRef.current);
    }, TITLE_FALLBACK_SAVE_MS);
  }, [ytitle, onFallbackSave]);

  /**
   * Call when the collaboration provider reports a completed sync. From that
   * point the Y.Doc is authoritative for the title.
   */
  const markSynced = useCallback(() => {
    if (crdtReadyRef.current) return;

    const remote = ytitle.toString();
    const local = titleRef.current;

    if (remote === '' && local !== '' && userTypedRef.current) {
      // Typed before the session came up, and the server has no title for this
      // document (a new "Untitled" doc). Move the local value into the CRDT so it
      // is not dropped when the CRDT takes over.
      ydoc.transact(() => ytitle.insert(0, local), TITLE_LOCAL_ORIGIN);
    } else if (remote !== '') {
      setTitle(remote);
    }

    crdtReadyRef.current = true;
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, [ydoc, ytitle]);

  useEffect(() => () => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
  }, []);

  return { title, setTitleFromInput, markSynced };
}
