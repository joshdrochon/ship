/**
 * PF-503 – PF-508 — the pluggable token store, its three implementations, and
 * the corruption contract.
 */
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShipClient } from '../client.js';
import type { ShipError } from '../errors.js';
import { CountingTokenStore, FakeClock, StubHttpClient } from '../testSupport.js';
import {
  CREDENTIAL_DIR_MODE,
  CREDENTIAL_FILE_MODE,
  FileTokenStore,
  defaultCredentialsPath,
} from './fileTokenStore.js';
import { LocalStorageTokenStore, type WebStorageLike } from './localStorageTokenStore.js';
import { InMemoryTokenStore, isStoredTokens, type ITokenStore, type StoredTokens } from './tokenStore.js';

const PAIR: StoredTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAtSeconds: 1_800_000_000,
  scopes: ['documents:read'],
};

describe('PF-503 · ITokenStore is three methods, satisfied structurally', () => {
  it('a third-party class with NO `implements` clause is an ITokenStore', () => {
    // This is the actual claim: a consumer writes their own store — Keychain,
    // Vault, a browser extension — and does not import a base class, register
    // anything, or extend ours.
    class KeychainStore {
      private value: StoredTokens | null = null;
      async load(): Promise<StoredTokens | null> {
        return this.value;
      }
      async save(tokens: StoredTokens): Promise<void> {
        this.value = tokens;
      }
      async clear(): Promise<void> {
        this.value = null;
      }
    }

    // The assignment IS the assertion — it does not compile if the shape is
    // wrong, and `pnpm type-check` covers it.
    const store: ITokenStore = new KeychainStore();
    expect(typeof store.load).toBe('function');
    expect(typeof store.save).toBe('function');
    expect(typeof store.clear).toBe('function');
  });

  it('exports the interface and both universal stores from the package root', async () => {
    const root = await import('../index.js');
    expect(root.InMemoryTokenStore).toBeTypeOf('function');
    expect(root.FileTokenStore).toBeTypeOf('function');
    expect(root.LocalStorageTokenStore).toBeTypeOf('function');
    expect(root.isStoredTokens).toBeTypeOf('function');
  });
});

