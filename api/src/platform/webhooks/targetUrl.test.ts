/**
 * PF-425 — `target_url` is validated at write time.
 *
 * Table-driven, because the value of this check is coverage of the shapes an
 * attacker actually sends, and a list is the only honest way to show which ones
 * were considered.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTargetUrl,
  isPrivateHost,
  localTargetsPermitted,
  LOCAL_WEBHOOK_TARGETS_ENV_VAR,
} from './targetUrl.js';

/** Not under test — an explicit non-test env, so the exception is off. */
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const TEST = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

/**
 * PF-575's two configurations, spelled as data.
 *
 * `DEPLOYED` is what Elastic Beanstalk actually runs: production, and no mention
 * of the opt-in anywhere. `LOCAL_OPTED_IN` is what a developer recording the
 * demo runs — `pnpm dev`'s `NODE_ENV`, plus the flag typed on purpose.
 */
const DEPLOYED = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const LOCAL_DEFAULT = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const LOCAL_OPTED_IN = {
  NODE_ENV: 'development',
  [LOCAL_WEBHOOK_TARGETS_ENV_VAR]: 'true',
} as NodeJS.ProcessEnv;

describe('PF-425 — accepted targets', () => {
  it.each([
    'https://example.com/hooks/ship',
    'https://example.com:8443/hooks',
    'https://sub.domain.example.co.uk/a/b?c=d',
    'https://198.51.100.7/hooks', // TEST-NET-2, a public literal
    'https://[2606:4700:4700::1111]/hooks', // public IPv6 literal
  ])('accepts %s', (url) => {
    expect(checkTargetUrl(url, PROD)).toBeNull();
  });
});

