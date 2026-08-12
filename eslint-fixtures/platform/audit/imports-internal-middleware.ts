// NEGATIVE FIXTURE (PF-010) — must fail `no-restricted-imports`.
// The internal session/CSRF stack does not apply to /api/v1. A platform module
// reaching for it would silently inherit Part 1's auth assumptions.
import { authMiddleware } from '../../../api/src/middleware/auth.js';

export const violation = authMiddleware;
