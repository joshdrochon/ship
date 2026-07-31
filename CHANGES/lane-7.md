# Lane 7 — Accessibility

Category 7. Developer documentation per Implementation Rule 8 (p.9), reasoning and
tradeoffs per Rule 9. Kept in `CHANGES/lane-7.md` rather than the root `CHANGES.md`,
which several lanes edit concurrently.

Target, verbatim (p.7):

> Achieve a Lighthouse accessibility score improvement of 10+ points on the lowest-scoring
> page, or fix all Critical/Serious violations on the 3 most important pages. Provide
> before/after Lighthouse reports or axe scan output as evidence.

**Both routes are met, and Target B is met past its own bar:** not 3 pages but **all 18
scanned routes** are at zero Critical and zero Serious. The claim is made on Target B and
axe output; Target A is reported as corroboration only, for the reason in "Why not
Lighthouse" below.

---

## Result

Same script every time, same seeded volume, same machine, taken under
`scripts/measure-lock.sh`:

```bash
docs/audit/scripts/measure-a11y.py
```

| WCAG 2.1 A/AA + Section 508 | Before | After Phase 2 | After F16 | Δ |
|---|---:|---:|---:|---:|
| Critical nodes | 15 | 1 | **0** | −100% |
| Serious nodes | 54 | 9 | **0** | −100% |
| **Critical + Serious nodes** | **69** | **10** | **0** | **−100%** |
| Routes with zero Critical/Serious | 10 of 18 | 16 of 18 | **18 of 18** | |

Raw output, all three from the same script over the same 18 routes and the same seeded
volume: before `docs/audit/raw/cat7-phase2-before.json` (committed in `16496ac`, before
any fix landed), after Phase 2 `docs/audit/raw/cat7-phase2-after.json`, after F16
`docs/audit/raw/cat7-f16-after.json` (`.txt` is the same run rendered as tables,
`cat7-f16-after-lighthouse.json` the Lighthouse side).

The last column closes F16 — the two violations Phase 2 left open and this file previously
listed under "What is still open". Both were ours. See "F16" under **What changed**.

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

| Page | Before C/S | After Phase 2 C/S | After F16 C/S |
|---|---:|---:|---:|
| workspace settings | **10 / 0** | 0 / 0 | **0 / 0** |
| projects list | 0 / 16 | 0 / 0 | **0 / 0** |
| my-week | 0 / 15 | 0 / 9 | **0 / 0** |
| dashboard | 0 / 14 | 0 / 0 | **0 / 0** |
| issue document | 0 / 3 | 0 / 0 | **0 / 0** |
| weekly plan document | 1 / 3 | 1 / 0 | **0 / 0** |
| sprint document | 2 / 0 | 0 / 0 | **0 / 0** |
| admin (super admin) | 1 / 1 | 0 / 0 | **0 / 0** |
| project document | 1 / 0 | 0 / 0 | **0 / 0** |
| team allocation | 0 / 1 | 0 / 0 | **0 / 0** |
| team status | 0 / 1 | 0 / 0 | **0 / 0** |
| login · docs home · issues · programs · team directory · wiki · modal | 0 / 0 | 0 / 0 | **0 / 0** |

No page regressed between the Phase 2 and F16 scans. Every route that was already at 0/0
is still at 0/0, and the two that were not are now.

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

**4. `/my-week` — the landing route.** Added by the F16 fix, and it answers the fair
objection to the three above: none of them is where a user *arrives*. `/my-week` is. It is
also the page with the second-highest Serious count at baseline (15 nodes). It went
0 Critical / 15 Serious → 0 / 9 → **0 / 0**.

With F16 closed the claim is no longer "3 of 18 pages" anyway — it is **18 of 18**, every
route the scan covers, including the landing route. The four above are the ones argued for
individually because each carried violations and each now carries none.

---

## What changed

Scoped commits (Rule 11), grouped by fix type. §1–6 are Phase 2; §7 is the F16 closeout.

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

### 7. F16 — the last 10 nodes: container opacity, and a vendor ARIA attribute we own