describe('PF-425 — rejected targets', () => {
  it.each([
    ['/hooks/ship', 'not-absolute'],
    ['hooks/ship', 'not-absolute'],
    ['http://example.com/hooks', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['ftp://example.com/', 'scheme'],
    ['https://user:password@example.com/hooks', 'credentials'],
    ['https://user@example.com/hooks', 'credentials'],
  ])('rejects %s as %s', (url, reason) => {
    expect(checkTargetUrl(url, PROD)?.reason).toBe(reason);
  });

  it.each([
    'https://localhost/hooks',
    'https://127.0.0.1/hooks',
    'https://127.1.2.3/hooks',
    'https://10.0.0.5/hooks',
    'https://172.16.0.1/hooks',
    'https://172.31.255.254/hooks',
    'https://192.168.1.1/hooks',
    'https://169.254.169.254/latest/meta-data/', // the cloud metadata endpoint
    'https://100.64.0.1/hooks', // CGNAT
    'https://0.0.0.0/hooks',
    'https://[::1]/hooks',
    'https://[fe80::1]/hooks',
    'https://[fc00::1]/hooks',
    // IPv4-mapped. `new URL()` rewrites this to `[::ffff:a00:1]` before the
    // check ever sees it, which is exactly why the dotted-form-only version of
    // this rule blocked nothing while looking correct.
    'https://[::ffff:10.0.0.1]/hooks',
    'https://[::ffff:a00:1]/hooks', // the normalised spelling, asserted directly
    'https://[::ffff:7f00:1]/hooks', // ::ffff:127.0.0.1
    'https://api.internal/hooks',
    'https://printer.local/hooks',
  ])('rejects the private/loopback host in %s', (url) => {
    expect(checkTargetUrl(url, PROD)?.reason).toBe('private-host');
  });

  it('rejects 172.15 and 172.32, which are OUTSIDE the RFC 1918 /12', () => {
    // The bounds of 172.16.0.0/12 are the part of this check most likely to be
    // written wrong, so both edges are pinned from the outside.
    expect(checkTargetUrl('https://172.15.0.1/h', PROD)).toBeNull();
    expect(checkTargetUrl('https://172.32.0.1/h', PROD)).toBeNull();
  });
});

describe('PF-425 — the one named exception', () => {
  it('permits http://localhost only under NODE_ENV=test', () => {
    expect(localTargetsPermitted(TEST)).toBe(true);
    expect(localTargetsPermitted(PROD)).toBe(false);
    expect(checkTargetUrl('http://localhost:9099/hooks', TEST)).toBeNull();
    expect(checkTargetUrl('http://127.0.0.1:9099/hooks', TEST)).toBeNull();
    expect(checkTargetUrl('http://localhost:9099/hooks', PROD)?.reason).toBe('scheme');
  });

  it('does NOT extend the exception to plaintext http on a public host', () => {
    // The carve-out is for the loopback, which has no certificate — not for
    // plaintext in general. A test that could POST a signed payload to
    // `http://evil.example.com` would be a hole wearing an exemption.
    expect(checkTargetUrl('http://example.com/hooks', TEST)?.reason).toBe('scheme');
  });
});

/**
 * PF-575 — the opt-in, and the two configurations that matter.
 *
 * The defect this closes: `ship webhooks tail --listen` can only ever produce
 * `http://127.0.0.1:<port>/…`, and outside the test runner that was rejected
 * `validation_failed`. Nobody recording the demo video runs `NODE_ENV=test`.
 */
describe('PF-575 — the loopback opt-in', () => {
  it('the DEPLOYED configuration rejects a loopback target', () => {
    // Production, and the variable is not mentioned at all — which is exactly
    // what Elastic Beanstalk's environment looks like. Both doors shut.
    expect(localTargetsPermitted(DEPLOYED)).toBe(false);
    expect(checkTargetUrl('http://127.0.0.1:9099/hooks', DEPLOYED)?.reason).toBe('scheme');
    expect(checkTargetUrl('https://127.0.0.1:9099/hooks', DEPLOYED)?.reason).toBe('private-host');
  });

  it('a local instance rejects it too, until someone opts in', () => {
    // `pnpm dev` on its own is NOT enough. The flag has to be typed.
    expect(localTargetsPermitted(LOCAL_DEFAULT)).toBe(false);
    expect(checkTargetUrl('http://127.0.0.1:9099/hooks', LOCAL_DEFAULT)?.reason).toBe('scheme');
  });

  it('the OPTED-IN local configuration accepts a loopback target', () => {
    expect(localTargetsPermitted(LOCAL_OPTED_IN)).toBe(true);
    expect(checkTargetUrl('http://127.0.0.1:9099/ship-cli-tail', LOCAL_OPTED_IN)).toBeNull();
    expect(checkTargetUrl('http://localhost:9099/ship-cli-tail', LOCAL_OPTED_IN)).toBeNull();
  });

  it('opts in on the exact string "true" and nothing else', () => {
    // Off by absence AND off by anything-but-true: `SHIP_ALLOW_...=false`,
    // `=0` and `=1` are all the operator saying no, or saying something the
    // next reader would have to guess at.
    for (const value of ['', 'false', '0', '1', 'yes', 'TRUE']) {
      expect(
        localTargetsPermitted({
          NODE_ENV: 'development',
          [LOCAL_WEBHOOK_TARGETS_ENV_VAR]: value,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it('is spelled in exactly ONE place in the shipped source', () => {
    // PF-575: *"the flag's name appears in exactly one place."* The one place is
    // the `LOCAL_WEBHOOK_TARGETS_ENV_VAR` declaration; every other reader goes
    // through the constant. A second literal is how an operator ends up setting
    // a variable that half the code reads.
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const hits: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const source = readFileSync(full, 'utf8');
        // Count occurrences of the raw name, not of the constant's identifier.
        const count = source.split(LOCAL_WEBHOOK_TARGETS_ENV_VAR).length - 1;
        for (let i = 0; i < count; i++) hits.push(full);
      }
    };
    walk(root);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/targetUrl\.ts$/);
  });

  it('does not widen anything else — a public plaintext target stays refused', () => {
    // The opt-in is for the loopback. It is not a global "allow http".
    expect(checkTargetUrl('http://example.com/hooks', LOCAL_OPTED_IN)?.reason).toBe('scheme');
    expect(checkTargetUrl('https://user:pw@example.com/h', LOCAL_OPTED_IN)?.reason).toBe(
      'credentials',
    );
  });
});

describe('isPrivateHost', () => {
  it('is case-insensitive and tolerates bracketed IPv6', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  it('does not treat a public name containing "local" as private', () => {
    expect(isPrivateHost('locality.example.com')).toBe(false);
    expect(isPrivateHost('mylocal.com')).toBe(false);
  });
});
