import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  seedTitleIntoDoc,
  reconcileTitleOnLoad,
  readTitleFromDoc,
  replaceTitleInDoc,
  getTitleText,
} from './documentTitle.js';

/**
 * Regression tests for the server half of W6-9 — "two users editing the same
 * title: one edit is silently destroyed, every time" (audit-report.md Category 6,
 * 13 of 13 runs).
 *
 * Before the fix the title existed only on `documents.title`, written by whichever
 * debounced PATCH landed last, so there was nothing on the server that could merge
 * two writers. These tests cover the three server behaviours the CRDT title needs:
 * seed once from the column, read back what the merge produced, and let a
 * non-collaborative rename replace it.
 *
 * Pure Y.Doc operations — no database, no sockets, no network — so they are stable
 * in CI (Implementation Rule 3).
 */
describe('collaboration/documentTitle (W6-9 regression)', () => {
  describe('seedTitleIntoDoc', () => {
    it('seeds the column title into an empty CRDT', () => {
      const doc = new Y.Doc();
      expect(seedTitleIntoDoc(doc, 'Project Overview')).toBe(true);
      expect(readTitleFromDoc(doc)).toBe('Project Overview');
    });

    it('never seeds twice, so a reconnect cannot duplicate the title', () => {
      const doc = new Y.Doc();
      seedTitleIntoDoc(doc, 'Project Overview');
      expect(seedTitleIntoDoc(doc, 'Project Overview')).toBe(false);
      expect(readTitleFromDoc(doc)).toBe('Project Overview');
    });

    it('does not seed "Untitled", the new-document default rendered as a placeholder', () => {
      const doc = new Y.Doc();
      expect(seedTitleIntoDoc(doc, 'Untitled')).toBe(false);
      expect(readTitleFromDoc(doc)).toBeNull();
    });

    it.each([[null], [undefined], ['']])('does not seed %o', (value) => {
      const doc = new Y.Doc();
      expect(seedTitleIntoDoc(doc, value)).toBe(false);
      expect(readTitleFromDoc(doc)).toBeNull();
    });

    it('leaves a title that already came from yjs_state alone', () => {
      const doc = new Y.Doc();
      getTitleText(doc).insert(0, 'Live edited title');
      expect(seedTitleIntoDoc(doc, 'Stale column title')).toBe(false);
      expect(readTitleFromDoc(doc)).toBe('Live edited title');
    });
  });

  describe('reconcileTitleOnLoad', () => {
    it('seeds an empty CRDT from the column', () => {
      const doc = new Y.Doc();
      expect(reconcileTitleOnLoad(doc, 'Project Overview')).toBe('seeded');
      expect(readTitleFromDoc(doc)).toBe('Project Overview');
    });

    it('does nothing when the two already agree', () => {
      const doc = new Y.Doc();
      seedTitleIntoDoc(doc, 'Project Overview');
      expect(reconcileTitleOnLoad(doc, 'Project Overview')).toBe('agreed');
    });

    it('lets the column win when a REST rename landed after the last persist', () => {
      // Regression: the first cut of the W6-9 fix trusted yjs_state on load, so a
      // rename made while nobody had the document open was reverted by the next
      // debounced persist. The column is the only thing REST can write, so a
      // disagreement means the column is the newer value.
      const doc = new Y.Doc();
      getTitleText(doc).insert(0, 'Stale title from yjs_state');
      expect(reconcileTitleOnLoad(doc, 'Renamed over REST')).toBe('column-wins');
      expect(readTitleFromDoc(doc)).toBe('Renamed over REST');
    });

    it('never blanks a CRDT title from an "Untitled" column', () => {
      const doc = new Y.Doc();
      getTitleText(doc).insert(0, 'Typed in the editor');
      expect(reconcileTitleOnLoad(doc, 'Untitled')).toBe('kept-crdt');
      expect(readTitleFromDoc(doc)).toBe('Typed in the editor');
    });

    it('is a no-op for a brand new untitled document', () => {
      const doc = new Y.Doc();
      expect(reconcileTitleOnLoad(doc, 'Untitled')).toBe('agreed');
      expect(readTitleFromDoc(doc)).toBeNull();
    });
  });

  describe('readTitleFromDoc', () => {
    it('returns null for an empty title so the column is left as REST set it', () => {
      expect(readTitleFromDoc(new Y.Doc())).toBeNull();
    });

    it('reports the merged result of two concurrent client edits', () => {
      // This is the bug, reproduced at the level the server sees it: two clients
      // append to the same title without seeing each other, then both updates
      // arrive. Before the fix the two writes were whole-column overwrites and one
      // was lost; as a CRDT both survive.
      const server = new Y.Doc();
      seedTitleIntoDoc(server, 'Concurrent Edit Test');
      const base = Y.encodeStateAsUpdate(server);

      const clientA = new Y.Doc();
      const clientB = new Y.Doc();
      Y.applyUpdate(clientA, base);
      Y.applyUpdate(clientB, base);

      getTitleText(clientA).insert(20, 'TitleFromA');
      getTitleText(clientB).insert(20, 'TitleFromB');

      Y.applyUpdate(server, Y.encodeStateAsUpdate(clientA));
      Y.applyUpdate(server, Y.encodeStateAsUpdate(clientB));

      const merged = readTitleFromDoc(server);
      expect(merged).toContain('TitleFromA');
      expect(merged).toContain('TitleFromB');
      expect(merged).toContain('Concurrent Edit Test');

      // And the clients converge on the same string once they see each other.
      Y.applyUpdate(clientA, Y.encodeStateAsUpdate(server));
      Y.applyUpdate(clientB, Y.encodeStateAsUpdate(server));
      expect(readTitleFromDoc(clientA)).toBe(merged);
      expect(readTitleFromDoc(clientB)).toBe(merged);
    });

    it('is order independent — the same two edits merge the same way either way round', () => {
      const build = (order: 'ab' | 'ba') => {
        const server = new Y.Doc();
        seedTitleIntoDoc(server, 'Concurrent Edit Test');
        const base = Y.encodeStateAsUpdate(server);
        const a = new Y.Doc(); const b = new Y.Doc();
        Y.applyUpdate(a, base); Y.applyUpdate(b, base);
        // Fixed client ids so the tie-break is deterministic across both orders.
        (a as unknown as { clientID: number }).clientID = 1;
        (b as unknown as { clientID: number }).clientID = 2;
        getTitleText(a).insert(20, 'TitleFromA');
        getTitleText(b).insert(20, 'TitleFromB');
        const updates = order === 'ab'
          ? [Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b)]
          : [Y.encodeStateAsUpdate(b), Y.encodeStateAsUpdate(a)];
        for (const u of updates) Y.applyUpdate(server, u);
        return readTitleFromDoc(server);
      };
      expect(build('ab')).toBe(build('ba'));
    });
  });

  describe('replaceTitleInDoc', () => {
    it('replaces the CRDT title for a REST rename', () => {
      const doc = new Y.Doc();
      seedTitleIntoDoc(doc, 'Old Name');
      expect(replaceTitleInDoc(doc, 'New Name')).toBe(true);
      expect(readTitleFromDoc(doc)).toBe('New Name');
    });

    it('is a no-op when the title already matches, so it cannot loop with persist', () => {
      const doc = new Y.Doc();
      seedTitleIntoDoc(doc, 'Same Name');
      expect(replaceTitleInDoc(doc, 'Same Name')).toBe(false);
    });

    it('clears the CRDT title when renamed back to the "Untitled" default', () => {
      const doc = new Y.Doc();
      seedTitleIntoDoc(doc, 'Had A Name');
      expect(replaceTitleInDoc(doc, 'Untitled')).toBe(true);
      expect(readTitleFromDoc(doc)).toBeNull();
    });

    it('reaches connected clients as an ordinary Yjs update', () => {
      const server = new Y.Doc();
      seedTitleIntoDoc(server, 'Old Name');
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

      const relayed: Uint8Array[] = [];
      server.on('update', (u: Uint8Array) => relayed.push(u));
      replaceTitleInDoc(server, 'New Name');

      expect(relayed).toHaveLength(1);
      Y.applyUpdate(client, relayed[0]!);
      expect(readTitleFromDoc(client)).toBe('New Name');
    });
  });
});
