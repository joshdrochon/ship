/**
 * PF-659 — payloads and response excerpts are collapsed by default and revealed
 * by a deliberate click.
 *
 * Pre-Search 2.5 (p.17) asks whether the portal shows payloads *"in full,
 * redacted, or behind a click-to-reveal"* and says to *"Defend the choice"*
 * against 1.4's leakage concerns (p.15). The defence, stated once here:
 *
 *   * The portal is the one screen in this system where a screenshot or a
 *     screen-share captures MANY payloads at once. A document editor leaks one
 *     document; a delivery log leaks a page of them.
 *   * `response_excerpt` is a THIRD PARTY's response body. We never controlled
 *     what a subscriber puts in it and cannot promise it holds nothing sensitive.
 *   * Redaction was rejected because it destroys the field's only purpose — an
 *     operator reads an excerpt to find out what the subscriber actually said.
 *
 * Deliberately independent of **D7** (webhook payload contents, L14 PF-408,
 * marked re-litigate). If D7 lands on ids-only the reveal costs one click and
 * harms nothing; if it keeps `title`, default-collapsed is the difference
 * between a leak and a click. The portal does not change either way.
 *
 * The value is absent from the DOM until revealed — not hidden with CSS, not
 * present with `visibility: hidden`. `portalReveal.test.tsx` asserts that,
 * because `display: none` still ships the bytes to anyone with dev tools open
 * and still lands in an accessibility-tree dump.
 */
import { useState } from 'react';

export interface RevealPanelProps {
  label: string;
  /** `null` renders the empty state and no control — there is nothing to reveal. */
  value: string | null;
  /** Shown in place of the value when `value` is null. */
  emptyText?: string;
}

export function RevealPanel({ label, value, emptyText = 'none' }: RevealPanelProps) {
  const [revealed, setRevealed] = useState(false);

  if (value === null || value === '') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <span className="text-sm text-muted">{emptyText}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-expanded={revealed}
          className="rounded border border-border px-2 py-0.5 text-xs text-muted hover:bg-border/40 hover:text-foreground transition-colors"
        >
          {revealed ? 'Hide' : 'Reveal'}
        </button>
      </div>
      {revealed ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-border/30 p-2 text-xs text-foreground">
          {value}
        </pre>
      ) : (
        <span className="text-sm text-muted">
          Hidden — {value.length} characters. Click Reveal to show.
        </span>
      )}
    </div>
  );
}
