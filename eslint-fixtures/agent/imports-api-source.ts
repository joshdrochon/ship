// NEGATIVE FIXTURE (L23 PF-692) — must fail `no-restricted-imports`.
//
// The two shapes a real violation takes, and the second is the one that would
// actually happen: `agent/` and `api/` sit side by side in the workspace, so a
// deep-relative path is a shorter thing to type than the SDK call it replaces.
//
// Both are the same violation. p.11 makes this rule the difference between "the
// agent is a platform citizen" being true and being aspirational.
import { pool } from '@ship/api';
import { createApp } from '../../api/src/app.js';

export const violation = [pool, createApp];
