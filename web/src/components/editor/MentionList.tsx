import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
} from 'react';
import { cn } from '@/lib/cn';

export interface MentionItem {
  id: string;
  label: string;
  type: 'person' | 'document';
  documentType?: string; // For documents: wiki, issue, project, etc.
}

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  query: string;
}

interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command, query }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) {
          command(item);
        }
      },
      [items, command]
    );

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        // Nothing matched, so this popup has no key to handle. Returning true here
        // told TipTap's suggestion plugin the key was consumed, and ProseMirror never
        // saw it: Enter did not split the block, and the arrows did not move the caret.
        // `selectItem` already guarded against the empty list, so the swallow was
        // silent — the keystroke simply vanished.
        //
        // `allowSpaces: true` (MentionExtension.ts:167) is what made this reachable in
        // ordinary use rather than only right after an `@`. The query does not end at a
        // space, so one `@` mid-sentence leaves the popup open for the rest of the line,
        // and every Enter until the caret leaves that block is dropped.
        //
        // Found by e2e/drag-handle.spec.ts "drag preserves full paragraph content",
        // whose fixture text ends in `@#$%`: the two paragraphs it types merged into
        // one, and the drag then timed out looking for a block that was never created.
        if (items.length === 0) {
          return false;
        }

        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
          return true;
        }

        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }

        if (event.key === 'Enter') {
          selectItem(selectedIndex);
          return true;
        }

        return false;
      },
    }));

    // Group items by type
    const people = items.filter((item) => item.type === 'person');
    const documents = items.filter((item) => item.type === 'document');

    // Highlight matching text in label
    const highlightMatch = (label: string) => {
      if (!query) return label;
      const index = label.toLowerCase().indexOf(query.toLowerCase());
      if (index === -1) return label;
      return (
        <>
          {label.slice(0, index)}
          <span className="bg-accent/30 text-accent-foreground">
            {label.slice(index, index + query.length)}
          </span>
          {label.slice(index + query.length)}
        </>
      );
    };

    // Get global index for an item
    const getGlobalIndex = (type: 'person' | 'document', localIndex: number) => {
      if (type === 'person') return localIndex;
      return people.length + localIndex;
    };

    if (items.length === 0) {
      return (
        <div
          className="z-50 min-w-[220px] overflow-hidden rounded-lg border border-border bg-background shadow-lg p-3"
          role="listbox"
          aria-label="Mention suggestions - no results"
        >
          <p className="text-sm text-muted">No results found</p>
        </div>
      );
    }

    return (
      <div
        className="z-50 min-w-[220px] max-h-[300px] overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
        role="listbox"
        aria-label="Mention suggestions"
      >
        {/* People section */}
        {people.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-medium text-muted uppercase tracking-wide border-b border-border/50">
              People
            </div>
            {people.map((item, index) => {
              const globalIndex = getGlobalIndex('person', index);
              return (
                <button
                  key={item.id}
                  onClick={() => selectItem(globalIndex)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                    'hover:bg-border/50 transition-colors',
                    globalIndex === selectedIndex && 'bg-border/50'
                  )}
                  role="option"
                  aria-selected={globalIndex === selectedIndex}
                >
                  <PersonIcon />
                  <span className="flex-1 truncate">{highlightMatch(item.label)}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Documents section */}
        {documents.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-medium text-muted uppercase tracking-wide border-b border-border/50">
              Documents
            </div>
            {documents.map((item, index) => {
              const globalIndex = getGlobalIndex('document', index);
              return (
                <button
                  key={item.id}
                  onClick={() => selectItem(globalIndex)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                    'hover:bg-border/50 transition-colors',
                    globalIndex === selectedIndex && 'bg-border/50'
                  )}
                  role="option"
                  aria-selected={globalIndex === selectedIndex}
                >
                  <DocumentTypeIcon type={item.documentType} />
                  <span className="flex-1 truncate">{highlightMatch(item.label)}</span>
                  {item.documentType && (
                    <span className="text-xs text-muted capitalize">
                      {item.documentType}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

MentionList.displayName = 'MentionList';

function PersonIcon() {
  return (
    <svg aria-hidden="true" focusable="false" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
      />
    </svg>
  );
}

function DocumentTypeIcon({ type }: { type?: string }) {
  // Different icons for different document types
  switch (type) {
    case 'issue':
      return (
        <svg aria-hidden="true" focusable="false" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      );
    case 'project':
      return (
        <svg aria-hidden="true" focusable="false" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      );
    case 'program':
      return (
        <svg aria-hidden="true" focusable="false" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden="true" focusable="false" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      );
  }
}
