function formatBannerMessage(itemCount: number, urgency: 'overdue' | 'due_today'): string {
  if (urgency === 'overdue') {
    return itemCount === 1
      ? '1 overdue accountability item needs attention.'
      : `${itemCount} overdue accountability items need attention.`;
  }

  return itemCount === 1
    ? '1 accountability item is due today.'
    : `${itemCount} accountability items are due today.`;
}

interface AccountabilityBannerProps {
  itemCount: number;
  onBannerClick: () => void;
  isCelebrating?: boolean;
  urgency?: 'overdue' | 'due_today';
}

export function AccountabilityBanner({ itemCount, onBannerClick, isCelebrating = false, urgency = 'overdue' }: AccountabilityBannerProps) {
  // During celebration, show even if count is 0.
  if (itemCount === 0 && !isCelebrating) {
    return null;
  }

  // Celebration mode: green background, checkmark, success message.
  if (isCelebrating) {
    return (
      <div
        className="flex w-full items-center justify-center gap-3 bg-green-600 px-4 py-2 text-white transition-all duration-500"
        aria-live="polite"
      >
        <span className="text-lg" role="img" aria-label="celebration">
          🎉
        </span>
        <span className="text-sm font-medium">
          Accountability item completed. Nice work.
        </span>
        <svg aria-hidden="true" focusable="false" className="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }

  const bgColor = urgency === 'due_today' ? 'bg-amber-700' : 'bg-red-600';
  const hoverColor = urgency === 'due_today' ? 'hover:bg-amber-800' : 'hover:bg-red-700';
  const badgeColor = urgency === 'due_today' ? 'bg-amber-900' : 'bg-red-800';

  return (
    <button
      onClick={onBannerClick}
      className={`flex w-full items-center justify-center gap-3 ${bgColor} px-4 py-2 text-white ${hoverColor} transition-colors cursor-pointer`}
      aria-live="polite"
    >
      <svg aria-hidden="true" focusable="false" className="h-5 w-5 flex-shrink-0 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <span className="text-sm font-medium">
        {formatBannerMessage(itemCount, urgency)}
      </span>
      <span className={`flex h-6 min-w-6 items-center justify-center rounded-full ${badgeColor} px-2 text-xs font-bold`}>
        {itemCount}
      </span>
      <span className="text-xs hidden sm:inline">View items</span>
    </button>
  );
}

export default AccountabilityBanner;
