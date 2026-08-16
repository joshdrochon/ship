# @ship/sdk

The typed client for Ship's public API. Four resource clients plus a list-only `audit`
client, OAuth helpers, an async-iterator paginator, a webhook verifier, and a discriminated
error union.

```ts
import { ShipClient } from '@ship/sdk';

const client = new ShipClient({ token });
const me = await client.me();

for await (const doc of client.documents.iterate()) {
  console.log(doc.title);          // cursors are handled internally
}
```

Device flow, for a CLI with no redirect URI:

```ts
const client = await ShipClient.deviceLogin({
  onUserCode: (code, verifyUrl) => console.log(`Enter ${code} at ${verifyUrl}`),
});
```

Webhook verification — one call, and it fails closed on a tampered body, a
missing `v1=`, or a timestamp outside the tolerance window (default 300 s):

```ts
import { verifyWebhook } from '@ship/sdk';

if (!verifyWebhook(headers, rawBody, signingSecret)) return res.status(400).end();
```

`DEFAULT_BASE_URL` points at the deployed instance. Resolution order is the
explicit `baseUrl` option, then `SHIP_BASE_URL` in the environment, then that
default.

## Publishing

**This package is `private: true` and has never been published.** PRD p.10 asks
for npm publishing to be *documented but not required* for the week, so this
section is the documentation, not a record of a release.

`publishConfig.access` is already `public`, and `files` is `["dist", "README.md"]`
so only build output and this file would ship — no sources, no tests, no
fixtures.

To actually publish, four things have to change, and the first is the one that
matters:

1. **Rename the package.** `@ship/*` is not a scope this project owns on the
   public registry. Publishing under a scope you do not control fails, and
   publishing under one you do while the workspace still says `@ship/sdk` means
   every internal import breaks. Pick the real name first and change it
   everywhere at once — `api/`, `agent/`, `integrations/*` and `web/` all import
   `@ship/sdk`.
2. **Drop `private: true`.** It exists to make an accidental `npm publish` a
   no-op, which is the correct default for a package that is not ready.
3. **Set a real version.** `0.1.0` is a placeholder. `sdk/src/stability.ts`
   already splits the surface into stable and pre-1.0 halves and
   `surfaceStability.test.ts` fails if a new export is in neither — that split
   is what a version number would have to honour, so read it before choosing
   one.
4. **Decide what `workspace:*` becomes.** Nothing in `dependencies` today, which
   is what keeps the install footprint at zero production dependencies — but
   check before publishing rather than assuming it stayed that way.

Then:

```bash
pnpm --filter @ship/sdk build      # dist/ is what ships; `files` limits it to that
pnpm --filter @ship/sdk size       # install-footprint budget, PRD p.9: < 250 KB gzipped
npm publish --access public        # from sdk/, after the four changes above
```

The size check is worth running first. It measures **gzip of unminified**
output as a deliberate upper bound — the repo has no resolvable minifier, and
minification only reduces — so the reported number is conservative rather than
flattering. If it is over budget, the published package is over budget too.

## What is stable

`sdk/src/stability.ts` is the machine-readable answer, and
`surfaceStability.test.ts` enforces that every export appears in exactly one
half. "Stable" there means the signature will not change during the submission
window, not a 1.0 compatibility promise — the package is `0.1.0` and private.
