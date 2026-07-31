import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { useCollaborativeTitle } from './useCollaborativeTitle';
import { applyTextDiff } from '@/lib/yTextDiff';

/**
 * Regression tests for W6-9 — "two users editing the same title: one edit is
 * silently destroyed, every time" (13 of 13 measured runs, audit-report.md
 * Category 6).
 *
 * The pre-fix title path was `useState` plus a debounced
 * `PATCH /api/documents/:id`. Nothing reconciled two writers, so the last request
 * to land replaced the whole column. These tests drive the real hook the editor
 * now uses, against real Y.Docs wired together the way the collaboration server
 * wires two browsers, and fail on the pre-fix code path because it had no shared
 * type for the title at all.
 *
 * No network and no fake timers on the merge path: the merge is deterministic, so
 * the reproduction is deterministic (the audit needed 13 browser runs only because
 * *which* user lost was random).
 */

/** Minimal stand-in for the collaboration server: relays updates between docs. */
function connect(...docs: Y.Doc[]) {
  let paused = false;
  const queued: Array<{ from: Y.Doc; update: Uint8Array }> = [];

  const relay = (from: Y.Doc, update: Uint8Array) => {
    for (const to of docs) {
      if (to === from) continue;
      Y.applyUpdate(to, update, 'relay');
    }
  };

  for (const doc of docs) {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'relay') return; // never echo a relayed update back
      if (paused) queued.push({ from: doc, update });
      else relay(doc, update);
    });
  }

  return {
    /** Hold updates so two edits are genuinely concurrent, not sequential. */
    pause: () => { paused = true; },
    /** Deliver everything that happened while paused, in both directions. */
    flush: () => {
      paused = false;
      const pending = queued.splice(0);
      for (const { from, update } of pending) relay(from, update);
    },
  };
}

function mountTitle(ydoc: Y.Doc, initialTitle: string, onFallbackSave?: (t: string) => void) {
  return renderHook(() =>
    useCollaborativeTitle({ ydoc, initialTitle, onFallbackSave })
  );
}

const titleOf = (doc: Y.Doc) => doc.getText('title').toString();

/** Put a title into the Y.Doc the way a loaded IndexedDB cache or a server sync would. */
const seedTitle = (doc: Y.Doc, text: string) =>
  doc.transact(() => doc.getText('title').insert(0, text));