The two rows this file used to carry under "What is still open". **Both were ours**, and
the second was written up here as third-party. That was wrong; the correction is below.

**7a. `/my-week`, 9 serious `color-contrast` nodes → 0.** `MyWeekPage.tsx` applied
`opacity-40` to the future-day rows in Daily Updates. The palette was never the problem:
`#9e9e9e` on `#0d0d0d` is 7.25:1. But CSS `opacity` composites the *whole subtree*, so the
day name, the date and the "Upcoming" label all painted as `#474747` — **2.09:1**, which is
the exact ratio axe reported for all nine nodes.

Fixed by moving the de-emphasis onto the row **chrome** and leaving the text alone:
`isFuture && 'border-border/40 bg-surface/40'` in place of `isFuture && 'opacity-40'`.
`border-<token>/NN` is already how the rest of `web/src` expresses de-emphasis (13 existing
`border-border/50` sites), so this is the existing pattern rather than a new one.

*Why the previous pass missed it.* Commit `9bc3339` swept 22 opacity-modified **text**
utilities (`text-muted/50` and friends) and did not find this one, because it is not on the
text — it is on the parent. Auditing for `text-*/NN` structurally cannot find
container-level opacity. That is the generalisable lesson, and it is now a test.

*Tradeoff.* Future rows are less obviously "greyed out" than they were; the cue is now the
row outline rather than the whole row fading. That is the cost of keeping the labels
readable, and the labels are the part carrying the information.

*Honest caveat on the node count.* How many future-day rows `/my-week` renders depends on
what day the scan runs — five on a Monday, none on a Sunday. The before-scan saw three
(9 nodes = 3 rows × 3 labels); the after-scan saw two. So "9 → 0" is not strictly
row-for-row, and the row-count-independent measurement is the one to trust:
`docs/audit/raw/cat7-f16-myweek-composited.json` reads the *computed* style off the live
page and records `ancestorOpacityProduct: 1` and **7.25:1** on every label in every future
row, against 0.4 and 2.09:1 before.

**7b. Weekly plan document, 1 critical `aria-allowed-attr` node → 0.** The offending
element is `<div aria-expanded="false">` — the `EditorContent` wrapper inside
`.tiptap-wrapper`. This file previously called it a vendor attribute emitted by TipTap and
unfixable without DOM surgery. **That was wrong.** The attribute comes from `tippy.js`,
via ARIA options *we* pass:

- TipTap's `BubbleMenuPlugin` creates its tippy with `interactive: true` and uses the
  editor element as the tippy **reference** (`extension-bubble-menu/dist/index.js:134`).
- tippy's `aria.expanded` default is `'auto'`, which resolves to `props.interactive`
  (`tippy.js/dist/tippy.cjs.js:440`), so it stamps `aria-expanded` on the reference
  (`:810`).
- `Editor.tsx` already passes `tippyOptions`, so the option is ours to set.

Fixed with `aria: { expanded: false }` on the existing `tippyOptions`. tippy then skips the
attribute entirely (`:803`).

*Why suppress rather than add a role.* The div is not a disclosure control. The bubble menu
opens when you select text, not when you operate an expandable widget, so `aria-expanded`
was announcing a state that does not exist. Giving the editor wrapper a role that permits
the attribute would make the scanner happy and the screen reader wrong.

*Tradeoff.* This is coupled to tippy's option contract: if tippy 7 renames `aria.expanded`
the attribute comes back silently. The regression test asserts the option is present in
source, which catches deletion but not a rename — a rename would be caught by the axe run.

**7c. Regression test (Rule 3).** `web/src/styles/a11y-container-opacity.test.ts`, its own
file rather than an addition to `a11y-invariants.test.ts` so §7 stays revertible on its own
(Rule 11). Three assertions; **two of them fail on the pre-fix tree, verified by reverting
both source edits and re-running**:

| Assertion | Pre-fix |
|---|---|
| `opacity-40` composites `#9e9e9e` to `#474747` = 2.09:1, and `#9e9e9e` alone clears 4.5:1 | passes — it states the mechanism |
| the `/my-week` row builder contains no unprefixed `opacity-*`, and still carries `border-border/NN` | **fails** |
| `Editor.tsx`'s `tippyOptions` sets `aria: { expanded: false }` | **fails** |

