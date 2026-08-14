// NEGATIVE FIXTURE (PF-718) — integrations/drills/refresh-rotation.
//
// TWO directories deep, which is the shape `integrations/*` misses. The drills
// are a group rather than a package, so anything that enumerates one level of
// `integrations/` — a lint glob, a CI matrix, a manifest scanner — skips both
// drills silently. This fixture fails only if the glob is `integrations/**`.
//
// The violation itself is the one a rotation drill is most tempted by: reading
// the server's own token table to "check" what the platform did, instead of
// asserting it over HTTP the way a subscriber has to.
import { rotateRefreshToken } from '../../../../api/src/platform/oauth/rotation.js';

export const violation = rotateRefreshToken;
