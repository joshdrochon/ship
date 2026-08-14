/**
 * PF-722 negative fixture, HARNESS tier.
 *
 * The tier split (see `scripts/check-integration-credentials.mjs`) lets a test
 * file name `DATABASE_URL` and `api/src`, because a harness legitimately hands
 * an operator's credential to an operator's subprocess and legitimately names
 * the path it is asserting nobody imports. This fixture pins where the
 * relaxation STOPS: a harness that imports the driver itself is still a
 * violation, because at that point the integration's own test process is the
 * thing holding privileged access.
 *
 * If the tier split ever widens into "tests may do anything", this file stops
 * being caught and the check fails on it.
 */
import { Client } from 'pg';

export function connect(): Client {
  return new Client({ connectionString: 'postgresql://ship:ship@localhost:5432/ship' });
}