The first assertion is the reason the other two are worth having: it pins the arithmetic to
the exact ratio axe measured, so the test explains the defect instead of just forbidding a
class name. The second half of assertion two is deliberate — without it the test could be
satisfied by deleting the de-emphasis entirely.

Source-level, for the same reason §6 gives, plus one specific to this page: the future-day
rows only exist on some weekdays, so a runtime check would pass every Sunday regardless of
the code.

---

## What the three-page scope hid

Everything above §8 was scanned and fixed to the boundary p.7 draws: *"all Critical/Serious
violations on the 3 most important pages."* That boundary is also what hid this section, so
it is worth naming the failure mode exactly. The scan was pointed at three pages, the fixes
went where the scan looked, and defects of **the same class, from the same source lines, on
other pages** were never seen. A page-scoped scan cannot find a component-scoped defect, and
nothing above said so.

**Five of the audit's own findings were never fixed by the work above — W7-6, W7-7, W7-8,
W7-9 and W7-11.** Not deferred, not fixed-but-untested: never touched. Checked file by file
against both trees rather than inferred from commit messages. At the commit that closed this
category, `hooks/useFocusOnNavigate.ts:39` still read `return 'Ship'`,
`WorkspaceSettings.tsx` still opened a second `<main>`, `Login.tsx` rendered no landmark at
all, and `SelectableList.tsx:134` still rendered the empty `<th>`. None of the five appeared
in "What is still open" either, which is the part that matters: work that is not done and not
written down is indistinguishable from work that is done.

W7-8 and W7-9 are closed in §8 and §9. W7-6 and W7-7 are the e2e suite's own defects — a
fixture below the data threshold and a test whose condition is always true — and are closed
in `e2e/accessibility.spec.ts` and `e2e/fixtures/isolated-env.ts`. W7-11 is a deliberate
non-fix and stays in the table below.

Closing W7-8 and W7-9 meant reading every page rather than three, and that turned up **three
defect sets the audit never recorded at all** — same blind spot, same cause. They are §10.

### 8. W7-8 — eight pages called themselves "Ship | Ship"

WCAG 2.4.2 Page Titled, **Level A**. `/my-week`, `/dashboard`, `/projects` and all five
document editors returned `document.title === "Ship | Ship"`; `/login` and `/admin` never
touched the title and kept `index.html`'s default. Seven of seventeen pages had a title that
identified them.

The cause is one line. `getPageTitle` ended `return 'Ship'` and its caller wrote
`` `${pageTitle} | Ship` ``, so every unlisted route stuttered — and routes were unlisted
because the table was written once and never extended. `/my-week`, `/dashboard` and
`/projects` are simply absent from it.

**No automated rule catches this and none could.** axe's `document-title` asserts that a
title exists and is non-empty. "Ship | Ship" is both. A Level A failure that every scanner in
this category reports as a pass is exactly the kind that survives a scan finding 99 nodes.

Three changes, in the order a title has to be resolved:

| Where | What |
|---|---|
| `hooks/usePageTitle.ts` (new) | one writer, one format: `document.title = "<title> \| Ship"`. Plus `documentPageTitle()`, which falls back to the document *type* because every new document is literally titled "Untitled" |
| `hooks/useFocusOnNavigate.ts` | route table extended to every route the router declares; the terminal `'Ship'` becomes `'Workspace'` |
| `contexts/CurrentDocumentContext.tsx` → `pages/App.tsx` | carries the open document's title, so the shell can name editor pages |

**Why the context plumbing rather than a `usePageTitle` call in each editor.** All five
document editors are the same route, `/documents/:id`. The path cannot tell a project from a
wiki, let alone name it, so no route table can ever answer this — which is precisely why
those five were the worst case. The page that fetched the document is the only thing that
knows, so it reports the title up through `CurrentDocumentContext`, which the shell already
consumes for mode selection. The alternative puts five writers on one DOM property and makes
the winner depend on mount order.

