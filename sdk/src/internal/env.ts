/**
 * Runtime-agnostic environment access.
 *
 * `@ship/sdk` ships one core that runs in Node AND in a browser (PF-507), so it
 * cannot reference `process` as a free identifier: in a bundle without a Node
 * shim that is a `ReferenceError` at module scope, not a missing value. Reading
 * it off `globalThis` with an optional chain is the only form that is correct in
 * both runtimes and needs no `@types/node` at the call site.
 *
 * Deliberately NOT a dependency on `dotenv` or similar — PF-496/PF-514: the
 * production `dependencies` list stays empty.
 */

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

/**
 * Reads an environment variable, or `undefined` where there is no environment.
 *
 * Empty string is treated as unset. A caller that exports `SHIP_BASE_URL=` in a
 * shell means "I did not set this", and resolving it to `''` would fail later
 * inside `new URL('')` with a message that names neither the variable nor the
 * SDK.
 */
export function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  const value = proc?.env?.[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
