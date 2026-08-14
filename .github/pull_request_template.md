<!--
  PF-024. The two sections below are REQUIRED and are checked by CI
  (.github/workflows/pr-discipline.yml). PRD p.12 grades the PR description:

    "each PR description lists which acceptance criterion that slice advances
     and confirms the fitness test passed."

  Do not delete the headings. Replace the placeholder text under each one.
  See CONTRIBUTING.md -> "Branching and PR discipline" for what counts.
-->

## Advances acceptance criterion

<!--
  Ticket IDs and the criterion text they advance. Cite what the PRD grades:
  MVP-N (gate, p.2) · TS-N (testing scenarios, p.5) · CTR:<row> · PERF:<metric>
  INT:<integration> · SUB:<deliverable>. See TICKETS-PLUGFORGE.md -> Conventions.

  A slice that advances nothing graded writes a single `—` and says why it is
  plumbing. That is an honest answer; an invented citation is not.

  Example:
    PF-009, PF-010, PF-011, PF-012, PF-013 — the public/internal boundary is
    enforced mechanically: platform/ may not import internal route files or
    internal middleware, and integrations/ may import only @ship/sdk.
    Advances: MVP dependency (every gate item is built behind this boundary).
    PRD p.3, p.10, p.11, p.18.
-->

REPLACE ME

## Fitness test

<!--
  Name the test and confirm it passed. Not "CI is green" — the specific check
  that proves this slice's claim, with its result.

  Example:
    `pnpm lint:boundary` — 4 fences verified, positive control clean, workspace
    deps clean. Verified by mutation: removing the fixture glob makes PF-009 and
    PF-010 report "the fence did not fire".
    `pnpm lint` green (0 errors). `pnpm type-check` clean across all packages.
-->

REPLACE ME

## Notes

<!-- Optional. Deviations, follow-ups, anything a reviewer should know. -->