**Tradeoff.** `documentPageTitle` special-cases the literal string `"Untitled"`, coupling
this hook to the convention in `docs/document-model-conventions.md`. If that default is ever
renamed, five editors quietly go back to announcing an indistinguishable title. The
alternative — "Untitled | Ship" on every new document — reproduces the defect being fixed, so
the coupling is the cheaper of the two.

**Six pages outside the shell set their own**, because no shared layout runs for them:
`Login` ("Sign in"), `AdminDashboard` ("Admin"), `AdminWorkspaceDetail` (the workspace's
name), `Setup`, `InviteAccept` (the workspace being joined), `PublicFeedback` (the program).

### 9. W7-9 — landmarks, one heading, one table header

Four fixes. Three are a single tag each, and the node counts collapse because each defect had
exactly one source.

**`/settings` had two `<main>` landmarks.** The route renders inside `AppLayout`, whose
`<main id="main-content">` already wraps the `Outlet`, and `WorkspaceSettings` opened a
second one *inside* it. That one tag produced all three of `landmark-no-duplicate-main`,
`landmark-unique` and `landmark-main-is-top-level`. A document has exactly one main and the
shell owns it, so it is now a `<div>`.

**`/login` had no landmark at all** — `landmark-one-main` plus all 5 `region` nodes, which
was every piece of content on the page sitting outside any landmark. The whole page is one
task, so the sign-in card is the main landmark, and both rules clear from the same tag.

**`SkipLink` extracted rather than copied.** The skip link existed once, inline in `App.tsx`,
so only in-shell routes had one; `/login`, `/admin` and `/admin/workspaces/:id` had none. It
is now `components/SkipLink.tsx`, used in four places. Copying it a third time would have
been fewer lines and left four independent copies of a control that has to stay correct.

**Tabbed documents had no `<h1>`.** The project document was the only page of seventeen
without one (`page-has-heading-one`). Untabbed documents get theirs from `Editor`'s header
bar; a tabbed document replaces that header with the `TabBar`, so nothing named the page and
a screen reader user landed on a tablist belonging to nothing. Fixed with an `sr-only <h1>`.

*Tradeoff.* Visually hidden, not drawn. The tab strip is the design, and the title is already
on screen in the properties sidebar and the document tree, so rendering it again would be a
layout change for sighted users to fix a defect only non-sighted users have. `sr-only` is
what this app already uses for that, and `page-has-heading-one` filters on
`isVisibleToScreenReaders`, not on paint.

**`empty-table-header` × 4 was one `<th>`.** `SelectableList` rendered
`<th aria-label="Selection">` above the row checkboxes, and it fired on `/issues`,
`/projects`, `/programs` and the project document — one source line rendered four times. The
`aria-label` did not satisfy the rule and could not: the check is `has-visible-text`, which
reads rendered text, not accessible names. The honest fix is that this is not a header —
there is no column name to give, and each checkbox already names its own row — so it is a
`<td>`, which is valid HTML and falls out of the rule's selector rather than dodging it with
a role.

### 10. Three defect sets the audit never recorded

Found by reading all of `web/src` instead of three pages. All three are classes the audit
already describes; none of the instances below is in it.

**Six `<select>`s with no accessible name.** W7-4 verbatim, on pages the scan never visited:
three in `AdminWorkspaceDetail` (per-member role, add-user role, invite role), two in
`WorkspaceSettings` (invite role, token expiry), one in `MergeProgramDialog`. The first is
the audit's finding repeated exactly — one `<select>` per member, no name, **on the page that
grants workspace admin.** With an empty name a screen reader announces the control's *value*,
so every row said "Member" and none said whose permissions were about to change.

Four are named with `aria-label`. Two are fixed by associating a `<label>` that was already
drawn, already correct, and simply had no `htmlFor` — the general shape of W7-4, "the design
system draws labels without connecting them". Where the label exists, associating it beats
bolting on an `aria-label`: one name, visible and announced, that cannot drift from the
other. The member-role label interpolates the member's name so no two rows announce
identically (W7-12).

