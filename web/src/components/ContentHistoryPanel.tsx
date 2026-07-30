import { useState } from 'react';
import { useContentHistoryQuery, type ContentHistoryEntry } from '@/hooks/useContentHistoryQuery';

// Simple SVG icons
const ChevronDownIcon = () => (
  <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
  </svg>
);

const ClockIcon = () => (
  <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
  </svg>
);

const UserIcon = () => (
  <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
    <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
  </svg>
);

// Format date as relative time (e.g., "2 hours ago")
function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return diffDay === 1 ? '1 day ago' : `${diffDay} days ago`;
  }
  if (diffHour > 0) {
    return diffHour === 1 ? '1 hour ago' : `${diffHour} hours ago`;
  }
  if (diffMin > 0) {
    return diffMin === 1 ? '1 minute ago' : `${diffMin} minutes ago`;
  }
  return 'just now';
}

interface ContentHistoryPanelProps {
  documentId: string;
  documentType: 'weekly_plan' | 'weekly_retro';
}

/**
 * Panel to display content version history for weekly plan and retro documents.
 * Shows a collapsible list of versions with timestamps and authors.
 */
export function ContentHistoryPanel({
  documentId,
  documentType,
}: ContentHistoryPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<ContentHistoryEntry | null>(null);

  const { data: history, isLoading, error } = useContentHistoryQuery(documentId, documentType);

  if (error) {
    return null; // Silently fail if history not available
  }

  const historyCount = history?.length ?? 0;

  return (
    <div className="border-t border-neutral-200 pt-4 mt-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full text-left text-sm font-medium text-neutral-700 hover:text-neutral-900"
      >
        {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <ClockIcon />
        <span>Version History</span>
        {!isLoading && historyCount > 0 && (
          <span className="text-xs text-neutral-500">({historyCount})</span>
        )}
      </button>

      {isExpanded && (
        <div className="mt-3 space-y-2">
          {isLoading && (
            <div className="text-sm text-neutral-500 italic">Loading history...</div>
          )}

          {!isLoading && historyCount === 0 && (
            <div className="text-sm text-neutral-500 italic">
              No version history yet. Changes will be tracked as you edit.
            </div>
          )}

          {!isLoading && history && history.length > 0 && (
            <div className="space-y-1">
              {history.map((entry) => (
                <HistoryEntry
                  key={entry.id}
                  entry={entry}
                  isSelected={selectedVersion?.id === entry.id}
                  onSelect={() =>
                    setSelectedVersion(
                      selectedVersion?.id === entry.id ? null : entry
                    )
                  }
                />
              ))}
            </div>
          )}

          {selectedVersion && (
            <ContentDiff
              entry={selectedVersion}
              onClose={() => setSelectedVersion(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface HistoryEntryProps {
  entry: ContentHistoryEntry;
  isSelected: boolean;
  onSelect: () => void;
}

function HistoryEntry({ entry, isSelected, onSelect }: HistoryEntryProps) {
  const timeAgo = formatTimeAgo(entry.created_at);

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-2 rounded text-xs transition-colors ${
        isSelected
          ? 'bg-accent-100 border border-accent-300'
          : 'bg-neutral-50 hover:bg-neutral-100 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-neutral-400"><ClockIcon /></span>
        <span className="text-neutral-700">{timeAgo}</span>
      </div>
      {entry.changed_by && (
        <div className="flex items-center gap-2 mt-1">
          <UserIcon />
          <span className="text-neutral-500">{entry.changed_by.name}</span>
        </div>
      )}
    </button>
  );
}

interface ContentDiffProps {
  entry: ContentHistoryEntry;
  onClose: () => void;
}

function ContentDiff({ entry, onClose }: ContentDiffProps) {
  // Extract plain text from TipTap content for display
  const extractText = (content: unknown): string => {
    if (!content) return '(empty)';
    if (typeof content === 'string') return content;

    const texts: string[] = [];

    function traverse(node: unknown) {
      if (typeof node !== 'object' || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.type === 'text' && typeof n.text === 'string') {
        texts.push(n.text);
      }
      if (n.content && Array.isArray(n.content)) {
        for (const child of n.content) {
          traverse(child);
        }
      }
    }

    traverse(content);
    return texts.join(' ') || '(empty)';
  };

  const oldText = extractText(entry.old_content);
  const newText = extractText(entry.new_content);

  return (
    <div className="mt-3 p-3 bg-neutral-50 rounded-lg border border-neutral-200">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-neutral-700">Content Change</span>
        <button
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-700"
        >
          Close
        </button>
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-xs font-medium text-red-600 mb-1">Previous:</div>
          <div className="text-xs text-neutral-600 bg-red-50 p-2 rounded max-h-24 overflow-y-auto">
            {oldText}
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-green-600 mb-1">New:</div>
          <div className="text-xs text-neutral-600 bg-green-50 p-2 rounded max-h-24 overflow-y-auto">
            {newText}
          </div>
        </div>
      </div>
    </div>
  );
}
