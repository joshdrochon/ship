// NEGATIVE FIXTURE (PF-718) — integrations/drills/idempotency.
//
// Two escapes in one file. `.cts` is the CommonJS half of the extension gap the
// Slack fixture covers for `.mts`; and the import targets `api/dist` rather than
// `api/src`, which is the version that survives a reviewer who greps only for
// the source path. A built artifact is the same server code.
import { deriveIdempotencyKey } from '../../../../api/dist/platform/webhooks/signer.js';

export const violation = deriveIdempotencyKey;
