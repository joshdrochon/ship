import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { BelongsTo, BelongsToType } from '@ship/shared';

interface AssociationOption {
  id: string;
  name: string;
  color?: string;
  href?: string;
}

interface MultiAssociationChipsProps {
  /** Current associations of this type */
  associations: BelongsTo[];
  /** Available options to choose from */
  options: AssociationOption[];
  /** Relationship type for this set of associations */
  type: BelongsToType;
  /** Called when an association is added */
  onAdd: (id: string, type: BelongsToType) => Promise<void>;
  /** Called when an association is removed */
  onRemove: (id: string, type: BelongsToType) => Promise<void>;
  /** Placeholder text for the dropdown */
  placeholder?: string;
  /** Label for accessibility */
  'aria-label'?: string;
  /** Disable adding/removing */
  disabled?: boolean;
}

export function MultiAssociationChips({
  associations,
  options,
  type,
  onAdd,
  onRemove,
  placeholder = 'Add...',
  'aria-label': ariaLabel,
  disabled = false,
}: MultiAssociationChipsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get IDs of current associations of this type
  const currentIds = new Set(
    associations.filter(a => a.type === type).map(a => a.id)
  );

  // Filter options: not already associated, matches search
  const availableOptions = options.filter(opt =>
    !currentIds.has(opt.id) &&
    opt.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleAdd = async (id: string) => {
    setLoading(true);
    try {
      await onAdd(id, type);
      setSearch('');
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (id: string) => {
    setLoading(true);
    try {
      await onRemove(id, type);
    } finally {
      setLoading(false);
    }
  };

  // Get display info for current associations
  const currentAssociations = associations
    .filter(a => a.type === type)
    .map(a => {
      const option = options.find(o => o.id === a.id);
      return {
        id: a.id,
        name: option?.name || a.title || 'Unknown',
        color: option?.color || a.color,
        href: option?.href,
      };
    });

  return (
    <div ref={containerRef} className="relative">
      {/* Current associations as chips */}
      <div className="flex flex-wrap gap-1 mb-1">
        {currentAssociations.map(assoc => (
          <span
            key={assoc.id}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
            style={{
              backgroundColor: assoc.color ? `${assoc.color}20` : 'var(--color-border)',
              color: assoc.color || 'var(--color-foreground)',
              border: `1px solid ${assoc.color || 'var(--color-border)'}`,
            }}
          >
            {assoc.color && (
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: assoc.color }}
              />
            )}
            {assoc.href ? (
              <Link
                to={assoc.href}
                className="truncate max-w-[120px] hover:underline"
                title={`Go to ${assoc.name}`}
              >
                {assoc.name}
              </Link>
            ) : (
              <span className="truncate max-w-[120px]">{assoc.name}</span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => handleRemove(assoc.id)}
                disabled={loading}
                className="ml-0.5 rounded-full hover:bg-white/20 p-0.5 transition-colors"
                aria-label={`Remove ${assoc.name}`}
              >
                <svg aria-hidden="true" focusable="false" className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </span>
        ))}
      </div>

      {/* Add button / dropdown */}
      {!disabled && (
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setIsOpen(!isOpen);
              if (!isOpen) {
                setTimeout(() => inputRef.current?.focus(), 0);
              }
            }}
            className="w-full text-left rounded bg-border px-2 py-1 text-sm text-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
            aria-label={ariaLabel}
          >
            {placeholder}
          </button>

          {isOpen && (
            <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-background shadow-lg">
              {/* Search input */}
              <div className="p-2 border-b border-border">
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..."
                  className="w-full rounded bg-border px-2 py-1 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {/* Options list */}
              <div className="max-h-48 overflow-y-auto py-1">
                {availableOptions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted">
                    {options.length === currentIds.size
                      ? 'All options selected'
                      : 'No matching options'}
                  </div>
                ) : (
                  availableOptions.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleAdd(opt.id)}
                      disabled={loading}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-border/50 focus:bg-border/50 focus:outline-none transition-colors flex items-center gap-2"
                    >
                      {opt.color && (
                        <span
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: opt.color }}
                        />
                      )}
                      <span className="truncate">{opt.name}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
