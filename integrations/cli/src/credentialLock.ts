/**
 * D14, the CLI's half — a lockfile beside `~/.ship/credentials.json`.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * L06's server-side rotation is correct: a conditional
 * `UPDATE … WHERE spent_at IS NULL` inside one transaction means ten concurrent
 * exchanges of one refresh token yield exactly one new pair and one family
 * revocation. L17's client-side single-flight is also correct, and it is keyed
 * on the TOKEN STORE INSTANCE — i.e. on one process.
 *
 * The CLI breaks that assumption by construction: `~/.ship/credentials.json` is
 * shared, so two terminals are two processes holding two `FileTokenStore`
 * instances over one credential. Both notice the access token has expired, both
 * POST the same refresh token, and strict rotation (PRD p.3 — *"reuse
 * invalidates the family"*) revokes the family and logs the user out. Mid-demo.
 *
 * L99's D14 records L17's position exactly: *"the cross-process case is a
 * lockfile beside `~/.ship/credentials.json` and belongs to L19, not to a
 * library that also runs in a browser."* This is that lockfile.
 *
 * ── Why a directory and not a file ──────────────────────────────────────────
 * `mkdir` is atomic and fails with EEXIST if the name is taken, on every POSIX
 * filesystem and on Windows. `open(O_CREAT|O_EXCL)` is equally atomic but
 * leaves a zero-byte file that looks like a corrupt credential to anyone
 * eyeballing `~/.ship/`, and `writeFile` + `exists` is a race with a name.
 *
 * ── Staleness, and why it is bounded rather than absent ─────────────────────
 * A process that is SIGKILLed holds the lock forever, and a CLI that hangs
 * because of a crash three days ago is worse than one that refreshes twice. So
 * a lock older than `STALE_AFTER_MS` is broken and taken. The window is long
 * enough that no honest refresh is inside it (a token exchange is one HTTP
 * round trip) and short enough that a human does not notice.
 *
 * ── No wall clock, no `setTimeout` ──────────────────────────────────────────
 * Both come in through `CliClock` (p.11), so the contention test drives real
 * waiting with a fake clock and zero timers.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliClock } from './io.js';

/** A lock held longer than this is assumed to belong to a dead process. */
export const STALE_AFTER_MS = 30_000;

/** How long a waiter sleeps between attempts. */
export const POLL_INTERVAL_MS = 25;

/** Total time a waiter will spend before giving up and proceeding unlocked. */
export const ACQUIRE_TIMEOUT_MS = 10_000;

/** `~/.ship/credentials.json` → `~/.ship/credentials.lock`. */
export function lockPathFor(credentialsPath: string): string {
  return join(dirname(credentialsPath), 'credentials.lock');
}

export interface LockOptions {
  clock: CliClock;
  staleAfterMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface LockOutcome {
  /** False when the timeout expired and the caller proceeded anyway. */
  acquired: boolean;
  /** True when a stale lock was broken to get in — worth a diagnostic line. */
  brokeStaleLock: boolean;
}

function lockAgeMs(path: string, nowMs: number): number | null {
  try {
    // The mtime of the directory, not of anything inside it — one stat, and it
    // is set by `mkdir` itself so there is no window where the lock exists and
    // has no age.
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Runs `fn` while holding the lock. Releases it on every path, including throw.
 *
 * ── Proceeding without the lock is deliberate ───────────────────────────────
 * If the timeout expires, this runs `fn` anyway rather than failing the
 * command. A CLI that refuses to list documents because a lockfile is wedged
 * has turned a concurrency optimisation into an outage. The worst case of
 * proceeding is the defect this file exists to make rare — the worst case of
 * refusing is a CLI that cannot be used at all, and users cannot debug a
 * lockfile.
 */
export async function withCredentialLock<T>(
  credentialsPath: string,
  options: LockOptions,
  fn: () => Promise<T>,
): Promise<{ result: T; lock: LockOutcome }> {
  const path = lockPathFor(credentialsPath);
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const clock = options.clock;

  const deadline = clock.now() + timeoutMs;
  let acquired = false;
  let brokeStaleLock = false;

  // F120 — `~/.ship/` may not exist yet, and on the FIRST EVER `ship login` it
  // does not. `mkdirSync(path, { recursive: false })` then fails ENOENT rather
  // than EEXIST, the catch below reads that as "someone holds the lock", and the
  // command burns its entire 10 s acquire budget waiting for a directory that
  // can never appear. Creating the parent first is the whole fix, and it is the
  // same directory `FileTokenStore` creates a moment later for the credential.
  //
  // `recursive: false` on the LOCK itself stays: that EEXIST is the atomic
  // test-and-set this whole module is built on, and `recursive: true` there
  // would succeed unconditionally and quietly delete the mutual exclusion.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Unwritable home, read-only filesystem, a file where the directory should
    // be. The lock cannot be taken; `fn()` still runs unlocked, which is this
    // module's documented posture when the lock is unavailable.
  }

  for (;;) {
    try {
      mkdirSync(path, { recursive: false });
      acquired = true;
      break;
    } catch {
      // Taken. Either the holder is alive, or it died holding it.
      const age = lockAgeMs(path, clock.now());
      if (age !== null && age > staleAfterMs) {
        try {
          rmSync(path, { recursive: true, force: true });
          brokeStaleLock = true;
          continue;
        } catch {
          // Someone else broke it first; fall through and retry normally.
        }
      }
      if (clock.now() >= deadline) break;
      await clock.sleep(pollIntervalMs);
    }
  }

  if (acquired) {
    try {
      // Who holds it, for a human staring at a wedged `~/.ship/`. Best effort —
      // the lock is the directory, not this file, so a failure here is cosmetic.
      writeFileSync(join(path, 'owner'), `${process.pid}\n`, 'utf8');
    } catch {
      // ignored
    }
  }

  try {
    const result = await fn();
    return { result, lock: { acquired, brokeStaleLock } };
  } finally {
    if (acquired) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A lock we cannot remove becomes stale in `staleAfterMs` and is broken
        // by the next waiter. Never worth failing a completed command over.
      }
    }
  }
}

/** The pid recorded by the current holder, or `null`. Diagnostics only. */
export function lockHolderPid(credentialsPath: string): number | null {
  try {
    const raw = readFileSync(join(lockPathFor(credentialsPath), 'owner'), 'utf8').trim();
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