describe('useCollaborativeTitle (W6-9 regression)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('keeps both users\' text when two people type in the title at the same time', () => {
    // Server-side state, as seeded by api/src/collaboration/documentTitle.ts.
    const server = new Y.Doc();
    server.getText('title').insert(0, 'Concurrent Edit Test');

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(server), 'relay');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(server), 'relay');

    const wire = connect(server, docA, docB);
    const a = mountTitle(docA, 'Concurrent Edit Test');
    const b = mountTitle(docB, 'Concurrent Edit Test');

    act(() => { a.result.current.markSynced(); b.result.current.markSynced(); });
    expect(a.result.current.title).toBe('Concurrent Edit Test');
    expect(b.result.current.title).toBe('Concurrent Edit Test');

    // Both users append to the end of the same field before either update lands.
    wire.pause();
    act(() => { a.result.current.setTitleFromInput('Concurrent Edit TestTitleFromA'); });
    act(() => { b.result.current.setTitleFromInput('Concurrent Edit TestTitleFromB'); });
    act(() => { wire.flush(); });

    // The whole point of W6-9: neither edit may be destroyed.
    expect(titleOf(server)).toContain('TitleFromA');
    expect(titleOf(server)).toContain('TitleFromB');

    // ...and everyone must agree on the same string, including the baseline text.
    expect(titleOf(docA)).toBe(titleOf(server));
    expect(titleOf(docB)).toBe(titleOf(server));
    expect(titleOf(server)).toContain('Concurrent Edit Test');
    expect(a.result.current.title).toBe(titleOf(server));
    expect(b.result.current.title).toBe(titleOf(server));
  });

  it('keeps both edits when the two users type in different places at once', () => {
    const server = new Y.Doc();
    server.getText('title').insert(0, 'Quarterly Report');
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(server), 'relay');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(server), 'relay');

    const wire = connect(server, docA, docB);
    const a = mountTitle(docA, 'Quarterly Report');
    const b = mountTitle(docB, 'Quarterly Report');
    act(() => { a.result.current.markSynced(); b.result.current.markSynced(); });

    wire.pause();
    // A prefixes, B suffixes.
    act(() => { a.result.current.setTitleFromInput('2026 Quarterly Report'); });
    act(() => { b.result.current.setTitleFromInput('Quarterly Report (final)'); });
    act(() => { wire.flush(); });

    expect(titleOf(server)).toBe('2026 Quarterly Report (final)');
    expect(titleOf(docA)).toBe(titleOf(server));
    expect(titleOf(docB)).toBe(titleOf(server));
  });

  it('propagates a remote rename into a client that is not typing', () => {
    const server = new Y.Doc();
    server.getText('title').insert(0, 'Old Name');
    const docA = new Y.Doc();
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(server), 'relay');
    connect(server, docA);

    const a = mountTitle(docA, 'Old Name');
    act(() => { a.result.current.markSynced(); });

    // Stands in for applyTitleToRoom() after a REST rename from the sidebar.
    act(() => {
      const t = server.getText('title');
      server.transact(() => { t.delete(0, t.length); t.insert(0, 'New Name'); }, 'ship:title-rest');
    });

    expect(titleOf(docA)).toBe('New Name');
    expect(a.result.current.title).toBe('New Name');
  });

  it('does not write "Untitled" into the CRDT, so the placeholder still shows', () => {
    const doc = new Y.Doc();
    const h = mountTitle(doc, 'Untitled');
    act(() => { h.result.current.markSynced(); });
    expect(h.result.current.title).toBe('');
    expect(titleOf(doc)).toBe('');
  });

  it('falls back to a REST save only while there is no collaboration session', async () => {
    vi.useFakeTimers();
    const onFallbackSave = vi.fn();
    const doc = new Y.Doc();
    const h = mountTitle(doc, 'Untitled', onFallbackSave);

    // Pre-sync typing: the CRDT cannot be persisted by anyone yet.
    act(() => { h.result.current.setTitleFromInput('Draft'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(onFallbackSave).toHaveBeenCalledWith('Draft');

    // Once the session is up, the server persists from the CRDT and a REST write
    // would overwrite the other writer — so the fallback must not fire again.
    onFallbackSave.mockClear();
    act(() => { h.result.current.markSynced(); });
    act(() => { h.result.current.setTitleFromInput('Draft two'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onFallbackSave).not.toHaveBeenCalled();
    expect(titleOf(doc)).toBe('Draft two');
    vi.useRealTimers();
  });

  it('does not fire the REST fallback if the session comes up before it flushes', async () => {
    vi.useFakeTimers();
    const onFallbackSave = vi.fn();
    const doc = new Y.Doc();
    const h = mountTitle(doc, 'Untitled', onFallbackSave);

    act(() => { h.result.current.setTitleFromInput('Draft'); });
    act(() => { h.result.current.markSynced() });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(onFallbackSave).not.toHaveBeenCalled();
    // The value typed before the session came up is carried into the CRDT, not lost.
    expect(titleOf(doc)).toBe('Draft');
    vi.useRealTimers();
  });

  it('saves during unbroken typing, instead of waiting for a pause that never comes', async () => {
    // The fallback debounce is cleared on every keystroke. Without a ceiling, a user who
    // types steadily with no 1.5 s gap never triggers a save at all: every timer is
    // cancelled before it fires, and the whole session lives only in React state until
    // something flushes it. This is the path taken whenever the collaboration handshake is
    // slow, which is exactly when a crash or reload is most likely.
    vi.useFakeTimers();
    const onFallbackSave = vi.fn();
    const doc = new Y.Doc();
    const h = mountTitle(doc, 'Untitled', onFallbackSave);

    // 20 keystrokes, 500 ms apart — never quiet for the 1500 ms debounce.
    let typed = '';
    for (let i = 0; i < 20; i++) {
      typed += 'q';
      const next = typed;
      act(() => { h.result.current.setTitleFromInput(next); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }

    expect(
      onFallbackSave,
      'nothing was saved during 10 s of unbroken typing — the run would be lost'
    ).toHaveBeenCalled();

    // And it happened within the ceiling, not merely at some point before the end.
    expect(onFallbackSave.mock.calls[0]?.[0].length).toBeLessThanOrEqual(6);

    vi.useRealTimers();
  });

  describe('markCacheLoaded — durable typing before the WebSocket connects', () => {
    it('a cache-restored title was already durable, and stays that way', async () => {
      // Characterisation, not a regression guard: the observer already adopts a non-empty
      // ytitle on mount, so this case never waited for the socket. Kept so that a future
      // change to that observer cannot quietly take it away.
      vi.useFakeTimers();
      const onFallbackSave = vi.fn();
      const doc = new Y.Doc();
      seedTitle(doc, 'Q3 Roadmap');

      const h = mountTitle(doc, 'Q3 Roadmap', onFallbackSave);
      act(() => { h.result.current.markCacheLoaded(); });

      act(() => { h.result.current.setTitleFromInput('Q3 Roadmap v2'); });

      expect(titleOf(doc)).toBe('Q3 Roadmap v2');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onFallbackSave, 'the CRDT owns the field; REST must stand down').not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('puts a brand-new document on the durable path without waiting for the socket', async () => {
      // The case markCacheLoaded exists for, and the one the E2E durability test hits.
      // An empty ytitle is ambiguous, so the observer above cannot adopt it; before this,
      // a new "Untitled" document waited for the WebSocket and everything typed during the
      // handshake sat in React state. initialTitle === 'Untitled' comes from the REST
      // fetch and means the server has no title, so there is nothing to collide with and
      // the write is safe immediately. Straight into the Y.Doc means IndexeddbPersistence
      // flushes it per keystroke: no timer, no network.
      vi.useFakeTimers();
      const onFallbackSave = vi.fn();
      const doc = new Y.Doc();
      const h = mountTitle(doc, 'Untitled', onFallbackSave);

      act(() => { h.result.current.markCacheLoaded(); });
      act(() => { h.result.current.setTitleFromInput('Fresh doc'); });

      expect(titleOf(doc)).toBe('Fresh doc');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onFallbackSave).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('keeps waiting for the socket when there is a server title but no cache', async () => {
      // This is the case the gate exists for. The server holds "Q3 Roadmap", the Y.Doc is
      // empty because nothing has loaded, and Yjs cannot tell "empty because unknown" from
      // "empty because blank". Writing here would merge as an insert and produce
      // "XQ3 Roadmap". So markCacheLoaded must decline, and the REST fallback covers it.
      vi.useFakeTimers();
      const onFallbackSave = vi.fn();
      const doc = new Y.Doc();
      const h = mountTitle(doc, 'Q3 Roadmap', onFallbackSave);

      act(() => { h.result.current.markCacheLoaded(); });
      act(() => { h.result.current.setTitleFromInput('X'); });

      expect(titleOf(doc), 'must not write into a document whose title is unknown').toBe('');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onFallbackSave, 'the bounded REST fallback still covers this case').toHaveBeenCalled();

      // And when the socket does land, the server's title wins — no concatenation.
      seedTitle(doc, 'Q3 Roadmap');
      act(() => { h.result.current.markSynced(); });
      expect(titleOf(doc)).toBe('Q3 Roadmap');
      vi.useRealTimers();
    });
  });
});

describe('applyTextDiff', () => {
  const run = (before: string, after: string) => {
    const doc = new Y.Doc();
    const t = doc.getText('t');
    if (before) t.insert(0, before);
    applyTextDiff(t, after);
    return t.toString();
  };

  it.each([
    ['', 'abc'],
    ['abc', ''],
    ['abc', 'abcd'],
    ['abc', 'xabc'],
    ['abc', 'axbc'],
    ['abcdef', 'abef'],
    ['abc', 'abc'],
    ['aaa', 'aa'],
    ['Report', 'Report Report'],
  ])('turns %o into %o', (before, after) => {
    expect(run(before, after)).toBe(after);
  });

  it('writes only the characters that changed, not the whole value', () => {
    // The pre-fix behaviour was equivalent to replacing the entire value, which is
    // what stopped two writers from merging. Assert the minimal edit directly.
    const doc = new Y.Doc();
    const t = doc.getText('t');
    t.insert(0, 'Concurrent Edit Test');

    const deltas: unknown[] = [];
    t.observe((e) => deltas.push(e.delta));
    applyTextDiff(t, 'Concurrent Edit TestX');

    expect(deltas).toEqual([[{ retain: 20 }, { insert: 'X' }]]);
  });
});
