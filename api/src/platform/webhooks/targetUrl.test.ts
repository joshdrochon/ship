/**
 * PF-425 — `target_url` is validated at write time.
 *
 * Table-driven, because the value of this check is coverage of the shapes an
 * attacker actually sends, and a list is the only honest way to show which ones
 * were considered.
 */
import { describe, it, expect } from 'vitest';
import { checkTargetUrl, isPrivateHost, localTargetsPermitted } from './targetUrl.js';

/** Not under test — an explicit non-test env, so the exception is off. */
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const TEST = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

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
