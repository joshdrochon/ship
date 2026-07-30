import { cn } from '@/lib/cn';

export interface WeekProgressGraphProps {
  startDate: string;
  endDate: string;
  scopeHours: number;
  completedHours: number;
  status: 'planning' | 'active' | 'completed';
}

/**
 * Sprint Progress Graph (burndown chart)
 * Displays a visual representation of sprint progress over time.
 */
export function WeekProgressGraph({
  startDate,
  endDate,
  scopeHours,
  completedHours,
  status,
}: WeekProgressGraphProps) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const now = Date.now();

  const current = Math.min(Math.max(now, start), end);
  const totalDuration = end - start;
  const elapsed = current - start;
  const progressPercent = totalDuration > 0 ? (elapsed / totalDuration) * 100 : 0;

  const targetHoursAtNow = (progressPercent / 100) * scopeHours;
  const isOnTrack = completedHours >= targetHoursAtNow * 0.8;

  // SVG dimensions (smaller for sidebar)
  const width = 260;
  const height = 140;
  const padding = { top: 20, right: 30, bottom: 30, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const yScale = (hours: number) =>
    padding.top + chartHeight - (hours / scopeHours) * chartHeight;

  const xScale = (percent: number) =>
    padding.left + (percent / 100) * chartWidth;

  const formatDate = (dateString: string): string =>
    new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const statusColor = {
    planning: '#9CA3AF',
    active: '#3B82F6',
    completed: '#22C55E',
  }[status];

  // Spoken description of the chart below. The header states the hours and the on-track
  // flag, but the start and end dates are drawn as <text> on the axis and appear nowhere
  // else, so they have to be in here.
  const trackSuffix = status === 'active' ? (isOnTrack ? ', on track' : ', behind') : '';
  const chartLabel =
    `Burndown chart, ${formatDate(startDate)} to ${formatDate(endDate)}: ` +
    `${completedHours} of ${scopeHours} hours complete${trackSuffix}.`;

  return (
    <div className="rounded-lg border border-border bg-border/20 p-3">
      <div className="flex items-center justify-between mb-2 text-xs">
        <span className="text-muted">
          {completedHours}h / {scopeHours}h
        </span>
        {status === 'active' && (
          <span className={cn('font-medium', isOnTrack ? 'text-green-500' : 'text-orange-500')}>
            {isOnTrack ? 'On Track' : 'Behind'}
          </span>
        )}
      </div>

      {/*
        A chart is content, not an icon. The decorative-icon sweep (ef29e8b) hid every
        inline SVG in web/src, on the reasoning that each one sits inside a control that
        already carries a name — true for icons, wrong here. The header above states the
        hours and the on-track flag, but the start and end dates exist only as text nodes
        drawn on this axis, so hiding the whole graph removed them from the page.

        role="img" with a summarising label, rather than simply un-hiding it: the raw
        axis labels read as a bare sequence of numbers in visual order, which is not a
        description of a burndown chart.

        (Deliberately no angle-bracketed tag names in this comment — the invariant in
        a11y-invariants.test.ts scans source text, so prose that quotes markup is
        indistinguishable from markup.)
      */}
      <svg
        role="img"
        aria-label={chartLabel}
        width={width}
        height={height}
        className="text-muted"
      >
        {/* Grid lines */}
        <g className="stroke-border">
          {[0, 50, 100].map((percent) => (
            <line
              key={percent}
              x1={xScale(percent)}
              y1={padding.top}
              x2={xScale(percent)}
              y2={padding.top + chartHeight}
              strokeDasharray="2,2"
              strokeWidth={0.5}
            />
          ))}
          {[0, 50, 100].map((percent) => (
            <line
              key={`h-${percent}`}
              x1={padding.left}
              y1={yScale((percent / 100) * scopeHours)}
              x2={padding.left + chartWidth}
              y2={yScale((percent / 100) * scopeHours)}
              strokeDasharray="2,2"
              strokeWidth={0.5}
            />
          ))}
        </g>

        {/* Scope line */}
        <line
          x1={xScale(0)}
          y1={yScale(scopeHours)}
          x2={xScale(100)}
          y2={yScale(scopeHours)}
          stroke="#6B7280"
          strokeWidth={2}
        />

        {/* Target pace line */}
        <line
          x1={xScale(0)}
          y1={yScale(0)}
          x2={xScale(100)}
          y2={yScale(scopeHours)}
          stroke={statusColor}
          strokeWidth={1.5}
          strokeDasharray="4,4"
        />

        {/* Completed hours line */}
        <line
          x1={xScale(0)}
          y1={yScale(0)}
          x2={xScale(progressPercent)}
          y2={yScale(completedHours)}
          stroke="#8B5CF6"
          strokeWidth={2.5}
        />

        {/* Current position marker */}
        {status === 'active' && (
          <g>
            <circle
              cx={xScale(progressPercent)}
              cy={yScale(completedHours)}
              r={4}
              fill="#8B5CF6"
            />
            <line
              x1={xScale(progressPercent)}
              y1={padding.top}
              x2={xScale(progressPercent)}
              y2={padding.top + chartHeight}
              stroke={statusColor}
              strokeWidth={1}
              strokeDasharray="2,2"
            />
          </g>
        )}

        {/* X-axis labels */}
        <text x={xScale(0)} y={height - 8} fontSize={9} textAnchor="start" fill="currentColor">
          {formatDate(startDate)}
        </text>
        <text x={xScale(100)} y={height - 8} fontSize={9} textAnchor="end" fill="currentColor">
          {formatDate(endDate)}
        </text>

        {/* Y-axis labels */}
        <text x={padding.left - 6} y={yScale(0)} fontSize={9} textAnchor="end" dominantBaseline="middle" fill="currentColor">
          0
        </text>
        <text x={padding.left - 6} y={yScale(scopeHours)} fontSize={9} textAnchor="end" dominantBaseline="middle" fill="currentColor">
          {scopeHours}h
        </text>
      </svg>
    </div>
  );
}
