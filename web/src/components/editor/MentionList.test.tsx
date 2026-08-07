import { describe, it, expect, vi } from 'vitest';
import { createRef, type RefObject } from 'react';
import { render, act } from '@testing-library/react';
import { MentionList, MentionItem } from './MentionList';

/**
 * These cover one thing: which keys the suggestion popup claims to have handled.
 *
 * TipTap's suggestion plugin treats a `true` return as "consumed" and stops there, so
 * anything this component claims never reaches ProseMirror. When the query matched
 * nothing the component claimed Enter and both arrows anyway, and `selectItem` already
 * ignored the empty list — so the keystroke vanished with no visible cause. With
 * `allowSpaces: true` the query does not end at a space, so a single `@` mid-sentence
 * left the popup open and swallowed every Enter for the rest of the line.
 *
 * e2e/drag-handle.spec.ts "drag preserves full paragraph content" catches this end to
 * end, but only because its fixture text happens to contain `@#$%`. These assertions
 * name the behaviour directly and run in milliseconds.
 */

interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const ITEMS: MentionItem[] = [
  { id: 'p1', label: 'Ada Lovelace', type: 'person' },
  { id: 'd1', label: 'Design Notes', type: 'document', documentType: 'wiki' },
];

function mount(items: MentionItem[]) {
  const ref = createRef<MentionListRef>();
  const command = vi.fn();
  render(<MentionList ref={ref} items={items} command={command} query="" />);
  return { ref, command };
}

// Checked rather than asserted with `!`. A missing handle means `useImperativeHandle`
// never ran, which is a different failure from "the key was handled wrongly" and
// deserves to say so — and `check-type-violations.sh` counts every `!` against a
// whole-repo ceiling, so the assertion would not have been free either way.
function press(ref: RefObject<MentionListRef | null>, key: string): boolean {
  const handle = ref.current;
  if (!handle) {
    throw new Error('MentionList never attached its imperative handle');
  }
  return handle.onKeyDown({ event: new KeyboardEvent('keydown', { key }) });
}

describe('MentionList key handling', () => {
  describe('with no matching items', () => {
    it('lets Enter through to the editor', () => {
      const { ref, command } = mount([]);
      expect(press(ref, 'Enter')).toBe(false);
      expect(command).not.toHaveBeenCalled();
    });

    it.each(['ArrowUp', 'ArrowDown'])('lets %s through to the editor', (key) => {
      const { ref } = mount([]);
      expect(press(ref, key)).toBe(false);
    });

    it('renders the empty state rather than a list', () => {
      const { container } = render(
        <MentionList items={[]} command={vi.fn()} query="nobody" />
      );
      expect(container.textContent).toContain('No results found');
    });
  });

  describe('with matching items', () => {
    it('claims Enter and selects the highlighted item', () => {
      const { ref, command } = mount(ITEMS);
      expect(press(ref, 'Enter')).toBe(true);
      expect(command).toHaveBeenCalledWith(ITEMS[0]);
    });

    it.each(['ArrowUp', 'ArrowDown'])('claims %s', (key) => {
      const { ref } = mount(ITEMS);
      expect(press(ref, key)).toBe(true);
    });

    it('moves the selection before Enter picks it', () => {
      const { ref, command } = mount(ITEMS);
      // The arrow sets React state, and the handle Enter reads is rebuilt on the next
      // render — so the update has to flush between the two keys or Enter still sees
      // index 0. Real keystrokes arrive in separate tasks and get that for free.
      act(() => {
        press(ref, 'ArrowDown');
      });
      press(ref, 'Enter');
      expect(command).toHaveBeenCalledWith(ITEMS[1]);
    });

    it('leaves every other key to the editor', () => {
      const { ref } = mount(ITEMS);
      expect(press(ref, 'a')).toBe(false);
      expect(press(ref, 'Escape')).toBe(false);
    });
  });
});
