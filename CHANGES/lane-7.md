# Lane 7 — Accessibility

Category 7. Developer documentation per Implementation Rule 8 (p.9), reasoning and
tradeoffs per Rule 9. Kept in `CHANGES/lane-7.md` rather than the root `CHANGES.md`,
which several lanes edit concurrently.

Target, verbatim (p.7):

> Achieve a Lighthouse accessibility score improvement of 10+ points on the lowest-scoring
> page, or fix all Critical/Serious violations on the 3 most important pages. Provide
> before/after Lighthouse reports or axe scan output as evidence.

**Both routes are met.** The claim is made on Target B and axe output; Target A is reported
as corroboration only, for the reason in "Why not Lighthouse" below.

---

## Result

Same script both sides, same seeded volume, same machine, taken under
`scripts/measure-lock.sh`:

```bash
docs/audit/scripts/measure-a11y.py
```

| WCAG 2.1 A/AA + Section 508 | Before | After | Δ |
|---|---:|---:|---:|
| Critical nodes | 15 | **1** | −93% |
| Serious nodes | 54 | **9** | −83% |
| **Critical + Serious nodes** | **69** | **10** | **−85.5%** |
| Routes with zero Critical/Serious | 10 of 18 | **16 of 18** | |

Raw output: before `docs/audit/raw/cat7-phase2-before.json` (committed in `16496ac`,
before any fix landed), after `docs/audit/raw/cat7-phase2-after.json`.

### Which "before" this is, and which it is not

**The audit reported 34 Critical / 65 Serious. That is not the number above, and using it
here would overstate the result.** The audit scan was taken on a different day at a
different seed volume. 61 of its colour-contrast nodes are 54 at the frozen Phase 2
volume, because several failing elements only render with enough data behind them.

Rule 1 asks for before and after under identical conditions, so the pair reported here is
lane 7's own before-scan against lane 7's own after-scan — same volume, same script, same
box. The audit figure is the right one for describing the codebase as found; it is the
wrong one for measuring this change.

### Per page

| Page | Before C/S | After C/S |
|---|---:|---:|
| workspace settings | **10 / 0** | **0 / 0** |
| projects list | 0 / 16 | **0 / 0** |
| my-week | 0 / 15 | 0 / 9 |
| dashboard | 0 / 14 | **0 / 0** |
| issue document | 0 / 3 | **0 / 0** |
| weekly plan document | 1 / 3 | **1 / 0** |
| sprint document | 2 / 0 | **0 / 0** |
| admin (super admin) | 1 / 1 | **0 / 0** |
| project document | 1 / 0 | **0 / 0** |
| team allocation | 0 / 1 | **0 / 0** |
| team status | 0 / 1 | **0 / 0** |
| login · docs home · issues · programs · team directory · wiki · modal | 0 / 0 | 0 / 0 |

---

## The three pages, and why these three

p.7 leaves the selection to the author, so it is argued rather than asserted. Each of the
three had Critical or Serious violations before and has none after — pages that were
already clean would prove nothing.

**1. `/settings` — workspace settings.** The densest page in the app: 10 Critical nodes,
every one of them a `select-name` on the member-role dropdown. It is also the page that
makes the case for measuring with axe at all — it scored **100 in Lighthouse** while every
one of those controls was unnamed. Administering who can do what in a workspace is the
highest-consequence screen here, and it was the least usable.

**2. `/admin` — super-admin dashboard.** The lowest Lighthouse score in the app (88) and
the only `button-name` Critical. Highest privilege in the product.

**3. `/documents/{issue}` — issue document editor.** The most-used screen in a project
tool. Its 3 Serious nodes were contrast failures on the editor chrome, which is text a user
reads continuously rather than glances at once.

---

## What changed

Five scoped commits (Rule 11), grouped by fix type.

### 1. `1be2b06` — names for unlabeled and duplicate-labeled controls

W7-4 / W7-12 / `button-name`. Three shapes of one defect: controls with no accessible name
(`WorkspaceSettings` member-role `<select>`, `WeekSidebar` sprint status, `AdminDashboard`
back button), and controls whose names were present but **identical on every row** — 52×
"Delete document", 52× "Add sub-document".