**Eight icon-only buttons with no accessible name** — `button-name`, critical. Two are
destructive: `MultiPersonCombobox` removes a person from an assignment, `ProjectRetro`
removes a success criterion. The rest are back, clear-filter and dismiss controls in
`AdminWorkspaceDetail`, `WeekDetailView`, `TeamMode` and `OrgChartPage`. A button whose
entire content is an `<svg>` has no text node to fall back on, so its accessible name is
empty and it announces as a bare "button". Seven are now named, with the row's subject
interpolated wherever the control repeats per row.

**One is deliberately not fixed, and it is the interesting one.** `OrgChartPage`'s
expand/collapse chevron already carries `aria-hidden="true"` and `tabIndex={-1}`, and it sits
inside a proper `role="treeitem"` carrying its own `aria-expanded`. The chevron is therefore
outside the accessibility tree entirely: the treeitem already announces expanded state, and
the chevron is a mouse affordance for the same action. Naming it would put roughly 300
identical "Expand" announcements into an org chart — W7-12, the defect §1 already fixed once,
reintroduced from the other direction. The correct treatment for a redundant control is to
hide it, and it already is hidden.

**An `<li>` inside a `role="group"` that is not a `treeitem`.** `ProjectContextSidebar`
renders each person's weeks as `<ul role="group">` inside a treeitem inside the tree. A group
in a tree owns treeitems exactly as the tree itself does, so those `<li>`s left the tree
malformed — `aria-required-children`, critical: the user is told "tree, N items" and handed
rows that are not items. Same defect class as §3, one level deeper, on a sidebar the audit's
scan never reached. The week rows are now `role="treeitem" aria-level={2}`, and the person
rows above them declare `aria-level={1}` and their own `aria-expanded`.

### 11. Regression tests for the ARIA-semantics findings (Rule 3)

`web/src/styles/a11y-aria-invariants.test.ts`, sibling to §6's `a11y-invariants.test.ts` and
§7c's `a11y-container-opacity.test.ts`. Source-level invariants for **W7-3, W7-4, W7-5 and
W7-12** — the four Critical/high ARIA findings that §1, §3 and §4 fixed with no test behind
them — and, since §8 and §9 landed, for **W7-8 and W7-9** as well. Every assertion is verified
red against the pre-fix tree at `767aa2f` and green now, and the file carries an
`A11Y_SCAN_ROOT` override whose only purpose is to point the same scan at a pre-fix checkout
so that claim can be re-run rather than believed.

Source-level for the reason §6 gives, with one addition specific to these: two of them — the
tree overflow row and the 52 identical delete labels — only exist above a data threshold,
which is W7-6's whole mechanism. A source invariant has no threshold to fall under. W7-8 is a
second case no runtime rule can reach at all: axe's `document-title` passes on "Ship | Ship".

**The scan is how §10 was found.** It reads every file in `web/src` rather than a page list,
which is exactly what this category lacked, and it named the six selects, the eight icon-only
buttons and the tree child before any of them were fixed.

**Tradeoff, and how it was resolved.** Those sites were open when the file was written, so
asserting zero offenders would have been red on both trees, and a test that cannot pass is not
coverage either. The first version froze them in allowlists keyed on the first 60 characters
of the offending element's source. That was the wrong key: it asserts "this markup still
exists", not "this markup still offends", and §10 appended `aria-label` **after** the existing
attributes on the icon buttons, so the frozen prefix still matched and real fixes went
unnoticed. The allowlists are gone — every assertion is now `toEqual([])` against the scan's
own output, and the `OrgChartPage` chevron is handled by an `aria-hidden` branch in the
scanner rather than by an exception, because "removed from the accessibility tree" is
something the scan can decide for itself. If a future defect genuinely cannot be driven to
zero, key its allowlist on what the scan *flags*, never on a substring of the source.

---

## What is still open

Reported rather than dropped. **Nothing Critical or Serious remains on any of the 18
scanned routes** — and "scanned routes" is the load-bearing phrase, since §10 is made
entirely of defects on routes outside those 18.

Open, with the reasoning:

