/**
 * Regression tests for Category 7 finding F16 — the two Critical/Serious axe
 * violations that lane 7 left open after Phase 2.
 *
 * Implementation Rule 3 (brief p.8) requires "a corresponding regression test that would
 * have caught it". Both assertions below fail on the pre-fix tree (the state recorded in
 * `docs/audit/raw/cat7-phase2-after.json`: 9 serious `color-contrast` nodes on `/my-week`
 * and 1 critical `aria-allowed-attr` node on the weekly plan document).
 *
 * Kept in its own file rather than appended to `a11y-invariants.test.ts` so the two sets
 * of invariants stay separable in git history (Rule 11).
 *
 * Why source-level and not runtime: the same reason `a11y-invariants.test.ts` gives. The
 * repo's e2e axe suite runs against a fixture small enough that the offending markup does
 * not always render, and `/my-week`'s future-day rows only exist on certain weekdays —
 * scan a Monday and all five slots are future, scan a Sunday and none are. A source
 * invariant has no calendar or data-volume threshold to fall under.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** WCAG 2.1 relative luminance. https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** What a colour actually paints as when an ancestor carries `opacity: <alpha>`. */
function composite(fg: string, bg: string, alpha: number): string {
  const parse = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
  const [f, b] = [parse(fg), parse(bg)];
  return `#${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

describe('F16 — container-level opacity must not de-emphasise text', () => {
  /**
   * The mechanism, stated as an executable fact rather than a comment. `text-muted`
   * (#9e9e9e) clears AA comfortably on the #0d0d0d page background. Put `opacity-40` on
   * an *ancestor* and the browser composites the whole subtree: the same token paints as
   * #474747 and measures 2.09:1 — which is exactly the ratio axe reported for all nine
   * nodes. Nothing is wrong with the palette, so a palette-level test cannot catch this.
   */
  it('opacity-40 on a container drops muted text below AA, at the ratio axe measured', () => {
    const composited = composite('#9e9e9e', '#0d0d0d', 0.4);
    expect(composited).toBe('#474747');
    expect(Number(contrast(composited, '#0d0d0d').toFixed(2))).toBe(2.09);
    // Same token, no ancestor opacity: passes.
    expect(contrast('#9e9e9e', '#0d0d0d')).toBeGreaterThanOrEqual(4.5);
  });

  it('MyWeekPage de-emphasises future daily-update rows through chrome, not opacity', () => {
    const src = readFileSync(join(WEB_SRC, 'pages', 'MyWeekPage.tsx'), 'utf8');

    // The row class builder for the Daily Updates list. Anchored on `rowClass` so the
    // test tracks the construct rather than a line number.
    const start = src.indexOf('const rowClass = cn(');
    expect(start, 'MyWeekPage.tsx no longer builds a `rowClass` — update this test').toBeGreaterThan(-1);
    const rowClass = src.slice(start, src.indexOf(');', start));

    // `disabled:opacity-50` elsewhere in the file is fine: a disabled control is inert and
    // is exempt from contrast under WCAG 1.4.3. An unprefixed opacity utility on this row
    // is not — it dims every label inside it.
    const bareOpacity = rowClass.match(/(?<![\w:-])opacity-\d+/g) ?? [];
    expect(bareOpacity, 'future-day rows must not be dimmed with a container opacity utility').toEqual([]);

    // ...and the de-emphasis it was replaced with has to still be there, or this becomes
    // a test that passes by deleting the feature.
    expect(rowClass).toMatch(/isFuture &&\s*'[^']*\bborder-border\/\d+/);
  });
});

describe('F16 — no ARIA attribute on a role that forbids it', () => {
  /**
   * TipTap's BubbleMenu plugin creates its tippy with `interactive: true` and uses the
   * EditorContent wrapper `<div>` as the tippy *reference*. tippy's `aria.expanded`
   * default is 'auto', which resolves to `interactive` — so it stamped
   * `aria-expanded="false"` onto a roleless div, an `aria-allowed-attr` critical.
   *
   * The bubble menu is opened by selecting text, not by operating a disclosure control,
   * so the attribute is simply wrong there and is suppressed at the source.
   */
  it('Editor.tsx suppresses tippy aria-expanded on the BubbleMenu reference', () => {
    const src = readFileSync(join(WEB_SRC, 'components', 'Editor.tsx'), 'utf8');
    const start = src.indexOf('tippyOptions={{');
    expect(start, 'Editor.tsx no longer passes tippyOptions — update this test').toBeGreaterThan(-1);
    const opts = src.slice(start, src.indexOf('}}', start) + 2);
    expect(opts).toMatch(/aria:\s*\{[^}]*expanded:\s*false/);
  });
});
