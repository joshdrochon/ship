/**
 * Package smoke test.
 *
 * Thin by design — the substantive tests arrive with the detectors and the graph.
 * What this does pin is the dependency versions the FG-015 spike was run against.
 *
 * That spike is the evidence that a run suspended for human approval survives the
 * cron container exiting, which is the entire basis for the deployment model in
 * PRESEARCH.md Q27/Q28. The evidence covers the versions it was run against and
 * nothing else. If someone bumps LangGraph, this test fails and says so, rather
 * than letting a silent upgrade invalidate a load-bearing claim.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

import { FLEETGRAPH_VERSION } from './index.js';

const require = createRequire(import.meta.url);
const versionOf = (pkg: string): string =>
  (require(`${pkg}/package.json`) as { version: string }).version;

describe('@ship/agent', () => {
  it('exports its version marker', () => {
    expect(FLEETGRAPH_VERSION).toBe('0.0.0');
  });
});

describe('FG-015 spike coverage', () => {
  // Verified 2026-08-03: 8/8 assertions, pre-interrupt nodes did not re-run.
  const SPIKED = {
    '@langchain/langgraph': '1.4.8',
    '@langchain/langgraph-checkpoint-postgres': '1.0.4',
  } as const;

  for (const [pkg, expected] of Object.entries(SPIKED)) {
    it(`${pkg} is still the version the durable-interrupt spike proved (${expected})`, () => {
      expect(
        versionOf(pkg),
        `${pkg} moved off ${expected}. The FG-015 spike proved durable interrupt() ` +
          `for ${expected} only. Re-run the spike before accepting the bump — ` +
          `PRESEARCH.md Q19/Q21/Q27/Q28 all depend on it.`
      ).toBe(expected);
    });
  }
});
