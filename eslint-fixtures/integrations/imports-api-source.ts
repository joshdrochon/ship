// NEGATIVE FIXTURE (PF-011) — must fail `no-restricted-imports`.
// Two shapes of the same violation: the workspace package, and a deep-relative
// path into api/src that sidesteps package resolution entirely.
import { pool } from '@ship/api';
import { createApp } from '../../api/src/app.js';

export const violation = [pool, createApp];
