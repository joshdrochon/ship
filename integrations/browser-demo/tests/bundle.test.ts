/**
 * PF-737 and PF-738 — the two claims that are about the BUILD rather than the
 * flow, and are therefore cheap enough to run under vitest without a browser.
 *
 * PF-738 is the reason this package is worth having twice over: it is the only
 * artifact in the repository that puts `@ship/sdk` through a real browser
 * bundler. `sdk/src/installSize.test.ts` measures the published package; that
 * is a different number and it cannot see what a bundler does with the module
 * graph — which is exactly where L99 F14 lived (`node:crypto` reachable from
 * the package barrel, and every browser consumer either failing to resolve or
 * silently polyfilling hundreds of kilobytes of crypto shim).
 *
 * L17's PF-507 fixed that with a `browser` export condition. **This file is
 * what proves the fix held**, and it will go red the day someone re-exports a
 * Node-only module from `core.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const SRC = join(PKG, 'src');
const DIST = join(PKG, 'dist');

/** PRD p.9. The budget is min+gzip, so the measurement is min+gzip. */
const BUDGET_BYTES = 250 * 1024;

/**
 * Builds with the same inputs the Playwright config uses, so the measured
 * artifact is the shipped artifact and not a differently-configured cousin.
 *
 * Built here rather than assumed present: a size assertion that silently reads
 * a stale `dist/` is a size assertion that passes after the regression.
 */
beforeAll(() => {
  execFileSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: PKG,
    stdio: 'pipe',
    env: {
      ...process.env,
      VITE_SHIP_BASE_URL: 'http://localhost:3124',
      VITE_SHIP_CLIENT_ID: 'ship_demo_browser_pkce',
      VITE_REDIRECT_URI: 'http://localhost:4173/',
      VITE_SHIP_SCOPES: 'documents:read',
    },
  });
});

function builtJs(): { file: string; source: string }[] {
  return readdirSync(join(DIST, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .map((file) => ({ file, source: readFileSync(join(DIST, 'assets', file), 'utf8') }));
}

describe('PF-737 · the demo never sees a cursor', () => {
  it('no source file under src/ mentions cursor or next_cursor', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SRC)) {
      // COMMENTS ARE STRIPPED FIRST, and that is a real distinction rather
      // than a convenience. PF-737's claim is that consumer *code* never sees
      // a cursor; prose explaining that it does not is the opposite of a
      // violation. A test that cannot tell those apart forces the codebase to
      // stop explaining itself in order to stay green, which is a bad trade.
      const code = readFileSync(join(SRC, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\bcursor\b|next_cursor/.test(code)) offenders.push(name);
    }

    // p.4: *"Cursors handled internally; consumer code never sees them."* This
    // is the consumer-side mirror of L08's PF-233, which pins the same contract
    // from the server side. If either side needs the other's internals to pass,
    // the cursor is not opaque and the claim is false.
    expect(offenders, `these files reference a cursor: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the list really is driven by the async iterator — the anti-vacuity half', () => {
    // Without this, deleting the document list entirely would pass the grep
    // above. `iterate()` is the API whose whole purpose is to hide the cursor,
    // so its presence is what makes the absence meaningful.
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    expect(main).toContain('for await (const doc of client.documents.iterate())');
  });
});

describe('PF-738 · the SDK install-footprint budget, measured against a real bundler', () => {
  it('the production bundle is under 250 KB min+gzip, and the number is published', () => {
    const files = builtJs();
    expect(files.length, 'no built JS — the build in beforeAll produced nothing').toBeGreaterThan(0);

    const rawBytes = files.reduce(
      (total, { file }) => total + statSync(join(DIST, 'assets', file)).size,
      0,
    );
    const gzipBytes = files.reduce(
      (total, { source }) => total + gzipSync(Buffer.from(source, 'utf8')).length,
      0,
    );

    // Published as a build artifact, per the ticket. A number in a passing
    // test's output is a number nobody reads; a file is one CI can attach and
    // a human can diff across commits.
    const reportDir = join(PKG, 'test-results');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'bundle-size.json'),
      JSON.stringify(
        {
          ticket: 'PF-738',
          budgetBytes: BUDGET_BYTES,
          minifiedBytes: rawBytes,
          minifiedGzipBytes: gzipBytes,
          headroomBytes: BUDGET_BYTES - gzipBytes,
          files: files.map(({ file }) => file),
          measuredAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );

    expect(
      gzipBytes,
      `browser bundle is ${gzipBytes} B min+gzip, over the ${BUDGET_BYTES} B budget (p.9)`,
    ).toBeLessThan(BUDGET_BYTES);
  });

  it('no node:crypto polyfill reached the browser bundle (L99 F14 stays closed)', () => {
    for (const { file, source } of builtJs()) {
      // Three shapes, because a bundler can fail this three ways: leaving the
      // specifier in place, resolving it to a shim package, or injecting a
      // `process`/`Buffer` global the polyfill needs.
      expect(source, `${file} still names a node: specifier`).not.toMatch(/["']node:crypto["']/);
      expect(source, `${file} pulled in a crypto polyfill`).not.toMatch(
        /crypto-browserify|createHmac|timingSafeEqual/,
      );
      expect(source, `${file} pulled in a Buffer shim`).not.toMatch(/\bBuffer\.from\b/);
    }
  });

  it('verifyWebhook is absent from the browser build, which is why the graph is clean', () => {
    // The anti-vacuity check for the three above. They would all pass on an
    // empty bundle; this one says the browser entry is the DELIBERATELY
    // narrowed surface (PF-507) rather than a build that happened to omit
    // everything. A browser holding a webhook signing secret is a leaked
    // secret, so its absence is the correct design, not a gap.
    for (const { file, source } of builtJs()) {
      expect(source, `${file} contains verifyWebhook`).not.toContain('verifyWebhook');
    }
    // ...and the client that SHOULD be there, is.
    const bundled = builtJs().some(({ source }) => source.includes('documents/'));
    expect(bundled || builtJs().some(({ source }) => source.includes('/documents'))).toBe(true);
  });
});
