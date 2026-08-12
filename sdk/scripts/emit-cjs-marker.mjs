/**
 * The SDK's root package.json says "type": "module". Node applies that to every
 * .js file in the package, including the CommonJS build in dist/cjs/ — which it
 * would then try to parse as ESM and fail on the first `require`.
 *
 * A nested package.json overrides the type for that subtree. This is the
 * standard dual-package layout; it is written here rather than committed so it
 * can never drift from what the build actually emits.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distCjs = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cjs');
if (!existsSync(distCjs)) mkdirSync(distCjs, { recursive: true });
writeFileSync(join(distCjs, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
