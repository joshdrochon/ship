import { useEffect, useRef, ReactNode, createContext, useContext, useState, useCallback } from 'react';
import { cn } from '@/lib/cn';

// Context for keyboard navigation
interface ContextMenuContextValue {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  registerItem: (index: number, ref: HTMLButtonElement | null, onClick: () => void, disabled?: boolean) => void;
  itemCount: number;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

export function ContextMenu({ x, y, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const itemsRef = useRef<Map<number, { ref: HTMLButtonElement | null; onClick: () => void; disabled?: boolean }>>(new Map());
  const [itemCount, setItemCount] = useState(0);

  const registerItem = useCallback((index: number, ref: HTMLButtonElement | null, onClick: () => void, disabled?: boolean) => {
    if (ref) {
      itemsRef.current.set(index, { ref, onClick, disabled });
      setItemCount(prev => Math.max(prev, index + 1));
    }
  }, []);

  // Focus management
  useEffect(() => {
    if (activeIndex >= 0) {
      const item = itemsRef.current.get(activeIndex);
      if (item?.ref && !item.disabled) {
        item.ref.focus();
      }
    }
  }, [activeIndex]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown': {
          e.preventDefault();
          // Find next non-disabled item
          let nextIndex = activeIndex + 1;
          while (nextIndex < itemCount) {
            const item = itemsRef.current.get(nextIndex);
            if (item && !item.disabled) {
              setActiveIndex(nextIndex);
              break;
            }
            nextIndex++;
          }
          // If no valid item found and we're at -1, start from 0
          if (activeIndex === -1 && nextIndex >= itemCount) {
            for (let i = 0; i < itemCount; i++) {
              const item = itemsRef.current.get(i);
              if (item && !item.disabled) {
                setActiveIndex(i);
                break;
              }
            }
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          // Find previous non-disabled item
          let prevIndex = activeIndex - 1;
          if (prevIndex < 0) prevIndex = itemCount - 1;
          while (prevIndex >= 0 && prevIndex !== activeIndex) {
            const item = itemsRef.current.get(prevIndex);
            if (item && !item.disabled) {
              setActiveIndex(prevIndex);
              break;
            }
            prevIndex--;
            if (prevIndex < 0) prevIndex = itemCount - 1;
          }
          break;
        }
        case 'Enter': {
          e.preventDefault();
          const item = itemsRef.current.get(activeIndex);
          if (item && !item.disabled) {
            item.onClick();
          }
          break;
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, activeIndex, itemCount]);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (rect.right > viewportWidth) {
        menuRef.current.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > viewportHeight) {
        menuRef.current.style.top = `${y - rect.height}px`;
      }
    }
  }, [x, y]);

  // Focus menu on mount for keyboard nav
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  return (
    <ContextMenuContext.Provider value={{ activeIndex, setActiveIndex, registerItem, itemCount }}>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Context menu"
        tabIndex={-1}
        className={cn(
          'fixed z-50 min-w-[180px] py-1',
          'bg-background border border-border rounded-lg shadow-xl',
          'animate-in fade-in zoom-in-95 duration-100',
          'outline-none'
        )}
        style={{ left: x, top: y }}
      >
        {children}
      </div>
    </ContextMenuContext.Provider>
  );
}

interface ContextMenuItemProps {
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
  index?: number;
}

let globalItemIndex = 0;

export function ContextMenuItem({ onClick, disabled, destructive, children, index: providedIndex }: ContextMenuItemProps) {
  const context = useContext(ContextMenuContext);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const indexRef = useRef(providedIndex ?? globalItemIndex++);
  const index = indexRef.current;

  // Register with parent
  useEffect(() => {
    if (context) {
      context.registerItem(index, buttonRef.current, onClick, disabled);
    }
    return () => {
      // Reset global index when component unmounts (menu closes)
      globalItemIndex = 0;
    };
  }, [context, index, onClick, disabled]);

  const isActive = context?.activeIndex === index;

  return (
    <button
      ref={buttonRef}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      tabIndex={isActive ? 0 : -1}
      onMouseEnter={() => context?.setActiveIndex(index)}
      className={cn(
        'w-full px-3 py-2 text-left text-sm',
        'flex items-center gap-2',
        'hover:bg-border/50 transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'outline-none focus:bg-border/50',
        destructive ? 'text-red-400 hover:text-red-300' : 'text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

interface ContextMenuSubmenuProps {
  label: string;
  children: ReactNode;
}

export function ContextMenuSubmenu({ label, children }: ContextMenuSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const context = useContext(ContextMenuContext);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const indexRef = useRef(globalItemIndex++);
  const index = indexRef.current;

  // Register with parent
  useEffect(() => {
    if (context) {
      // Submenu trigger doesn't have a direct onClick, but registers for keyboard nav
      context.registerItem(index, buttonRef.current, () => setIsOpen(true), false);
    }
  }, [context, index]);

  const isActive = context?.activeIndex === index;

  // Handle keyboard navigation for submenu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isActive && (e.key === 'ArrowRight' || e.key === 'Enter')) {
        e.preventDefault();
        setIsOpen(true);
      }
      if (isOpen && e.key === 'ArrowLeft') {
        e.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isOpen]);

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        context?.setActiveIndex(index);
        setIsOpen(true);
      }}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        ref={buttonRef}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
        tabIndex={isActive ? 0 : -1}
        className={cn(
          'w-full px-3 py-2 text-left text-sm',
          'flex items-center justify-between gap-2',
          'hover:bg-border/50 transition-colors text-foreground',
          'outline-none focus:bg-border/50'
        )}
      >
        {label}
        <ChevronRightIcon className="h-4 w-4 text-muted" />
      </button>
      {isOpen && (
        <div
          role="menu"
          className={cn(
            'absolute left-full top-0 ml-1 min-w-[160px] py-1',
            'bg-background border border-border rounded-lg shadow-xl',
            'animate-in fade-in zoom-in-95 duration-100'
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
