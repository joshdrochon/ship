# Lane 7 — Accessibility Compliance

You own one ShipShape category. Five other agents are working other lanes in sibling
worktrees right now. Stay inside your boundary.

## Target, verbatim (p.7)

> Achieve a Lighthouse accessibility score improvement of 10+ points on the lowest-scoring
> page, or fix all Critical/Serious violations on the 3 most important pages. Provide
> before/after Lighthouse reports or axe scan output as evidence.

## Take Target B. Lighthouse cannot demonstrate this work.

The audit established that Lighthouse under-reports badly on this app: it snapshots the
DOM before react-query resolves, so `/issues` scores **100** while having only 2 headings,
and `/settings` scores **100** with **24 outstanding violations**. A Lighthouse before/after
literally cannot show the fix. Use axe output as your evidence.

## Numbers

| | |
|---|---|
| Total Critical + Serious | **34 Critical / 65 Serious** |
| Lighthouse (unreliable here) | 88–100 across 17 pages, median 96, lowest `/admin` 88 |

Measuring command, both sides:

```bash
docs/audit/scripts/measure-a11y.py          # axe + keyboard + Lighthouse
```

Pick the **3 most important pages** and justify the choice in your writeup — p.7 leaves the
selection to you, so an unjustified pick is a gap a grader will notice.

## Routes the audit already identified

- **W7-13 is one attribute across 284 SVGs.** Single highest-leverage fix in the category.
- **W7-4 and W7-12 share a single fix.**
- `/settings` has 24 violations despite scoring 100 in Lighthouse — a strong candidate for
  one of your three pages precisely because the automated score misses it.

## Measurement lock

axe runs a real browser per page. Take the lock so your scan is not competing with five
other agents, and so you are not the reason another lane's benchmark is wrong:

```bash
scripts/measure-lock.sh acquire lane-7 1800
trap 'scripts/measure-lock.sh release lane-7' EXIT
docs/audit/scripts/measure-a11y.py > after.json
scripts/measure-lock.sh release lane-7
```

The `trap` is not optional.

## You own

JSX attributes across `web/src/`, `web/src/index.css`, USWDS overrides.

**Off limits: component logic.** You are adding labels, roles, and contrast fixes — not
restructuring components. `web/src/components/UnifiedEditor.tsx` in particular is contested
ground; leave its logic alone. Also off limits: `api/`, `terraform/`, `e2e/`, dependency
changes, and `CHANGES.md` (write `CHANGES/lane-7.md`).

## Done means

- [ ] All Critical **and** Serious violations cleared on your 3 chosen pages
- [ ] The 3 pages named, with a stated reason they are "most important"
- [ ] Before/after axe output committed under `docs/audit/raw/`
- [ ] `pnpm --filter @ship/web exec vitest run` (174) passes
- [ ] `pnpm test` (461) passes
- [ ] `pnpm type-check`, `pnpm lint`, `pnpm build` exit 0
- [ ] No visual regression that breaks a layout — a contrast fix that makes text
      unreadable against its new background is not a fix

## A caution

An `aria-label` that restates the visible text adds noise for a screen reader user without
adding information. The audit ran real VoiceOver over this app and the protocol is at
`docs/audit/voiceover-protocol.md` — read it before mass-applying labels. Passing axe and
being usable are not the same thing, and the brief is asking you to verify a compliance
claim, not to satisfy a linter.

## Deliverables

1. Separately scoped commits (Rule 11, p.9) — group by fix type, not one giant commit.
2. `CHANGES/lane-7.md`: what changed, why, tradeoffs (Rule 9, p.9), the page selection
   rationale, and the before/after violation counts.

## Rules

`docs/audit/implementation-rules.md` — all 11, verbatim.

Report back with the violation counts per page, the command, and anything blocked.
