import type * as Y from 'yjs';

/**
 * Apply the change between `ytext`'s current value and `next` as a minimal
 * insert/delete pair on the shared type, instead of replacing the whole value.
 *
 * Why this exists: a controlled `<input>`/`<textarea>` only ever hands you the
 * whole new string. Writing that whole string into a CRDT (delete-all +
 * insert-all) makes every keystroke a full overwrite, so two writers cannot
 * merge — whoever writes last wins and the other's characters are gone. That is
 * W6-9. Diffing to the single contiguous span that actually changed gives Yjs
 * per-character intent, which is what lets it merge two concurrent writers.
 *
 * A controlled text field produces exactly one contiguous edit per change event
 * (typing, deleting, paste, replace-selection), so a common-prefix /
 * common-suffix diff is exact for this input — no general diff algorithm needed.
 */
export function applyTextDiff(ytext: Y.Text, next: string, origin?: unknown): void {
  const prev = ytext.toString();
  if (prev === next) return;

  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;

  let end = 0;
  while (
    end < max - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }

  const removed = prev.length - end - start;
  const inserted = next.slice(start, next.length - end);

  const write = () => {
    if (removed > 0) ytext.delete(start, removed);
    if (inserted.length > 0) ytext.insert(start, inserted);
  };

  // One transaction so remote peers see the edit atomically and the origin tag
  // survives, which is how observers tell local edits from remote ones.
  if (ytext.doc) ytext.doc.transact(write, origin);
  else write();
}
