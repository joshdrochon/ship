/**
 * PF-558, second fixture — `@ship/shared` is in fence 3's group list too.
 *
 * The first fixture proves a deep relative path into `api/src/` is caught. This
 * one proves the WORKSPACE PACKAGE spelling is caught as well, which is the
 * version someone reaches for honestly: `@ship/shared` looks like a types-only
 * package and feels harmless. It is not — an integration that shares types with
 * the server is an integration that cannot be published, and the whole claim
 * being made about `integrations/**` is that it is a stranger.
 *
 * `pnpm lint` MUST reject this with `BOUNDARY (integrations → server)`.
 * NOTHING IMPORTS THIS FILE.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Document } from '@ship/shared';

export type Violation = Document;
