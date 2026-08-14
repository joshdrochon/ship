// NEGATIVE FIXTURE (PF-718) — integrations/slack, and the EXTENSION is the point.
//
// Fence 3's glob was `integrations/**/*.ts`. `.mts` is a file TypeScript compiles,
// Node executes and that glob does not match — so a Slack listener written as
// `handler.mts` could have imported the server tree and `pnpm lint` would have
// stayed green. This fixture fails only if the glob covers `.mts`.
import { pool } from '@ship/api';

export const violation = pool;