No scanner catches the second kind, because the controls are not unnamed, they are
indistinguishable. A user cannot tell which document a Delete destroys from the control
itself. Fixed with `aria-label` carrying the row's subject.

**Tradeoff.** `WeekSidebar`'s `aria-label="Status"` duplicates the visible `PropertyRow`
label, which is mild redundancy in the ear. The non-redundant fix is an `id`/`htmlFor`
contract on `PropertyRow` — component logic this lane does not own. Redundant beats
nameless.

### 2. `ef29e8b` — 284 decorative SVGs marked `aria-hidden`

W7-13, the highest-leverage fix in the category and the one **automated tooling never
found**. axe checks that the *button* has a name, and it does. The child `<svg>` does not,
so each was its own node with role "image" and an empty name.

A human running real VoiceOver found it. With mouse-following on — the ordinary way a
sighted screen-reader user targets a control — landing on the row read the document name,
but landing on the trash icon itself announced only:

```
image
```

That includes the delete control. Applied by script so the sweep is reproducible rather
than 284 hand edits. Verified: 286 inline SVGs, 0 now exposed.

`aria-hidden` and not a `<title>`: none of these is content. `web/src` has zero `<title>`
children, and every icon sits inside a named control or beside its own text label. Hiding
it removes a duplicate node, not information.

### 3. `ee7ce88` — every child of `role="tree"` is a `treeitem`

`aria-required-children` (critical) + `listitem` (serious). Two `<li>` children of the
sidebar tree carried no role: the "N more…" overflow link and the empty state.

**Why this is invisible at the seeded volume, which is the more useful finding.** The
overflow `<li>` only renders above `SIDEBAR_ITEM_LIMIT = 10` root documents. The frozen
baseline has 7, so axe reports 0 violations on `/docs`. This is the same threshold effect
as W7-6, where the repo's existing e2e accessibility suite passes on real defects because
its fixture never crosses the limit. Measured both ways.

**Tradeoff.** "N more…" is a navigation link, not a document, so calling it a `treeitem`
is a semantic stretch. Moving it outside the `<ul>` restructures the component and drops
the link out of the tree the user is traversing. `aria-live="polite"` was left in place
despite the audit flagging it as over-announcing, because
`e2e/accessibility-remediation.spec.ts:1053` asserts it exists and `e2e/` is out of scope.

### 4. `dc2f490` — `aria-controls` pointing at nothing

W7-5, `aria-valid-attr-value` (critical). `TabBar` set `aria-controls={`tabpanel-${id}`}`
on every tab. `role="tabpanel"` occurs **0 times** in `web/src` and no element declares an
id of that shape, so every tab pointed at nothing. Removed rather than inventing panels —
wiring a real tab/tabpanel relationship means changing every consumer.

**Still open, and not fixed here:** the tablist has no arrow-key handling, so the widget
declares a keyboard model it does not implement (0 of 4 composite widgets respond to arrow
keys). That is a behaviour change, not an attribute change.

### 5. `9bc3339` — contrast: split the accent token, drop opacity-modified text

W7-1 + W7-2, 54 nodes from 16 colour pairs and two root causes.

`accent` was `#005ea2`, the USWDS logo blue — designed for white backgrounds — used as
text on `#0d0d0d`. Measured **2.55–2.89:1** where 4.5:1 is required, across 24 nodes and 78
`text-accent` class names: active nav, selected tabs, inline links. The highest-signal text
on the page was the least readable, and the comment directly above the block asserted the
opposite: *"All colors meet WCAG 2.1 AA contrast requirements."*

**Fixed by splitting the utility, not the token.** Tailwind's `textColor` key overrides
`text-*` independently of `bg-*`, so `text-accent` now resolves to `#2491ff` (6.08:1) while
`bg-accent` stays `#005ea2`. That matters: white on `#005ea2` is 6.73:1, so simply
lightening the token would have broken all 66 filled controls. One config edit instead of
78 class-name rewrites.

