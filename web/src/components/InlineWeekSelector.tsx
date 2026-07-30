import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';

interface Sprint {
  id: string;
  name: string;
}

interface InlineWeekSelectorProps {
  /** Currently selected sprint ID */
  value: string | null;
  /** Available sprints to choose from */
  sprints: Sprint[];
  /** Callback when sprint is changed */
  onChange: (sprintId: string | null) => void;
  /** Display text when no sprint is assigned */
  placeholder?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

/**
 * InlineSprintSelector - Inline dropdown for sprint assignment in issues list
 *
 * Renders as a clickable cell that shows current sprint or placeholder.
 * On click, shows a dropdown with available sprints to select from.
 */
export function InlineWeekSelector({
  value,
  sprints,
  onChange,
  placeholder = '—',
  disabled = false,
}: InlineWeekSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find current sprint name
  const currentSprint = sprints.find(s => s.id === value);
  const displayText = currentSprint?.name || placeholder;

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen]);

  const handleSelect = (sprintId: string | null) => {
    onChange(sprintId);
    setIsOpen(false);
  };

  // Prevent row click when interacting with dropdown
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      setIsOpen(!isOpen);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          'text-left text-sm w-full px-0 py-0 rounded hover:bg-border/30 transition-colors -mx-1 px-1',
          value ? 'text-muted' : 'text-muted',
          disabled && 'cursor-not-allowed opacity-50',
          !disabled && 'cursor-pointer'
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {displayText}
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute top-full left-0 z-50 mt-1 min-w-[180px] rounded-lg border border-border',
            'bg-background shadow-lg py-1 max-h-[200px] overflow-auto',
            'animate-in fade-in slide-in-from-top-1 duration-100'
          )}
          role="listbox"
        >
          {/* No Week option */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleSelect(null);
            }}
            className={cn(
              'w-full px-3 py-1.5 text-left text-sm transition-colors',
              !value ? 'bg-accent/10 text-foreground' : 'text-muted hover:bg-border/50'
            )}
            role="option"
            aria-selected={!value}
          >
            No Week
          </button>

          {sprints.length > 0 && (
            <div className="my-1 h-px bg-border" />
          )}

          {/* Sprint options */}
          {sprints.map((sprint) => (
            <button
              key={sprint.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSelect(sprint.id);
              }}
              className={cn(
                'w-full px-3 py-1.5 text-left text-sm transition-colors',
                value === sprint.id ? 'bg-accent/10 text-foreground' : 'text-foreground hover:bg-border/50'
              )}
              role="option"
              aria-selected={value === sprint.id}
            >
              {sprint.name}
            </button>
          ))}

          {sprints.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">
              No weeks available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
