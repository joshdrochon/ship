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
