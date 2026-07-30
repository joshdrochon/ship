import { describe, it, expect } from 'vitest';
import { isRetryableConnectError } from './client.js';

/**
 * Rule 7, database surface. The retry added to `pool.query` covers only failures
 * where the statement provably never reached PostgreSQL, because `pool.query`
 * cannot distinguish "the write never ran" from "the write committed and then the
 * socket broke" — retrying the second would apply a document update twice.
 *
 * These tests pin that boundary down. They are the guard against someone later
 * widening the predicate to "any connection-ish error" and quietly turning a
 * safe retry into a double-write.
 */
describe('database connect retry predicate (Rule 7)', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it.each([
    ['ECONNREFUSED', 'PostgreSQL is not accepting connections yet'],
    ['ENOTFOUND', 'DNS for the database host has not resolved'],
    ['EHOSTUNREACH', 'network route to the database is down'],
    ['ETIMEDOUT', 'connection attempt timed out'],
    ['57P03', 'cannot_connect_now: server is still starting up'],
    ['53300', 'too_many_connections: at the connection limit'],
    ['08001', 'sqlclient_unable_to_establish_sqlconnection'],
    ['08004', 'sqlserver_rejected_establishment_of_sqlconnection'],
    ['08006', 'connection_failure'],
  ])('retries %s (%s)', (code) => {
    expect(isRetryableConnectError(err(code))).toBe(true);
  });

  it('retries the pg-pool acquisition timeout, which has no code', () => {
    expect(isRetryableConnectError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it.each([
    ['23505', 'unique_violation — the statement ran and was rejected'],
    ['23503', 'foreign_key_violation — the statement ran'],
    ['42601', 'syntax_error — retrying cannot help'],
    ['22021', 'invalid byte sequence for encoding UTF8 — bad input, not transient'],
    ['57014', 'query_canceled by statement_timeout — the statement DID run'],
    ['40001', 'serialization_failure — needs the caller to redo its transaction'],
    ['ECONNRESET', 'socket died mid-flight; the write may have committed'],
    ['EPIPE', 'write failed after the statement was sent'],
  ])('does not retry %s (%s)', (code) => {
    expect(isRetryableConnectError(err(code))).toBe(false);
  });

  it.each([[null], [undefined], ['a string'], [42]])('treats %o as not retryable', (value) => {
    expect(isRetryableConnectError(value)).toBe(false);
  });

  it('does not retry an error with no code and an unrelated message', () => {
    expect(isRetryableConnectError(new Error('relation "documents" does not exist'))).toBe(false);
  });
});
