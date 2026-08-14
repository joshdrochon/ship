/**
 * PF-368 — the committed static copy at `docs/openapi.json`.
 *
 * PRD p.13's Submission Requirements table (which spans p.12 and p.13) asks for
 * the spec as a committed artifact alongside the live URL. PF-369's CI job
 * regenerates and runs `git diff --exit-code docs/openapi.json`; this test is
 * the local half — it asserts the file on disk is byte-for-byte what the booted
 * app serves, so a stale artifact fails here before it fails in a grader's hands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import request from 'supertest';
import { createBearerTestApp } from '../oauth/bearerTestSupport.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { mountOpenApiSpec, OPENAPI_SPEC_PATH } from './route.js';
import { generatePublicOpenAPIDocument } from './registry.js';
import { PUBLIC_SPEC_FILE, writePublicSpec } from './staticCopy.js';
// ⚠ THE IMPORT LIST IS LOAD-BEARING, AND THIS FILE WRITES TO A COMMITTED FILE.
//
// The idempotence case below calls `writePublicSpec()` for real, so whatever
// operations are registered in THIS module's graph is what lands in
// `docs/openapi.json`. A route module missing from these lines does not merely
// go unasserted — it gets DELETED from the committed artifact by running the
// test suite, and the next assertion to fail is the one above it, pointing at
// drift it caused itself.
//
// L10 hit exactly that: `/me` was generated correctly by `pnpm openapi:public`
// and then silently removed by `pnpm test`. Keep these lines in step with
// `api/src/scripts/generate-public-openapi.ts`, which is the other place the
// list appears.
import '../api/v1/documents/routes.js';
import '../api/v1/issues/routes.js';
import '../api/v1/sprints/routes.js';
import '../api/v1/me/routes.js';
import '../api/v1/webhooks/routes.js';

describe('PF-368 — docs/openapi.json is the served document', () => {
  it('the file exists and is committed', () => {
    expect(
      existsSync(PUBLIC_SPEC_FILE),
      'Run `pnpm openapi:public`. The static copy is a Submission Requirement (p.13).',
    ).toBe(true);
  });

  it('parses to exactly what GET /api/v1/openapi.json serves', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(generatePublicOpenAPIDocument()),
    });
    const served = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    const onDisk = JSON.parse(readFileSync(PUBLIC_SPEC_FILE, 'utf8'));

    expect(
      onDisk,
      'The committed artifact has drifted from the live one. Regenerate with ' +
        '`pnpm openapi:public` — CI runs the same command and then ' +
        '`git diff --exit-code docs/openapi.json`.',
    ).toEqual(served.body);
  });

  it('the writer is idempotent — regenerating twice produces identical bytes', () => {
    writePublicSpec();
    const first = readFileSync(PUBLIC_SPEC_FILE, 'utf8');
    writePublicSpec();
    const second = readFileSync(PUBLIC_SPEC_FILE, 'utf8');
    expect(
      second,
      'A non-deterministic writer makes PF-369 flap: every CI run would report the ' +
        'committed copy as stale, and the check would be turned off within a week.',
    ).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
  });

  it('is NOT the internal spec — different path, different version', () => {
    const onDisk = JSON.parse(readFileSync(PUBLIC_SPEC_FILE, 'utf8')) as {
      openapi: string;
      info: { title: string };
      servers: { url: string }[];
    };
    expect(onDisk.openapi).toBe('3.1.0');
    expect(onDisk.info.title).toBe('Ship Public API');
    expect(onDisk.servers[0]?.url).toBe('/api/v1');
    // `pnpm openapi:generate` writes api/openapi.json at 3.0.0 with title
    // "Ship API". One script writing both would be one command whose failure
    // mode is publishing 130 internal routes as public contract.
    expect(PUBLIC_SPEC_FILE.replace(/\\/g, '/')).toMatch(/\/docs\/openapi\.json$/);
  });
});
