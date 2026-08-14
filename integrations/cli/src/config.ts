/**
 * PF-559 — ONE instance-URL resolver, and it is the SDK's.
 *
 * Order, highest first:
 *
 *   1. `--base-url <url>`        the flag, most local and most deliberate
 *   2. `SHIP_BASE_URL`           how a CI job and a container are configured
 *   3. the value persisted at    so `ship login --base-url <deployed>` means no
 *      login time                later command needs the flag (PF-559's clause)
 *   4. L17's published default   `resolveBaseUrl()` with nothing — PF-491 owns it
 *
 * Steps 1, 2 and 4 are NOT re-implemented here. They are `resolveBaseUrl` from
 * `@ship/sdk`, called with the right argument. This module's only original
 * contribution is step 3, which the SDK cannot know about because the SDK does
 * not own `~/.ship/`. That matters for PF-494: a base URL carrying a path
 * prefix (`https://host/ship`) must survive, and it survives because the
 * SDK's `buildRequestUrl` is the only thing that joins a path onto it. A grep
 * over `src/**` finds no `/api/v1` literal in this package for the same reason.
 */
import {
  BASE_URL_ENV_VAR,
  resolveBaseUrl,
  type BaseUrlSource,
  type ResolvedBaseUrl,
} from '@ship/sdk';
import { readSettings, type CliSettings } from './settings.js';

/** `SHIP_CLIENT_ID`'s CLI-side spelling, mirroring the SDK's own env var. */
export const CLIENT_ID_ENV_VAR = 'SHIP_CLIENT_ID';

/** Where a base URL came from — the SDK's three, plus this CLI's persisted one. */
export type CliBaseUrlSource = BaseUrlSource | 'saved';

export interface ResolvedInstance {
  baseUrl: string;
  source: CliBaseUrlSource;
}

export interface ResolveInstanceInput {
  /** `--base-url`, when the user passed one. */
  flag?: string | undefined;
  /** Injected so the table test does not mutate the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected so the table test does not read the real `~/.ship/config.json`. */
  settings?: CliSettings | null;
}

/**
 * The whole chain, in one place.
 *
 * The persisted value is consulted only when neither the flag nor the
 * environment named one — a saved instance is a convenience, and a flag or an
 * exported variable is an instruction.
 */
export function resolveInstance(input: ResolveInstanceInput = {}): ResolvedInstance {
  const env = input.env ?? process.env;
  const flag = input.flag?.trim();

  if (flag !== undefined && flag !== '') {
    const resolved: ResolvedBaseUrl = resolveBaseUrl(flag);
    return { baseUrl: resolved.url, source: 'option' };
  }

  const fromEnv = env[BASE_URL_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    // Handed to the SDK as an explicit argument rather than left to be read from
    // `process.env` inside it, so an injected `env` in a test is honoured and
    // the source is reported accurately.
    return { baseUrl: resolveBaseUrl(fromEnv).url, source: 'env' };
  }

  const settings = input.settings !== undefined ? input.settings : readSettings();
  if (settings?.baseUrl !== undefined && settings.baseUrl.trim() !== '') {
    return { baseUrl: resolveBaseUrl(settings.baseUrl).url, source: 'saved' };
  }

  // Nothing supplied: the SDK's own published default, validated by the SDK.
  const resolved = resolveBaseUrl();
  return { baseUrl: resolved.url, source: resolved.source };
}

export interface ResolveClientIdInput {
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  settings?: CliSettings | null;
}

/**
 * `--client-id` → `SHIP_CLIENT_ID` → the id persisted at login.
 *
 * Returns `null` rather than throwing: only `ship login` genuinely needs one
 * up front, and the SDK's own error for a missing client id (which names the
 * environment variable) is better than anything this file would write.
 */
export function resolveClientId(input: ResolveClientIdInput = {}): string | null {
  const env = input.env ?? process.env;
  const flag = input.flag?.trim();
  if (flag !== undefined && flag !== '') return flag;

  const fromEnv = env[CLIENT_ID_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();

  const settings = input.settings !== undefined ? input.settings : readSettings();
  if (settings?.clientId !== undefined && settings.clientId.trim() !== '') {
    return settings.clientId.trim();
  }
  return null;
}