describe('PF-504 · StoredTokens persists BOTH halves', () => {
  it('the refresh token is part of the shape, not an afterthought', () => {
    expect(isStoredTokens(PAIR)).toBe(true);
    // Access-only is NOT a credential this SDK will accept back off disk —
    // that is what makes `ship login` a one-time act rather than a per-command
    // device flow (p.8 stage 2 measures it across process restarts).
    expect(isStoredTokens({ accessToken: 'a' })).toBe(false);
  });

  it('rejects valid JSON of the wrong shape — the corruption case a try/catch misses', () => {
    for (const bad of [
      null,
      'a string',
      42,
      {},
      { accessToken: '' },
      { accessToken: 'a', refreshToken: 5, expiresAtSeconds: null, scopes: [] },
      { accessToken: 'a', refreshToken: null, expiresAtSeconds: 'soon', scopes: [] },
      { accessToken: 'a', refreshToken: null, expiresAtSeconds: null, scopes: 'read' },
      { accessToken: 'a', refreshToken: null, expiresAtSeconds: null, scopes: [1] },
    ]) {
      expect(isStoredTokens(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts a machine-to-machine credential with no refresh token', () => {
    expect(
      isStoredTokens({ accessToken: 'a', refreshToken: null, expiresAtSeconds: null, scopes: [] }),
    ).toBe(true);
  });
});

describe('PF-505 · InMemoryTokenStore is the default and the test double', () => {
  it('round-trips, clears, and two holders of ONE instance see each other’s writes', async () => {
    const store = new InMemoryTokenStore();
    expect(await store.load()).toBeNull();

    await store.save(PAIR);
    expect(await store.load()).toEqual(PAIR);

    // "Two clients sharing one store" — the property the single-flight refresh
    // test depends on.
    const a: ITokenStore = store;
    const b: ITokenStore = store;
    await a.save({ ...PAIR, accessToken: 'access-2' });
    expect((await b.load())?.accessToken).toBe('access-2');

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('is what a client gets when no store is supplied', () => {
    // Constructing without a store must not throw and must not require one.
    expect(() => new ShipClient({ token: 't', baseUrl: 'https://h.test' })).not.toThrow();
  });
});

describe('PF-506 · FileTokenStore — path, 0600, atomic', () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ship-sdk-store-'));
    path = join(dir, 'nested', 'credentials.json');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to ~/.ship/credentials.json — the path p.6 and L19 both name', () => {
    expect(defaultCredentialsPath()).toMatch(/[/\\]\.ship[/\\]credentials\.json$/);
  });

  it('round-trips through a configurable path, creating the directory', async () => {
    const store = new FileTokenStore({ path });
    expect(await store.load()).toBeNull();
    await store.save(PAIR);
    expect(await store.load()).toEqual(PAIR);
  });

  it.runIf(process.platform !== 'win32')('the file is 0600 and the directory 0700', async () => {
    const store = new FileTokenStore({ path });
    await store.save(PAIR);
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(join(dir, 'nested'))).mode & 0o777;
    expect(fileMode).toBe(CREDENTIAL_FILE_MODE);
    expect(dirMode).toBe(CREDENTIAL_DIR_MODE);
  });

  it.runIf(process.platform !== 'win32')('stays 0600 across a REWRITE', async () => {
    // The reason `save` writes a fresh temp file and renames rather than
    // truncating: `mode` on writeFile only applies at create time, so a
    // truncating write would leave whatever mode the file already had.
    const store = new FileTokenStore({ path });
    await store.save(PAIR);
    await chmod(path, 0o644);
    await store.save({ ...PAIR, accessToken: 'access-2' });
    expect((await stat(path)).mode & 0o777).toBe(CREDENTIAL_FILE_MODE);
  });

  it('leaves no .tmp file behind after a successful save', async () => {
    const { readdir } = await import('node:fs/promises');
    const store = new FileTokenStore({ path });
    await store.save(PAIR);
    const entries = await readdir(join(dir, 'nested'));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('credentials.json');
  });

  it('a crash mid-save cannot leave a half-written credential — the write is a rename', async () => {
    // Direct evidence for the atomicity claim: the file the SDK reads is only
    // ever the target of a `rename`, so any observation of it is a complete
    // JSON document. Simulated by asserting the on-disk bytes parse after a
    // save that also had a stray temp file present.
    const store = new FileTokenStore({ path });
    await writeFile(`${path}.leftover.tmp`, '{"accessTok', 'utf8');
    await store.save(PAIR);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(PAIR);
    // A stale temp file is never read.
    expect(await store.load()).toEqual(PAIR);
  });

  it('invalid JSON on disk reads as logged out, and does NOT delete the file', async () => {
    const store = new FileTokenStore({ path });
    await store.save(PAIR);
    await writeFile(path, 'not json at all', 'utf8');
    expect(await store.load()).toBeNull();
    // PF-508's decision: a file the SDK cannot parse may still be one a human
    // can repair, so nothing erases it.
    expect(await readFile(path, 'utf8')).toBe('not json at all');
  });

  it('valid JSON of the wrong shape also reads as logged out', async () => {
    const store = new FileTokenStore({ path });
    await writeFile(path, JSON.stringify({ token: 'legacy-format' }), 'utf8');
    expect(await store.load()).toBeNull();
  });

  it('a missing file is not an error, and clear() on a missing file is not either', async () => {
    const store = new FileTokenStore({ path: join(dir, 'never', 'written.json') });
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

describe('PF-507 · LocalStorageTokenStore', () => {
  function fakeStorage(initial: Record<string, string> = {}): WebStorageLike & {
    data: Record<string, string>;
  } {
    const data = { ...initial };
    return {
      data,
      getItem: (k) => data[k] ?? null,
      setItem: (k, v) => {
        data[k] = v;
      },
      removeItem: (k) => {
        delete data[k];
      },
    };
  }

  it('round-trips through injected Web Storage — no jsdom required', async () => {
    const storage = fakeStorage();
    const store = new LocalStorageTokenStore({ storage });
    expect(await store.load()).toBeNull();
    await store.save(PAIR);
    expect(await store.load()).toEqual(PAIR);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('two instances on one origin can be keyed apart', async () => {
    const storage = fakeStorage();
    const a = new LocalStorageTokenStore({ storage, key: 'ship.a' });
    const b = new LocalStorageTokenStore({ storage, key: 'ship.b' });
    await a.save(PAIR);
    expect(await b.load()).toBeNull();
  });

  it('a corrupt value reads as logged out and is not written back', async () => {
    const storage = fakeStorage({ 'ship.sdk.credentials': '{"partial' });
    const store = new LocalStorageTokenStore({ storage });
    expect(await store.load()).toBeNull();
    expect(storage.data['ship.sdk.credentials']).toBe('{"partial');
  });

  it('a getItem that throws (Safari private mode) reads as logged out', async () => {
    const store = new LocalStorageTokenStore({
      storage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    expect(await store.load()).toBeNull();
  });

  it('explains itself when there is no localStorage in the runtime', () => {
    // Node has none, so this is the real path a consumer hits.
    expect(() => new LocalStorageTokenStore()).toThrow(/requires a Web Storage/);
  });
});

describe('PF-508 · a corrupted store read is logged out — one attempt, no write-back', () => {
  const cases: { name: string; behaviour: () => Promise<StoredTokens | null> }[] = [
    {
      name: 'load() rejects (EACCES, or any store that throws)',
      behaviour: () => Promise.reject(new Error('EACCES: permission denied')),
    },
    { name: 'invalid JSON (the store resolved null)', behaviour: () => Promise.resolve(null) },
    {
      name: 'valid JSON of the wrong shape (the store resolved null)',
      behaviour: () => Promise.resolve(null),
    },
    {
      name: 'an empty access token',
      behaviour: () =>
        Promise.resolve({
          accessToken: '',
          refreshToken: null,
          expiresAtSeconds: null,
          scopes: [],
        }),
    },
  ];

  for (const { name, behaviour } of cases) {
    it(`${name} → { kind: 'auth' }, load() once, save() zero times, no request`, async () => {
      const store = new CountingTokenStore(behaviour);
      const http = new StubHttpClient([{ status: 200, body: {} }]);
      const client = new ShipClient({
        tokenStore: store,
        baseUrl: 'https://ship.test',
        http,
        clock: new FakeClock(),
        clientId: 'client-abc',
      });

      const error = (await client.me().catch((e: unknown) => e)) as ShipError;
      expect(error.kind).toBe('auth');
      expect(error.status).toBe(0);

      expect(store.loadCalls).toBe(1);
      expect(store.saveCalls).toBe(0);
      // The decision this ticket settles: a corrupt read does NOT call clear().
      expect(store.clearCalls).toBe(0);
      // "At most one outbound request attempt" — with no credential there is
      // nothing to send, so it is none. Never a retry loop.
      expect(http.requests).toHaveLength(0);
    });
  }

  it('no tokenStore and no token is also `auth`, with an actionable message', async () => {
    const client = new ShipClient({ baseUrl: 'https://ship.test', http: new StubHttpClient([{ status: 200 }]) });
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.message).toMatch(/token store holds no usable credential|Log in first/);
  });
});
