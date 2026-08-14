/**
 * PF-722 negative fixture. Every line below is a runtime privilege an external
 * developer could not hold, and NOT ONE of them trips ESLint fence 3 — which is
 * the whole reason `scripts/check-integration-credentials.mjs` exists alongside
 * the import rule rather than inside it.
 *
 * Never installed, never built, never imported. `eslint-fixtures/**` is in the
 * ignore list; this file is read as TEXT by the checker.
 */
import { Client } from 'pg';
import pgPool from 'pg/lib/pool.js';

export const connectionString = process.env.DATABASE_URL;
export const sessionSecret = process.env.SESSION_SECRET;

/** A path into the server tree, as a string rather than as an import. */
export const internalModule = './api/src/routes/documents.js';

export function privileged(): Client {
  void pgPool;
  void internalModule;
  return new Client({ connectionString });
}
