/**
 * PF-506 — `FileTokenStore`: `~/.ship/credentials.json`, 0600, atomic write.
 *
 * This is the store `ship login` writes through (PRD p.6's five-line story), and
 * it is NODE-ONLY: it imports `node:fs/promises`, `node:os` and `node:path` at
 * module top level. It is therefore reachable from `@ship/sdk` under the `node`
 * export condition and from `@ship/sdk/node`, and it is NOT part of the browser
 * entry. That split is PF-507's packaging fix; see `browser.ts`.
 *
 * ── Two properties, both enforced rather than asserted ──────────────────────
 *
 * **0600, and 0700 on the directory.** The file holds a refresh token, which
 * under PRD p.3's rotation is the credential worth stealing — it mints new
 * access tokens indefinitely. Created with the mode rather than chmod'd after,
 * so there is no window in which it is world-readable. `mode` on `writeFile` is
 * only applied at CREATE time, which is exactly why the write goes to a fresh
 * temp file every time (below) rather than truncating the existing one.
 *
 * **Atomic.** Write to `credentials.json.<random>.tmp` in the same directory,
 * then `rename`. `rename` within one filesystem is atomic, so a crash mid-save
 * leaves either the old credential or the new one and never half of either —
 * the *"no partial credential is ever written back"* half of the Failure Modes
 * contract (p.12). Truncate-then-write, the obvious implementation, has a window
 * in which the file exists and is empty, and a CLI that crashes in that window
 * logs the user out with no way to know why.
 *
 * ── Corruption is logged-out, not repaired (PF-508) ─────────────────────────
 * EACCES, invalid JSON, and valid JSON of the wrong shape all resolve to `null`
 * — no throw, no retry, and no `clear()`. `clear()` is a write, and a file this
 * SDK cannot parse may still be a file a human can read.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isStoredTokens, type ITokenStore, type StoredTokens } from './tokenStore.js';

/** Owner read+write. No group, no other. */
export const CREDENTIAL_FILE_MODE = 0o600;

/** Owner read+write+execute. Without `x` the owner cannot traverse into it. */
export const CREDENTIAL_DIR_MODE = 0o700;

/** `~/.ship/credentials.json` — the path PRD p.6 and L19's CLI both name. */
export function defaultCredentialsPath(): string {
  return join(homedir(), '.ship', 'credentials.json');
}

export interface FileTokenStoreOptions {
  /** Defaults to `~/.ship/credentials.json`. Configurable, per PF-506. */
  path?: string;
}

export class FileTokenStore implements ITokenStore {
  readonly path: string;

  constructor(options: FileTokenStoreOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath();
  }

  /**
   * Reads the credential, or `null` for every failure mode.
   *
   * ENOENT (never logged in) and EACCES (someone else's file) are the same
   * answer to the caller — "there is no credential I can use" — and neither is
   * worth a distinct error, because the caller's next move is identical.
   */
  async load(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    return isStoredTokens(parsed) ? parsed : null;
  }

  /** Atomic, 0600. See the header for why it is not a truncating write. */
  async save(tokens: StoredTokens): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: CREDENTIAL_DIR_MODE });
    // `mkdir`'s `mode` is ignored when the directory already exists, and an
    // existing `~/.ship` created by something else may be 0755. Fixing it here
    // is cheap and is the difference between a 0600 file in a world-readable
    // directory (fine) and a directory an attacker can add a symlink to.
    await chmod(directory, CREDENTIAL_DIR_MODE).catch(() => undefined);

    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      // `mode` applies because the temp path is guaranteed not to exist.
      await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, {
        encoding: 'utf8',
        mode: CREDENTIAL_FILE_MODE,
      });
      // Belt and braces: a permissive umask does not affect an explicit `mode`,
      // but a filesystem that ignores it silently would leave the credential
      // readable, and this call turns that into an observable failure.
      await chmod(temporary, CREDENTIAL_FILE_MODE);
      await rename(temporary, this.path);
    } catch (error) {
      // Leaving a stray `.tmp` holding a live credential is worse than the
      // original failure. Best-effort, and never masks the real error.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** Removes the file. A missing file is already cleared, not an error. */
  async clear(): Promise<void> {
    await unlink(this.path).catch(() => undefined);
  }
}
