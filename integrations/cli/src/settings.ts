/**
 * `~/.ship/config.json` — the instance and app `ship login` was pointed at.
 *
 * NOT the credential. The credential is `~/.ship/credentials.json` and it
 * belongs to the SDK's `FileTokenStore` (PF-506), which is 0600 and atomic.
 * This file holds a base URL and a client id — neither is a secret, both are
 * printed in the README — and keeping them out of the credential file means
 * `ship login --base-url` does not have to rewrite a token to record a URL.
 *
 * PF-559's clause: *"`ship login --base-url <deployed>` persists it so no later
 * command needs the flag."* That is the only reason this file exists. There is
 * no profile concept and no multi-instance switching — the PRD names neither,
 * and L19's notes record that as deliberately not invented.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Same 0700 as the credential directory — they share it. */
const CONFIG_DIR_MODE = 0o700;

/** 0600 for symmetry with the credential file, not because this is secret. */
const CONFIG_FILE_MODE = 0o600;

export interface CliSettings {
  /** The instance `ship login` was pointed at. */
  baseUrl?: string;
  /** The OAuth app `ship login` authenticated as. */
  clientId?: string;
}

export function defaultSettingsPath(): string {
  return join(homedir(), '.ship', 'config.json');
}

/**
 * Reads the file, or `null` for every failure.
 *
 * Same posture as `FileTokenStore.load` (PF-508): unreadable, unparseable and
 * wrong-shaped are all "there is no saved instance", because the caller's next
 * move — fall through to the SDK's default — is identical for all three.
 */
export function readSettings(path: string = defaultSettingsPath()): CliSettings | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const settings: CliSettings = {};
  if (typeof candidate.baseUrl === 'string') settings.baseUrl = candidate.baseUrl;
  if (typeof candidate.clientId === 'string') settings.clientId = candidate.clientId;
  return settings;
}

/**
 * Merges and writes, atomically.
 *
 * Merge rather than replace: `ship login --base-url X` then
 * `ship login --client-id Y` should leave both set, and a caller passing one
 * field has said nothing about the other.
 */
export function writeSettings(
  update: CliSettings,
  path: string = defaultSettingsPath(),
): CliSettings {
  const merged: CliSettings = { ...(readSettings(path) ?? {}), ...update };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: CONFIG_DIR_MODE });

  // Same temp-file-then-rename as the credential store, for the same reason: a
  // crash mid-write must leave the old file or the new one, never a truncated
  // one that reads as "no saved instance" and silently sends the next command
  // to the published default.
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CONFIG_FILE_MODE,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort; never masks the real failure.
    }
    throw error;
  }
  return merged;
}