| Where | Finding | Numbers | Why it is still open |
|---|---|---|---|
| `/issues`, `/settings` | **W7-11** heading density | 2,257 accessibility nodes behind **2** headings; **1** heading for **117** controls | Deliberate — see below |
| `OrgChartPage` chevron | `button-name` | 1 | Deliberate non-fix (§10). Already `aria-hidden` inside a named `treeitem`; naming it would add ~300 identical announcements. Recorded so it is not "fixed" later by mistake |

**W7-11, and why closing it is not a defect fix.** `/issues` exposes 2,257 accessibility
nodes behind 2 headings; `/settings` has 1 heading for 117 interactive controls. Headings are
how a screen reader user skips through a page — the rotor lists them and jumps between them —
and at this density there is nothing to jump to, so navigation degrades to linear traversal
of hundreds of nodes. Both pages score 100 in Lighthouse and have zero unnamed controls,
because every tool used here checks that headings are correctly *formed*, not that enough of
them exist to be useful.

Nothing is technically violating, and that is the point: closing it means **adding headings to
the UI** — deciding that the issues list has sections and naming them, deciding what 117
settings controls group into. That is an information-architecture change with a visible design
consequence on two of the busiest pages in the app, not a defect fix, and not this lane's to
make unilaterally. Recorded with its numbers so the decision stays available rather than
getting lost.

Out of this lane's scope, carried over from the audit:

- arrow-key navigation in composite widgets (0 of 4 respond to arrow keys) — a behaviour
  change, not an attribute change
- `PropertyRow`'s missing `id`/`htmlFor` contract, which is why `WeekSidebar` uses a
  redundant `aria-label`
- `bg-surface` is used at 12 sites in `web/src` but **`surface` is not a token in
  `tailwind.config.js`**, so the class emits nothing. Found while fixing 7a
  (`bg-surface/40` is therefore inert, and the row background is the page background —
  the fix rests on `border-border/40`). Cosmetic, not an accessibility defect, and
  defining the token would change how all 12 surfaces look. Left for a deliberate
  decision rather than resolved inside an accessibility fix.
- `tailwind.config.js` comments `#9e9e9e` as "6.41:1 on #0d0d0d". Recomputed by WCAG
  relative luminance it is **7.25:1**, which the browser agrees with
  (`cat7-f16-myweek-composited.json`). The comment understates the margin, so nothing is
  unsafe, but the number is wrong. Not corrected here: the token is asserted by another
  lane's in-flight invariants and this is a comment, not behaviour.

---

## Why not Lighthouse

p.7 accepts either evidence. Target A is in fact met — `/admin`, the lowest-scoring page,
went **88 → 100**, and sprint and wiki documents went 91 → 100 — but the claim is made on
axe, because **Lighthouse cannot demonstrate this work on this app.** It snapshots the DOM
before react-query resolves, so:

- at baseline, `/settings` scored **100** with **10 Critical** violations open
- at the Phase 2 after-scan, the weekly plan document scored **100 on desktop and mobile**
  while still carrying the open Critical that F16 (§7b) later fixed

A Lighthouse before/after would have shown a fix that did not happen and missed one that
did. The F16 pair adds a third demonstration. Comparing
`cat7-phase2-after-lighthouse.json` with `cat7-f16-after-lighthouse.json`:

- `/my-week` desktop **96 → 100**, `color-contrast` → no failed audits. That one is real
  and it matches the axe result exactly.
- but **8 other route/form-factor pairs moved 100 → 98** on `landmark-one-main`, on pages
  F16 did not touch at all (`/docs`, `/dashboard`, `/issues`, `/programs`, the wiki
  document). Those pages do have a `<main>` — the same scan's structure column records
  `main=1` for every one of them, and axe reports zero landmark violations. Lighthouse
  simply snapshotted before react-query resolved, and it snapshotted earlier this time
  because the machine was busier.

So in one pair Lighthouse produced one true movement and eight false ones. The scores are
reported for completeness in `docs/audit/raw/cat7-f16-after-lighthouse.json`; the claim is
made on axe.

---

