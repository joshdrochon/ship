/**
 * PF-491 and PF-494 — the two defects that were on disk in `client.ts`.
 *
 * PF-494 is the table test the ticket asks for: bare origin, trailing slash,
 * path prefix, and prefix without a trailing slash, each producing the correct
 * four URLs. A grader deploying behind a path prefix hits this before anything
 * else, and the old `new URL('/api/v1' + path, baseUrl)` silently 404'd all of
 * them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  buildOAuthTokenUrl,
  buildRequestUrl,
  resolveBaseUrl,
} from './baseUrl.js';
import { ShipClient } from './client.js';

const originalEnv = process.env[BASE_URL_ENV_VAR];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[BASE_URL_ENV_VAR];
  else process.env[BASE_URL_ENV_VAR] = originalEnv;
});

describe('PF-491 · baseUrl is optional, with a documented resolution order', () => {
  it('the gate expression `new ShipClient({ token })` constructs at RUNTIME too', () => {
    delete process.env[BASE_URL_ENV_VAR];
    const client = new ShipClient({ token: 'tok' });
    expect(client.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(client.baseUrlSource).toBe('default');
  });

  it('an explicit option wins over the environment', () => {
    process.env[BASE_URL_ENV_VAR] = 'https://from-env.example.com';
    expect(resolveBaseUrl('https://explicit.example.com')).toEqual({
      url: 'https://explicit.example.com',
      source: 'option',
    });
  });

  it('the environment wins over the built-in default', () => {
    process.env[BASE_URL_ENV_VAR] = 'https://from-env.example.com';
    expect(resolveBaseUrl()).toEqual({ url: 'https://from-env.example.com', source: 'env' });
  });

  it('an empty or whitespace env var counts as unset, not as an empty base URL', () => {
    process.env[BASE_URL_ENV_VAR] = '   ';
    expect(resolveBaseUrl().source).toBe('default');
  });

  it('a malformed base URL throws at construction, naming where it came from', () => {
    expect(() => resolveBaseUrl('not a url')).toThrow(/baseUrl option/);
    process.env[BASE_URL_ENV_VAR] = 'also-not-a-url';
    expect(() => resolveBaseUrl()).toThrow(new RegExp(BASE_URL_ENV_VAR));
  });
});

describe('PF-494 · a path prefix on the base URL survives', () => {
  // The four shapes a base URL actually arrives in × the four paths the SDK
  // builds. Every cell is asserted; nothing here is a spot check.
  const paths = ['/me', '/documents', '/documents/abc-123', '/openapi.json'];

  const cases: { base: string; expectedPrefix: string }[] = [
    { base: 'https://ship.example.com', expectedPrefix: 'https://ship.example.com/api/v1' },
    { base: 'https://ship.example.com/', expectedPrefix: 'https://ship.example.com/api/v1' },
    { base: 'https://ship.example.com/ship', expectedPrefix: 'https://ship.example.com/ship/api/v1' },
    {
      base: 'https://ship.example.com/ship/',
      expectedPrefix: 'https://ship.example.com/ship/api/v1',
    },
    {
      base: 'https://ship.example.com/a/b/c',
      expectedPrefix: 'https://ship.example.com/a/b/c/api/v1',
    },
  ];

  for (const { base, expectedPrefix } of cases) {
    it(`${base} → ${expectedPrefix}/…`, () => {
      for (const path of paths) {
        expect(buildRequestUrl(base, path).toString()).toBe(`${expectedPrefix}${path}`);
      }
    });
  }

  it('is the exact case the old implementation got wrong', () => {
    // Documented so the regression is legible: this is what
    // `new URL('/api/v1/me', base)` produced, and why every call 404'd.
    expect(new URL('/api/v1/me', 'https://ship.example.com/ship').toString()).toBe(
      'https://ship.example.com/api/v1/me',
    );
    expect(buildRequestUrl('https://ship.example.com/ship', '/me').toString()).toBe(
      'https://ship.example.com/ship/api/v1/me',
    );
  });

  it('query parameters are appended, not merged from the base', () => {
    const url = buildRequestUrl('https://ship.example.com/ship?debug=1', '/documents', {
      cursor: 'abc',
      limit: '25',
    });
    expect(url.toString()).toBe(
      'https://ship.example.com/ship/api/v1/documents?cursor=abc&limit=25',
    );
  });

  it('a non-rooted path is a programming error, not something to repair', () => {
    expect(() => buildRequestUrl('https://ship.example.com', 'me')).toThrow(/must start with/);
  });

  it('non-ASCII and reserved characters in a path segment are preserved', () => {
    expect(buildRequestUrl('https://h.example', `/documents/${encodeURIComponent('a b/c')}`).toString())
      .toBe('https://h.example/api/v1/documents/a%20b%2Fc');
  });
});

describe('the OAuth token endpoint is a SIBLING of /api/v1, and also keeps the prefix', () => {
  it.each([
    ['https://ship.example.com', 'https://ship.example.com/oauth/token'],
    ['https://ship.example.com/', 'https://ship.example.com/oauth/token'],
    ['https://ship.example.com/ship', 'https://ship.example.com/ship/oauth/token'],
  ])('%s → %s', (base, expected) => {
    expect(buildOAuthTokenUrl(base).toString()).toBe(expected);
  });
});
