/**
 * PF-586 / PF-605 — the TTFE drill's runner.
 *
 * ── `retry: 0`, and it is the point ─────────────────────────────────────────
 * p.9's target is *"0% (any flake = bug in the drill or the platform)"*, glossed
 * as exactly that. A retry is precisely the mechanism that converts a flake into
 * a pass, so that phrasing forbids retries rather than merely discouraging them.
 *
 * This is also the second reason the drill is not a Playwright test:
 * `playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1`, so a drill
 * written into that suite inherits two CI retries and forfeits p.9's target on a
 * line of config it never reads. `scripts/ttfe/check-no-sleeps.mjs` asserts this
 * file still says `retry: 0`.
 *
 * ── One worker, no isolation games ──────────────────────────────────────────
 * The drill boots a container, a server and a listener. Running two of it in
 * parallel is legal (PF-587 asserts non-collision) but pointless: it would
 * contend for the same CPU and make the graded number worse for no coverage.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.drill.ts'],
    retry: 0,
    fileParallelism: false,
    pool: 'forks',
    // Vitest 4 flattened `poolOptions` to the top level; the nested form is
    // accepted-and-ignored, which is the worst kind of config bug — it reads as
    // configured and is not.
    maxWorkers: 1,
    minWorkers: 1,
    // A stage that hangs must fail as THAT stage (PF-593), so the per-stage
    // deadlines in ttfe.thresholds.json fire first. This is the backstop for a
    // hang outside any stage — the harness, the container, the install.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    reporters: ['default'],
  },
});
