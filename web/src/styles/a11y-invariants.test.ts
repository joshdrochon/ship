/**
 * Regression tests for Category 7 (accessibility) findings W7-1, W7-2 and W7-13.
 *
 * Implementation Rule 3 (brief p.8) requires "a corresponding regression test that
 * would have caught it". Each test below fails on the pre-fix commit 767aa2f.
 *
 * These are source-level invariants on purpose. The equivalent runtime checks live in
 * e2e/accessibility.spec.ts, and W7-6 established why that suite could not catch these:
 * it runs axe over four pages against a fixture small enough that the offending markup
 * never renders. A source invariant has no data-volume threshold to fall under.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error tailwind.config.js is plain JS with no declaration file. Reading the
// real config is the point: a test against a copied palette would not catch a token edit.
import tailwindConfig from '../../tailwind.config.js';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      // Test files are never rendered, and this one quotes the offending patterns
      // verbatim in its own matchers.
      else if (['.ts', '.tsx'].includes(extname(p)) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
  })(WEB_SRC);
  return out;
}

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

const colors = tailwindConfig.theme.extend.colors as Record<string, string>;
const textColorOverrides = (tailwindConfig.theme.extend.textColor ?? {}) as Record<string, string>;

/**
 * What `text-<token>` actually resolves to. Tailwind's textColor scale defaults to the
 * colors scale, so an absent override means the surface colour is used as text -- which
 * is exactly the W7-1 defect, and this resolution is what makes the test fail on the
 * pre-fix commit instead of crashing on an undefined key.
 */
const asText = (token: string): string => textColorOverrides[token] ?? colors[token];

/** Every surface a text token is rendered on in this app. */
const SURFACES = {
  background: colors.background,
  border: colors.border, // raised surfaces: bg-border chips, table headers
};

describe('colour contrast tokens (W7-1, W7-2)', () => {
  it('sanity-checks the contrast maths against known WCAG pairs', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#000000', '#000000')).toBeCloseTo(1, 5);
    // The exact value the audit measured for the old accent token on the page background.
    expect(contrast('#005ea2', '#0d0d0d')).toBeCloseTo(2.89, 1);
  });

  for (const token of ['muted', 'foreground', 'accent', 'accent-hover']) {
    const value = asText(token);
    for (const [surfaceName, surface] of Object.entries(SURFACES)) {
      it(`text-${token} clears 4.5:1 on ${surfaceName}`, () => {
        expect(contrast(value, surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('keeps white legible on the accent surface, so bg-accent stays usable', () => {
    // Guards the split: lightening `accent` itself to fix text-accent would break this.
    expect(contrast('#ffffff', colors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('has no opacity-modified text colour utilities anywhere in web/src', () => {
    // text-muted/50 composites to 2.26:1. The token passing says nothing about the
    // modified utility, and nothing in the toolchain checks a composited colour.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /text-(muted|foreground|accent|border)\/\d+/g,
      )) {
        offenders.push(`${file.replace(WEB_SRC, 'web/src')}: ${m[0]}`);
      }
    }
    expect(offenders, 'use a solid token; opacity modifiers divide the contrast ratio').toEqual([]);
  });
});

describe('decorative icons are hidden from assistive technology (W7-13)', () => {
  it('every inline <svg> in web/src declares aria-hidden', () => {
    // An <svg> with no aria-hidden is its own accessibility-tree node with role "image"
    // and an empty name. Real VoiceOver announces the delete button's trash icon as
    // "image" -- an unnamed destructive control at the moment of activation.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<svg(?=[\s/>])/g)) {
        // matchAll always sets index on a successful match; bind it once so the
        // three uses below do not each need a non-null assertion.
        const start = m.index ?? 0;
        let i = start + 4;
        let depth = 0;
        let quote: string | null = null;
        while (i < src.length) {
          const c = src[i];
          if (quote) {
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'") quote = c;
          else if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '>' && depth === 0) break;
          i++;
        }
        const tag = src.slice(start, i);
        // iconProps is a shared object literal that already carries aria-hidden.
        if (!tag.includes('aria-hidden') && !tag.includes('iconProps')) {
          const line = src.slice(0, start).split('\n').length;
          offenders.push(`${file.replace(WEB_SRC, 'web/src')}:${line}`);
        }
      }
    }
    expect(offenders, 'add aria-hidden="true" focusable="false"').toEqual([]);
  });
});
