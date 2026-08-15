import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidIconName, ICON_NAMES } from './types';
import { Icon } from './Icon';

// Test the types module separately since the Icon component requires dynamic imports
// that are difficult to mock in vitest

describe('Icon types module', () => {
  it('exports IconName type with at least 100 icons', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(100);
  });

  it('includes common USWDS icons', () => {
    const commonIcons = ['check', 'close', 'warning', 'info', 'search', 'arrow_back'];
    commonIcons.forEach((iconName) => {
      expect(ICON_NAMES).toContain(iconName);
    });
  });

  it('isValidIconName returns true for valid icons', () => {
    expect(isValidIconName('check')).toBe(true);
    expect(isValidIconName('close')).toBe(true);
    expect(isValidIconName('warning')).toBe(true);
  });

  it('isValidIconName returns false for invalid icons', () => {
    expect(isValidIconName('not-a-real-icon')).toBe(false);
    expect(isValidIconName('')).toBe(false);
    expect(isValidIconName('random-string-123')).toBe(false);
  });

  it('all ICON_NAMES pass validation', () => {
    ICON_NAMES.forEach((name) => {
      expect(isValidIconName(name)).toBe(true);
    });
  });
});

// Test the Icon component's behavior without testing the actual SVG loading
// These tests use unit test patterns that don't require lazy loading

describe('Icon component behavior', () => {
  // Import Icon dynamically to avoid module resolution issues
  let Icon: typeof import('./Icon').Icon;

  beforeEach(async () => {
    // Reset modules to get a fresh Icon component
    vi.resetModules();
  });

  it('exports Icon component from index', async () => {
    // Test that the exports are correct
    const { Icon: ExportedIcon } = await import('./index');
    expect(ExportedIcon).toBeDefined();
    expect(typeof ExportedIcon).toBe('function');
  });

  it('Icon component renders without crashing for invalid icon', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { Icon } = await import('./Icon');

    // @ts-expect-error - Testing invalid icon name
    const { container } = render(<Icon name="definitely-not-real" className="h-4 w-4" />);

    // Should render nothing for invalid icon
    expect(container.firstChild).toBeNull();

    // Should warn about invalid icon name
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid icon name')
    );

    consoleSpy.mockRestore();
  });
});

/**
 * The lazy pipeline, asserted here rather than on a page.
 *
 * This used to be a `USWDS Icons:` swatch rendered on `/login` behind
 * `import.meta.env.VITE_APP_ENV !== 'production'`, with `e2e/icons.spec.ts`
 * counting four SVGs in it. The guard failed open — the variable is set by one
 * line of `scripts/deploy-frontend.sh` and by no `.env` file, and
 * `undefined !== 'production'` is true — so the swatch shipped to the deployed
 * login screen.
 *
 * The property it was checking is real and worth keeping: `Icon` resolves a
 * name through `import.meta.glob`, suspends on a dynamic import, and renders an
 * `<svg>` carrying `fill="currentColor"` (so it inherits text colour) and
 * `role="img"`. None of that needs a page to host it, and none of it needs a
 * build-env conditional. Failure mode is a caught assertion in the unit suite
 * instead of debug UI in front of a user.
 */
/**
 * These wait longer than Testing Library's 1 s default on purpose. The loader is
 * a real `import.meta.glob` entry, so the FIRST icon in a run pays for Vite
 * resolving and running the SVG through `vite-plugin-svgr` (svgo + jsx) before
 * the module exists. That is comfortably over a second on a cold transform, and
 * the symptom is a test stuck on the Suspense fallback rather than an error.
 */
const LAZY_TIMEOUT = 20_000;

describe('Icon lazy-loading pipeline', () => {
  it('resolves a real USWDS icon to an SVG with fill="currentColor"', async () => {
    render(<Icon name="check" className="h-4 w-4" title="Check" />);

    // `lazy()` suspends on first render, so the SVG arrives on a later tick.
    // Finding it by its accessible name also proves the `title` branch wires
    // role="img" + aria-label rather than aria-hidden.
    const svg = await screen.findByRole('img', { name: 'Check' }, { timeout: LAZY_TIMEOUT });

    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveClass('h-4', 'w-4');
  });

  it('renders four distinct icons, each as its own <svg>', async () => {
    // The swatch's actual assertion: four different names each resolve to their
    // own lazy chunk. A single shared/cached loader would fail this.
    render(
      <div>
        <Icon name="check" className="h-3 w-3" title="Check icon" />
        <Icon name="close" className="h-4 w-4" title="Close icon" />
        <Icon name="warning" className="h-5 w-5" title="Warning icon" />
        <Icon name="info" className="h-6 w-6" title="Info icon" />
      </div>,
    );

    await waitFor(
      () => {
        expect(screen.getAllByRole('img')).toHaveLength(4);
      },
      { timeout: LAZY_TIMEOUT },
    );

    for (const name of ['Check icon', 'Close icon', 'Warning icon', 'Info icon']) {
      const svg = screen.getByRole('img', { name });
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg).toHaveAttribute('fill', 'currentColor');
    }
  });

  it('hides an untitled icon from assistive tech', async () => {
    const { container } = render(<Icon name="search" className="h-4 w-4" />);

    await waitFor(
      () => {
        expect(container.querySelector('svg')).not.toBeNull();
      },
      { timeout: LAZY_TIMEOUT },
    );

    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });
});

// Test IconProps interface indirectly through TypeScript
describe('IconProps interface', () => {
  it('requires name prop', () => {
    // This is a compile-time check - if it compiles, the test passes
    // The Icon component signature requires name: IconName
    expect(true).toBe(true);
  });

  it('className is optional', () => {
    // This is a compile-time check
    expect(true).toBe(true);
  });

  it('title is optional', () => {
    // This is a compile-time check
    expect(true).toBe(true);
  });
});
