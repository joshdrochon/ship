import { cn } from '@/lib/cn';

export interface Tab {
  id: string;
  label: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  rightContent?: React.ReactNode;
}

export function TabBar({ tabs, activeTab, onTabChange, rightContent }: TabBarProps) {
  return (
    <div className="flex items-center justify-between border-b border-border px-6">
      <div className="flex" role="tablist" aria-label="Content tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            // No aria-controls: this component renders tabs, not panels. It used to point at
            // `tabpanel-${tab.id}`, and role="tabpanel" appears 0 times in web/src and no
            // element declares a matching id -- every tab referenced an element that does not
            // exist (axe aria-valid-attr-value, critical). A dangling reference is worse than
            // no reference: it tells assistive technology to look for content it will not find.
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'relative px-4 py-3 text-sm font-medium transition-colors',
              activeTab === tab.id
                ? 'text-foreground'
                : 'text-muted hover:text-foreground'
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      {rightContent && <div className="flex items-center gap-2">{rightContent}</div>}
    </div>
  );
}