Also: 22 opacity-modified text utilities became solid tokens (`text-muted/50` composites to
`#4c4c4c`, 2.26:1), and `muted` was raised `#8a8a8a` → `#9e9e9e` — the old value cleared
4.5:1 against `background` but had never been checked against a *raised* surface, where it
measured 4.38:1.

**Tradeoff.** Secondary text is now slightly brighter, so the muted/foreground hierarchy is
flatter. That is the cost of AA on a near-black background; there is no room below `#9e9e9e`
that still clears 4.5:1 on a raised surface.

### 6. `3f3f3bd` — regression tests (Rule 3)

`web/src/styles/a11y-invariants.test.ts`. Verified against the pre-fix commit `767aa2f`:
**7 of 12 assertions fail there**, with the exact ratios the audit measured.

Source-level invariants rather than runtime checks, deliberately. W7-6 established that
`e2e/accessibility.spec.ts` passes on these defects because it runs axe against a fixture
below the data threshold, so the offending markup never renders. A source invariant has no
volume threshold to fall under, and the contrast test computes WCAG relative luminance from
`tailwind.config.js` itself — it fails the moment a token is edited.

The test also asserts white stays legible on `bg-accent`. That is what makes the token
split a checked constraint rather than a comment.

---

## What is still open

Reported rather than dropped.

| Where | Rule | Nodes | Status |
|---|---|---:|---|
| `/my-week` | `color-contrast` | 9 | **ours, not fixed** |
| weekly plan document | `aria-allowed-attr` | 1 | third-party |

**`/my-week`.** `MyWeekPage.tsx:339` applies `opacity-40` to future-day rows. The token
itself is compliant — `#9e9e9e` is 6.41:1 — but the *container's* opacity composites it to
`#474747`, 2.09:1. Commit `9bc3339` removed 22 opacity modifiers on *text* utilities and
missed this one because it is on the parent element, not the text. The lesson generalises:
auditing `text-*/NN` finds text-level opacity and cannot find container-level opacity.

**Weekly plan document.** `<div aria-expanded="false">` inside `.tiptap-wrapper` is emitted
by TipTap's own `EditorContent`; `Editor.tsx:981` renders `<EditorContent editor={editor} />`
and passes no ARIA. `aria-expanded` is not allowed on a roleless `div`. Fixing it means
either stripping a vendor attribute from the DOM after mount or assigning a role the element
does not have. Documented rather than worked around.

Also still open from the audit, out of this lane's scope: arrow-key navigation in composite
widgets (0 of 4), and `PropertyRow`'s missing `id`/`htmlFor` contract.

---

## Why not Lighthouse

p.7 accepts either evidence. Target A is in fact met — `/admin`, the lowest-scoring page,
went **88 → 100**, and sprint and wiki documents went 91 → 100 — but the claim is made on
axe, because **Lighthouse cannot demonstrate this work on this app.** It snapshots the DOM
before react-query resolves, so:

- at baseline, `/settings` scored **100** with **10 Critical** violations open
- after these fixes, the weekly plan document scores **100 on desktop and mobile** while
  still carrying an open Critical

A Lighthouse before/after would have shown a fix that did not happen and missed one that
did. The scores are reported for completeness in
`docs/audit/raw/cat7-phase2-after-lighthouse.json`.

---

## How to run, test, and roll back (Rule 8)

```bash
# measure (dev servers must already be running, seeded, on :5173 / :3000)
pnpm dev
scripts/measure-lock.sh acquire lane-7 1800
docs/audit/scripts/measure-a11y.py
scripts/measure-lock.sh release lane-7

# the regression tests
pnpm --filter @ship/web exec vitest run src/styles/a11y-invariants.test.ts

# full gate
pnpm type-check && pnpm lint && pnpm build
pnpm test
pnpm --filter @ship/web exec vitest run
```

**Roll back** any single fix by reverting its commit; they are independent and touch
disjoint files, except that `3f3f3bd`'s tests assert `9bc3339`'s tokens and must be
reverted with it.

The one change with visual blast radius is `9bc3339` — it moves two colour tokens, so it
affects every screen. Reverting it restores the previous palette and re-opens 54 nodes.
