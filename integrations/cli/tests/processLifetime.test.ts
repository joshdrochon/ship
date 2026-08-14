/**
 * F120 and F121 — the two defects that made `ship login` exit 0 having done
 * nothing, and the reason this file exists at all.
 *
 * ── What was observed, not inferred ────────────────────────────────────────
 * Against a booted Ship, on a machine with no `~/.ship/`:
 *
 *     $ ship login --base-url http://localhost:3919 --client-id ship_app_grader_demo
 *     ship: authenticating against http://localhost:3919 as ship_app_grader_demo
 *     $ echo $?
 *     0
 *
 * 64 ms. No user code. No HTTP request — `oauth_device_codes` stayed empty. No
 * credential written. Exit **zero**, so every caller downstream believed it had
 * worked, and the first line of PRD p.6's five-line story was a silent lie.
 *
 * Two bugs, and neither is visible on its own:
 *
 *   F120  `withCredentialLock` took the lock with
 *         `mkdirSync(path, { recursive: false })`. On a first-ever login `~/.ship`
 *         does not exist yet, so that throws **ENOENT**, not EEXIST. The catch
 *         branch reads every failure as "someone else holds it", so the command
 *         settled in to wait out its 10 s budget for a directory that could
 *         never appear.
 *
 *   F121  ...and the wait was `clock.sleep()`, whose timer was `unref()`'d.
 *         An unreferenced timer does not hold the event loop, and during that
 *         sleep it was the only pending handle. Node drained, abandoned
 *         `main()`'s promise mid-await, and exited with `process.exitCode`
 *         never assigned.
 *
 * F120 alone is a 10 s pause. F121 alone is latent until something sleeps with
 * nothing else in flight. Together they are a CLI that reports success for work
 * it did not do. Both are pinned below, separately, because either one coming
 * back is a defect.
 *
 * Zero timers and zero timing assertions here (p.11): F120 is a filesystem fact
 * driven by a fake clock, and F121 is asked of the runtime directly.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realClock, type CliClock } from '../src/io.js';
import { lockPathFor, withCredentialLock } from '../src/credentialLock.js';

/**
 * A clock that never actually waits.
 *
 * `sleep` advances the clock and resolves — so a lock-acquisition loop that
 * spins runs out its deadline immediately instead of hanging the suite, and
 * "did it acquire?" stays a pure assertion about the filesystem.
 */
function fakeClock(): CliClock & { advance(ms: number): void } {
  let nowMs = 1_700_000_000_000;
  return {
    now: () => nowMs,
    random: () => 0.5,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('F120 — the first-ever login, where ~/.ship does not exist yet', () => {
  it('acquires the lock when the credentials directory is missing', async () => {
    // A directory that does NOT exist, inside one that does. Exactly the shape
    // of `~/.ship/credentials.json` on a machine that has never run `ship`.
    const home = mkdtempSync(join(tmpdir(), 'l19-lock-'));
    const credentialsPath = join(home, '.ship', 'credentials.json');
    expect(existsSync(join(home, '.ship'))).toBe(false);

    try {
      let ran = false;
      const { lock } = await withCredentialLock(
        credentialsPath,
        { clock: fakeClock() },
        () => {
          ran = true;
          return Promise.resolve('ok');
        },
      );

      // The assertion that would have failed before the fix. `acquired: false`
      // means the command proceeded UNLOCKED after burning its whole budget —
      // which is the documented fallback, and is exactly why this failure was
      // invisible: nothing errored, it just quietly stopped protecting anything.
      expect(lock.acquired, 'a missing ~/.ship must be created, not waited on').toBe(true);
      expect(lock.brokeStaleLock).toBe(false);
      expect(ran).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('releases the lock afterwards, so a second login is not blocked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'l19-lock-'));
    const credentialsPath = join(home, '.ship', 'credentials.json');

    try {
      await withCredentialLock(credentialsPath, { clock: fakeClock() }, () =>
        Promise.resolve(null),
      );
      expect(existsSync(lockPathFor(credentialsPath))).toBe(false);

      const second = await withCredentialLock(credentialsPath, { clock: fakeClock() }, () =>
        Promise.resolve(null),
      );
      expect(second.lock.acquired).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still refuses a lock someone else genuinely holds', async () => {
    // The fix must not have turned the mutual exclusion off. `recursive: true`
    // on the lock directory itself would succeed unconditionally and look
    // identical from the outside — this is the test that tells them apart.
    const home = mkdtempSync(join(tmpdir(), 'l19-lock-'));
    const credentialsPath = join(home, '.ship', 'credentials.json');

    try {
      let inner: Awaited<ReturnType<typeof withCredentialLock<null>>> | null = null;
      await withCredentialLock(credentialsPath, { clock: fakeClock() }, async () => {
        // Re-entered while the outer call still holds the lock.
        inner = await withCredentialLock(credentialsPath, { clock: fakeClock() }, () =>
          Promise.resolve(null),
        );
        return null;
      });

      expect(inner).not.toBeNull();
      expect(inner!.lock.acquired, 'a held lock must not be handed out twice').toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('F121 — a pending sleep must hold the process open', () => {
  it('realClock.sleep keeps a referenced timer', async () => {
    // Asked of the runtime rather than measured: `getActiveResourcesInfo()`
    // lists only handles that KEEP THE LOOP ALIVE, so an unref'd timer is
    // absent from it by definition. No wall-clock reasoning, no flake.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const pending = realClock.sleep(1);
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    expect(
      during,
      'an unref\'d sleep lets Node exit mid-command — `ship login` exited 0 having done nothing',
    ).toBeGreaterThan(before);

    await pending;
  });

  it('resolves, so nothing hangs on the fix either', async () => {
    // The opposite failure: a timer that is referenced and never fires would
    // wedge every command instead of ending it early.
    await expect(realClock.sleep(1)).resolves.toBeUndefined();
  });
});
