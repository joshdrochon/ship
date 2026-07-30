import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';

/**
 * PlanReferenceBlock Component
 *
 * Renders a non-editable reference to a plan item in a retro document.
 * Styled with a muted background and clipboard icon to distinguish
 * it from user-authored content.
 */
export function PlanReferenceBlockComponent({ node }: NodeViewProps) {
  const { planItemText, itemIndex } = node.attrs;

  return (
    <NodeViewWrapper
      data-type="plan-reference"
      className="plan-reference-block my-2"
      contentEditable={false}
    >
      <div className="flex items-start gap-2.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2.5">
        {/* Clipboard/plan icon */}
        <div className="flex-shrink-0 mt-0.5 text-blue-400/70">
          <svg aria-hidden="true" focusable="false" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </div>

        {/* Plan item content */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/60 mb-0.5">
            Planned #{itemIndex + 1}
          </div>
          <p className="text-sm text-foreground/80 leading-relaxed">
            {planItemText}
          </p>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
