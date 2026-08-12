# eslint-fixtures/ — negative fixtures for the PlugForge boundary rules

Every file in here is a **deliberate boundary violation**. They exist so the four
fences in `eslint.config.js` can be proven to fire, rather than assumed to.

A lint rule that never fires is indistinguishable from a lint rule that is
mis-globbed, shadowed by a later config object, or silently dropped when someone
reorders the flat config array. All four of those have shipped in real projects
with a green pipeline. PF-012 exists because of that.

- These files are in the top-level `ignores` of `eslint.config.js`, so a normal
  `pnpm lint` never sees them and the tree stays green.
- `pnpm lint:boundary` (`scripts/check-boundary-lint.mjs`) re-runs ESLint over
  each one with `--no-ignore` and asserts:
  1. the run **fails**, and
  2. the reported rule is `no-restricted-imports`, and
  3. the message contains the fence's own `BOUNDARY (...)` marker — so a fixture
     that fails for an unrelated reason (a syntax error, say) does not read as
     a passing test.
- The same script also checks the workspace-dependency half of the
  `integrations/` fence: `integrations/*/package.json` may declare no runtime
  dependency other than `@ship/sdk`.

The imports below do not resolve, and are not supposed to. ESLint's
`no-restricted-imports` matches the specifier text; nothing is loaded.

| Fixture | Fence | Ticket |
|---|---|---|
| `platform/api/v1/imports-internal-route.ts` | platform → routes | PF-009 |
| `platform/audit/imports-internal-middleware.ts` | platform → middleware | PF-010 |
| `integrations/imports-api-source.ts` | integrations → server | PF-011 |
| `sdk/imports-workspace-package.ts` | sdk → workspace | F24 |