## How to run, test, and roll back (Rule 8)

```bash
# measure (dev servers must already be running, seeded, on :5173 / :3000)
pnpm dev
scripts/measure-lock.sh acquire lane-7 1800
docs/audit/scripts/measure-a11y.py
scripts/measure-lock.sh release lane-7

# F16 corroboration: composited colour of the /my-week future rows, read off the live DOM.
# Row-count independent, unlike the axe node count — see §7a.
node docs/audit/scripts/verify-myweek-contrast.mjs

# the regression tests
pnpm --filter @ship/web exec vitest run src/styles/a11y-invariants.test.ts
pnpm --filter @ship/web exec vitest run src/styles/a11y-container-opacity.test.ts   # F16
pnpm --filter @ship/web exec vitest run src/styles/a11y-aria-invariants.test.ts     # §11

# §11 verified red rather than asserted red: point the same scan at a pre-fix checkout
git worktree add /tmp/ship-767aa2f 767aa2f
A11Y_SCAN_ROOT=/tmp/ship-767aa2f/web/src \
  pnpm --filter @ship/web exec vitest run src/styles/a11y-aria-invariants.test.ts

# page titles (§8) — no rule in any scanner here can check these, so read them:
# visit /my-week, /dashboard, /projects, /documents/<id>, /login and /admin and read
# the browser tab. None should say "Ship | Ship", and the five editors should differ.

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

The F16 changes (§7) roll back independently and are small: `MyWeekPage.tsx` one line,
`Editor.tsx` one prop, plus `web/src/styles/a11y-container-opacity.test.ts` which must be
reverted with them. Reverting §7a re-opens 9 serious nodes on `/my-week` and visibly dims
future days again; reverting §7b re-opens 1 critical node on every document editor route.

§8 through §11 roll back per fix, and only §8 has a dependency chain:

| To undo | Do this | What comes back |
|---|---|---|
| Page titles (§8) | `rm web/src/hooks/usePageTitle.ts`, then revert `useFocusOnNavigate.ts`, `CurrentDocumentContext.tsx`, `App.tsx` and the six out-of-shell pages | "Ship \| Ship" on 8 pages, `index.html`'s default on 2. Revert as a unit — the hook is imported by all of them |
| Landmarks (§9) | Revert the one tag in each of `WorkspaceSettings.tsx`, `Login.tsx`, `UnifiedDocumentPage.tsx`, `SelectableList.tsx`; `rm web/src/components/SkipLink.tsx` and restore the inline anchor in `App.tsx` | 3 landmark rules on `/settings`, `landmark-one-main` + 5 `region` on `/login`, `page-has-heading-one` on tabbed documents, 4 `empty-table-header` |
| Names (§10) | Revert per file; each is one attribute and they are independent | The named `button-name` / `select-name` node returns |
| Tree roles (§10) | Revert `ProjectContextSidebar.tsx` | `aria-required-children` on the project sidebar |
| §11 tests | `rm web/src/styles/a11y-aria-invariants.test.ts` | Nothing — it asserts §1, §3, §4 and §8–§10, so revert it *with* whichever of those you undo, or it goes red |

None of this touches the palette, so §8–§11 have no visual blast radius except the `sr-only`
`<h1>`, which paints nothing.

### Conditions the F16 scan was taken under (Rule 1)

Same script, same 18 routes, same database (`ship_lane_7`, 257 documents), same discovered
document ids as the Phase 2 pair, same box. **Not** the same machine load: the lock was
acquired but `wait-quiet` timed out at load 15.9 against a threshold of 6, because other
lanes were benchmarking. The run says so in its own header —
`docs/audit/raw/cat7-f16-after.txt` line 8.

That is recorded rather than hidden, and it is why the axe numbers are still a valid pair:
axe rules are deterministic DOM assertions with no timing component, and every route
returns an identical `passes` count across the two runs except the weekly plan document
(27 → 24, which is 7b removing the only ARIA attribute on that div). Lighthouse *is*
load-sensitive, which is visible as the eight `landmark-one-main` flips above, and is a
further reason the claim is not made on it.
