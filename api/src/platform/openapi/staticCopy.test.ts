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
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createBearerTestApp } from '../oauth/bearerTestSupport.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
// ⚠ THE IMPORT BELOW IS LOAD-BEARING, AND THIS FILE WRITES TO A COMMITTED FILE.
//
// The idempotence case below runs the real writer, so whatever
// operations are registered in THIS module's graph is what lands in
// `docs/openapi.json`. A route module missing from the graph does not merely go
// unasserted — it gets DELETED from the committed artifact by running the test
// suite, and the next assertion to fail is the one above it, pointing at drift
// it caused itself.
//
// This file used to carry its own hand-written copy of the list, and it cost
// exactly that, twice. L10: `/me` was generated correctly by `pnpm
// openapi:public` and then silently removed by `pnpm test`. Then `/audit`: the
// copy here was never updated when the route shipped, so running the suite
// rewrote `docs/openapi.json` from 23 operations down to 22 and deleted the
// audit trail from the committed spec.
//
// There is now ONE list, `api/v1/allRoutes.ts`, and `allRoutes.test.ts` checks
// it against the directory listing. Do not reintroduce a local copy.
//
// ⚠ AND IT MUST COME BEFORE `./route.js`. Imports evaluate in source order, the
// registry emits `paths` in registration order, and `generate-public-openapi.ts`
// loads the resource modules before the openapi route. Import `./route.js`
// first and the writer here emits `/openapi.json` at the TOP of
// `paths` — same 23 operations, different key order, so `toEqual` below stays
// green while `git diff --exit-code docs/openapi.json` fails in CI on a 750-line
// diff that means nothing.
import '../api/v1/allRoutes.js';
import { mountOpenApiSpec, OPENAPI_SPEC_PATH } from './route.js';
import { generatePublicOpenAPIDocument } from './registry.js';
import { PUBLIC_SPEC_FILE, writePublicSpec } from './staticCopy.js';

/**
 * A throwaway destination for the cases that exercise the writer for real.
 *
 * ⚠ NOTHING IN THIS FILE MAY WRITE TO `PUBLIC_SPEC_FILE`. It is a committed,
 * graded artifact, and this file asserts things ABOUT it — so a test that also
 * writes it can always be made to pass by running it twice. That is not a
 * hypothetical: the idempotence case used to call the writer with no argument,
 * its import list was missing the audit route, and so run #1 failed
 * the comparison above and then overwrote `docs/openapi.json` with its own
 * 22-operation output, and run #2 passed against the file run #1 had corrupted.
 * `/audit` silently vanished from the published spec, and CI — which always runs
 * once, in a fresh container — went red on `main` while local re-runs looked
 * fine.
 */
function scratchSpecFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ship-openapi-')), 'openapi.json');
}

describe('PF-368 — docs/openapi.json is the served document', () => {
  it('no test in this file writes to the committed artifact', () => {
    // Enforced by reading this file's own source, because the rule is about
    // what the code DOES and a comment asking nicely is what was there before.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // Both spellings that land on the committed file: no argument (the default
    // is `PUBLIC_SPEC_FILE`) and the constant passed explicitly.
    const bareWrites = [...source.matchAll(/writePublicSpec\(\s*(?:\)|PUBLIC_SPEC_FILE)/g)];

    expect(
      bareWrites.length,
      'A bare writer call — no destination argument — writes docs/openapi.json, the ' +
        'committed, graded artifact this file makes assertions about. Pass a scratch path. ' +
        'A test ' +
        'that mutates its own subject can be made to pass by running it twice, which is ' +
        'exactly how the missing audit route stayed hidden.',
    ).toBe(0);
  });

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
    const first = readFileSync(writePublicSpec(scratchSpecFile()), 'utf8');
    const second = readFileSync(writePublicSpec(scratchSpecFile()), 'utf8');
    expect(
      second,
      'A non-deterministic writer makes PF-369 flap: every CI run would report the ' +
        'committed copy as stale, and the check would be turned off within a week.',
    ).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
  });

  it('a fresh generation is BYTE-for-byte the committed file', () => {
    // The `toEqual` case above compares parsed objects, which is
    // order-insensitive: a generation emitting the same 23 operations under a
    // different key order satisfies it and still leaves the committed artifact
    // stale. Nothing would then fail until CI's `git diff --exit-code`, which
    // reports a 750-line diff with no cause attached to it. That is a real
    // mode — importing `./route.js` before the resource manifest moves
    // `/openapi.json` to the top of `paths`.
    //
    // Writing to a scratch path and diffing the bytes catches it here, where
    // the message can say why, and without touching `docs/openapi.json`.
    const generated = readFileSync(writePublicSpec(scratchSpecFile()), 'utf8');
    const committed = readFileSync(PUBLIC_SPEC_FILE, 'utf8');

    expect(
      generated,
      'A fresh generation does not match the committed docs/openapi.json byte-for-byte, so ' +
        "CI's `git diff --exit-code docs/openapi.json` will fail. The operations may all be " +
        'present — check the key ORDER before assuming content was lost, because registration ' +
        'order is emission order. That usually means module load order diverged from ' +
        '`scripts/generate-public-openapi.ts` (the manifest must load before `./route.js`). ' +
        'Fix with `pnpm openapi:public` and commit the result.',
    ).toBe(committed);
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
