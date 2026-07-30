#!/usr/bin/env node
/**
 * W6-1 evidence helper — temporarily make a top-level page throw during render.
 *
 * W6-1 is "six top-level routes have no error boundary", and the only way to show
 * the before/after behaviour in a real browser is to actually make one of those
 * pages throw. Nothing in the app throws on demand, and adding a permanent test
 * hook to a production page would be worse than the bug, so this script injects a
 * throw, leaves a `.w6-1-bak` copy beside the file, and puts it back on --revert.
 *
 * The injected throw is gated on `?__boom` in the URL so the app is still usable
 * while the injection is in place.
 *
 *   node docs/audit/scripts/inject-render-error.mjs --apply
 *   node docs/audit/scripts/capture-w6-1.mjs --label before ...
 *   node docs/audit/scripts/inject-render-error.mjs --revert
 *
 * Never commit the injected state: `--revert` restores byte-for-byte, and
 * `git status` must be clean for these files afterwards.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The routes p.6/W6-1 lists as unprotected, with the component that renders them. */
const TARGETS = [
  { route: '/feedback/:programId', file: 'web/src/pages/PublicFeedback.tsx', fn: 'export function PublicFeedbackPage(' },
  { route: '/setup', file: 'web/src/pages/Setup.tsx', fn: 'export function SetupPage(' },
  { route: '/login', file: 'web/src/pages/Login.tsx', fn: 'export function LoginPage(' },
  { route: '/invite/:token', file: 'web/src/pages/InviteAccept.tsx', fn: 'export function InviteAcceptPage(' },
  { route: '/admin', file: 'web/src/pages/AdminDashboard.tsx', fn: 'export function AdminDashboardPage(' },
  { route: '/admin/workspaces/:id', file: 'web/src/pages/AdminWorkspaceDetail.tsx', fn: 'export function AdminWorkspaceDetailPage(' },
];

const MARKER = '/* __W6_1_INJECTED__ */';
const THROW = `${MARKER} if (typeof window !== 'undefined' && window.location.search.includes('__boom')) { throw new Error('W6-1 injected render error'); }`;

const mode = process.argv.includes('--revert') ? 'revert' : 'apply';

for (const t of TARGETS) {
  const path = join(ROOT, t.file);
  const bak = `${path}.w6-1-bak`;

  if (mode === 'revert') {
    if (!existsSync(bak)) { console.log(`skip (no backup) ${t.file}`); continue; }
    writeFileSync(path, readFileSync(bak, 'utf8'));
    unlinkSync(bak);
    console.log(`reverted ${t.file}`);
    continue;
  }

  const src = readFileSync(path, 'utf8');
  if (src.includes(MARKER)) { console.log(`already injected ${t.file}`); continue; }

  const idx = src.indexOf(t.fn);
  if (idx === -1) { console.error(`FAILED to find "${t.fn}" in ${t.file}`); process.exitCode = 1; continue; }

  // Insert immediately after the component's opening brace.
  const brace = src.indexOf('{', idx + t.fn.length - 1);
  if (brace === -1) { console.error(`FAILED to find body brace in ${t.file}`); process.exitCode = 1; continue; }

  writeFileSync(bak, src);
  writeFileSync(path, `${src.slice(0, brace + 1)}\n  ${THROW}\n${src.slice(brace + 1)}`);
  console.log(`injected ${t.file}  (${t.route})`);
}

console.log(mode === 'apply'
  ? '\nInjected. Visit any of the routes above with ?__boom to trigger the throw.'
  : '\nReverted. `git status` should be clean for these files.');
