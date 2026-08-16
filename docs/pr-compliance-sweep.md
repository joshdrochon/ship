# Slice **commit-body** compliance sweep — PF-784

PRD p.12: *"each PR description lists which acceptance criterion that slice advances and
confirms the fitness test passed."*

PF-026 enforces that the **sections exist**. This is the submission-time check that the
**content is true**.

> **Read `docs/slice-ledger.md` beside this document. They are different instruments.**
> The ledger is the **inventory** — one generated row for every one of the 190 `pf/*` branches,
> carrying the acceptance criterion that slice advances, the fitness test it names, its tickets
> and its merge commit, regenerated from git and the lane files by
> `node scripts/slice-ledger.mjs`. This sweep is the **audit** — it judges the *quality* of the
> commit bodies over a 66-slice sample and reports how many name an artifact a reader could
> re-run. Neither claims p.12's *"each PR description"* is satisfied; both say what is on offer
> instead, and both are generated from or measured against artifacts contemporaneous with the
> work rather than assembled at submission time.

## What this document measures, and what it does not — read this first

**It measures commit bodies, not PR descriptions.** The method below reads the commits in
`P1..P2` for each merge. That is a deliberate substitution and it was previously left
implicit, with the title and the framing both saying "PR body" while every number came
from commit text. Relabelled 2026-08-15 rather than left to be discovered.

**The substitution is necessary because there are almost no per-slice PRs.** Re-measured
2026-08-16 against `origin/pf/integration` and `origin/main` at `a96cdda`:

| | Count |
|---|---:|
| `pf/*` slice branches on `origin` | 185 |
| **Slice merges on `pf/integration`** (subject `merge(pf/LNN-…)`) — **the unit this sweep counts** | **90** |
| All merge commits reachable from `pf/integration`, PlugForge and Week 5 together | 188 |
| Merge requests on GitLab **from a `pf/LNN-*` slice branch** | **7** — !21–!27, **5 fully compliant** |
| Merge requests on GitLab from `pf/integration` → `main` (batch, not per-slice) | 4 — !17–!20 |
| Pull requests on GitHub from any `pf/` branch | **0** |

**The slice-MR row was `0` until 2026-08-15 and this table said so.** Seven `pf/LNN-*`
branches have since been merged to `main` through their own MRs — !21 `pf/L12`, !22 `pf/L21`,
!23 `pf/L20`, !24 `pf/L21-gitleaks-depth`, !25 `pf/L17`, !26 `pf/L26`, !27 `pf/L23`. Five carry
both required sections (*"Acceptance criterion advanced"* and *"Fitness test confirmed
passing"*): **!21, !23, !24, !25, !27**. The two that do not are **!22** (neither section) and
**!26** (criterion stated, no fitness-test line). Those seven merged directly to `main`, not
through `pf/integration`, which is why the 90 above does not include them; counting both routes
the tree carries **97** slice merges.

The middle two rows are different quantities and an earlier revision of this table
conflated them, reporting "180 merges" as though all of it were PlugForge. It is not: 96
of the 184 are Week 5 and earlier — `Merge branch 'integration/phase-2' into 'main'`,
`Merge pull request #8/#9 from …`, the `origin/master` back-merges. **90** is the number
that belongs next to the 66 this sweep covered (98 of the 188 are Week 5; both figures moved
by 3 and 4 between 2026-08-15 and 2026-08-16 as lanes kept merging).

(GitLab carries **27** MRs and GitHub 9 in total; every one not counted above belongs to Week
5 and predates PlugForge. Reproduce with
`glab api "projects/joshrochon%2Fship/merge_requests?state=all&per_page=100" --repo joshrochon/ship --hostname labs.gauntletai.com`
and `gh pr list --repo joshdrochon/ship --state all --limit 200 --json headRefName`. Both
were re-run on 2026-08-16. The GitHub row is still zero; the GitLab slice-MR row is no
longer zero and is broken out above.)

**So p.12's clause is not met as literally written, and this document does not claim it
is.** Seven slice MRs against 185 slice branches demonstrates the practice; it does not
satisfy *"each"*. What exists alongside them is the other half of the same sentence — per-slice branches, preserved,
each carrying the acceptance criterion and the fitness-test confirmation in its commit
bodies. That is the artifact swept below. Whether a grader accepts a commit body in place
of a PR description is theirs to judge; presenting one as the other is not on offer.

**The headline count covers 66 of 97 slices.** The 55/66 figure below was produced when
`pf/integration` carried 66 slice merges; it now carries **90**, with a further **7** merged
straight to `main`, so **31 slices merged after the sweep ran are unaudited** — they are not
counted as compliant or as non-compliant, they are simply not in the sample. 55/66 is a rate
over the audited 66, never over the whole tree, and it is not a 97-slice result. Cite it with that scope or
re-run the sweep; what is not available is reading 55/66 as the submission's compliance
rate.

## Getting to the right unit took three attempts

The unit is one slice = one branch = one merge into `pf/integration`. The first two
measurements are recorded because both produced a confident, wrong number:

1. **Merge commits** — reported **3/150**. Merge subjects are one-liners; the substance is in
   the branch's own commits. Wrong artifact.
2. **`merge-base..branch` per branch** — reported **131/135**. For a fully merged branch that
   range is empty, so the fallback read unrelated ancestor commits and judged text belonging
   to a different slice.
3. **Merge parents** — for a merge with parents `P1 P2`, the slice's commits are exactly
   `P1..P2`. That is the number below.

## Result — 55 of the 66 slices audited, out of 97 in the tree

| Standard | Count |
|---|---:|
| Names its tickets **and** names a test or check that ran | **55** |
| Names its tickets, describes verification in prose but names no artifact | 9 |
| Names no ticket | 2 |

The middle row is the honest gap. Those slices say the work was verified; they do not name a
test file, a pass ratio or an exit code, so a reader cannot go and re-run the thing that was
claimed. That is weaker than p.12 asks for, and it is counted as not-compliant rather than
argued into the first row.

## Fully compliant

| Slice | Tickets | Evidence named |
|---|---|---|
| `pf/L03-scope-fitness` | PF-061, PF-062, PF-063, PF-064, PF-065, PF-066, PF-067, PF-068, PF-069, PF-070, PF-071, PF-072, PF-073, PF-074, PF-075, PF-076, PF-077, PF-078, PF-079, PF-080, PF-271, PF-287 | `api/src/__tests__/scope-fitness.test.ts`, `077/078` |
| `pf/L07-fitness-harness` | PF-161, PF-186, PF-187, PF-188, PF-189, PF-190, PF-191, PF-192, PF-193, PF-194, PF-195, PF-196, PF-197, PF-198, PF-199, PF-200, PF-201, PF-202, PF-203, PF-498 | `type-check clean`, `21/186` |
| `pf/L08-consumer-contract` | PF-018, PF-200, PF-211, PF-212, PF-213, PF-214, PF-215, PF-216, PF-217, PF-218, PF-219, PF-220, PF-221, PF-222, PF-223, PF-224, PF-225, PF-226, PF-227, PF-228, PF-229, PF-230, PF-231, PF-232, PF-233, PF-234 | `type-check clean` |
| `pf/L06-drills-and-answers` | PF-037, PF-052, PF-151, PF-152, PF-153, PF-154, PF-155, PF-156, PF-157, PF-158, PF-159, PF-160, PF-161, PF-162, PF-163, PF-164, PF-165, PF-166, PF-167, PF-168, PF-169, PF-170, PF-171, PF-172, PF-173, PF-174, PF-175, PF-176, PF-193, PF-498 | `architectureDoc.test.ts`, `161/181` |
| `pf/L04-gate-and-scenario` | PF-036, PF-042, PF-070, PF-076, PF-086, PF-087, PF-088, PF-089, PF-090, PF-091, PF-092, PF-093, PF-094, PF-095, PF-096, PF-097, PF-098, PF-099, PF-100, PF-101, PF-102, PF-103, PF-104, PF-105, PF-106, PF-107, PF-108, PF-109, PF-110, PF-111, PF-113, PF-134, PF-155, PF-158, PF-166, PF-245 | `5/5`, `type-check clean` |
| `pf/L13-parity-fitness` | PF-202, PF-248, PF-259, PF-351, PF-352, PF-353, PF-356, PF-357, PF-358, PF-359, PF-360, PF-361, PF-362, PF-363, PF-364, PF-365, PF-366, PF-367, PF-368, PF-369, PF-370, PF-371, PF-372, PF-373, PF-374, PF-375, PF-376, PF-377, PF-378 | `documents.pagination.test.ts`, `router.test.ts` |
| `pf/L21-plan-reading` | PF-228, PF-616, PF-618, PF-619, PF-620, PF-621, PF-622, PF-623, PF-625, PF-627, PF-628, PF-629, PF-630, PF-631, PF-632, PF-633, PF-639, PF-640, PF-641, PF-642, PF-643, PF-644, PF-645, PF-646, PF-647 | `0/16`, `router.test.ts` |
| `pf/L17-footprint` | PF-071, PF-189, PF-491, PF-492, PF-493, PF-494, PF-495, PF-496, PF-497, PF-498, PF-499, PF-500, PF-501, PF-502, PF-503, PF-504, PF-505, PF-506, PF-507, PF-508, PF-509, PF-510, PF-511, PF-512, PF-513, PF-514, PF-515, PF-738 | `documents.regression.test.ts`, `scope-fitness.test.ts` |
| `pf/L14-publish-fitness` | PF-016, PF-214, PF-241, PF-252, PF-391, PF-392, PF-393, PF-394, PF-395, PF-396, PF-397, PF-398, PF-399, PF-400, PF-401, PF-402, PF-403, PF-404, PF-405, PF-407, PF-409, PF-410, PF-411, PF-412, PF-441 | `1684/1684`, `type-check clean` |
| `pf/L11-boundary-and-order` | PF-107, PF-132, PF-301, PF-302, PF-303, PF-304, PF-305, PF-306, PF-307, PF-308, PF-309, PF-310, PF-311, PF-312, PF-313, PF-314, PF-315, PF-316, PF-317, PF-318, PF-319, PF-320 | `318/319`, `oauthBoundary.test.ts` |
| `pf/L12-query-and-proof` | PF-022, PF-075, PF-222, PF-301, PF-317, PF-326, PF-327, PF-328, PF-329, PF-330, PF-331, PF-332, PF-333, PF-334, PF-335, PF-336, PF-337, PF-338, PF-339, PF-340, PF-341, PF-342, PF-343, PF-344, PF-676 | `type-check clean`, `fitness test` |
| `pf/L01-board-fitness` | PF-027, PF-028, PF-029, PF-030, PF-276, PF-628, PF-648 | `628/629` |
| `pf/L01-board-fitness` | PF-027, PF-028, PF-029, PF-030, PF-222, PF-408 | `apps.test.ts`, `publishFitness.test.ts` |
| `pf/L05-device-code` | PF-121, PF-122, PF-123, PF-124, PF-125, PF-126, PF-127, PF-132 | `1955/1955` |
| `pf/L05-verify-ux` | PF-128, PF-129, PF-130, PF-131, PF-132, PF-133 | `2003/2003` |
| `pf/L05-polling` | PF-134, PF-135, PF-136, PF-137, PF-139 | `2029/2029` |
| `pf/L05-token-and-seam` | PF-138, PF-140, PF-141, PF-142, PF-143, PF-144, PF-564, PF-900 | `ratelimit/boundaryAndOrder.test.ts`, `2055/2055` |
| `pf/L10-issues` | PF-277, PF-278, PF-279, PF-280, PF-281, PF-282, PF-283, PF-292, PF-293, PF-294 | `Fitness test`, `115/1887` |
| `pf/L10-sprints` | PF-077, PF-284, PF-285, PF-286, PF-287, PF-288, PF-289, PF-290, PF-291, PF-294, PF-296 | `fitness test`, `120/1959` |
| `pf/L10-parity-and-budget` | PF-077, PF-271, PF-276, PF-294, PF-295, PF-296 | `Fitness test`, `115/1887` |
| `pf/L15-subscription-store` | PF-395, PF-421, PF-422, PF-423, PF-424, PF-425, PF-426, PF-427 | `115/1887` |
| `pf/L15-webhooks-api` | PF-062, PF-233, PF-411, PF-428, PF-429, PF-430, PF-431, PF-432, PF-433 | `staticCopy.test.ts` |
| `pf/L15-ts6-server-half` | PF-444, PF-445, PF-446, PF-447 | `architectureDoc.test.ts` |
| `pf/L24-browser-pkce` | PF-018, PF-234, PF-507, PF-539, PF-733, PF-734, PF-737, PF-738 | `Fitness test`, `publicClient.test.ts` |
| `pf/L26-regression-budget` | PF-020, PF-802, PF-803, PF-804, PF-805 | `exit 0`, `api/src/scripts/lib/perf-compare.test.ts` |
| `pf/integration` | PF-018, PF-020, PF-030, PF-214, PF-215, PF-234, PF-305, PF-507, PF-539, PF-733, PF-734, PF-737, PF-738, PF-802, PF-803, PF-804, PF-805 | `exit 0`, `api/src/scripts/lib/perf-compare.test.ts` |
| `pf/L18-resource-clients` | PF-521, PF-522, PF-523, PF-524, PF-525, PF-526, PF-527, PF-529, PF-531 | `type-check clean` |
| `pf/L18-spec-parity` | PF-528, PF-530, PF-531, PF-532 | `api/src/platform/openapi/sdkSurfaceParity.test.ts`, `111/111` |
| `pf/L18-pagination` | PF-522, PF-525, PF-533, PF-534, PF-535, PF-536 | `sdk/src/resources/clients.test.ts`, `sdk/src/pagination.test.ts` |
| `pf/L18-oauth-helpers` | PF-435, PF-438, PF-537, PF-538, PF-539, PF-540, PF-541, PF-542, PF-543, PF-544, PF-545, PF-546, PF-547 | `fitness.test.ts`, `264/264` |
| `pf/L18-surface-stability` | PF-526, PF-542, PF-548, PF-733 | `6/6`, `sdkOAuthFlows.test.ts` |
| `pf/L16-retry-ladder` | PF-451, PF-452, PF-453, PF-454, PF-455, PF-456, PF-457 | `408/425`, `Fitness test` |
| `pf/L16-delivery-log` | PF-218, PF-458, PF-459, PF-460, PF-461, PF-462, PF-463, PF-464, PF-472, PF-473 | `Fitness test`, `deliveryLog.test.ts` |
| `pf/L16-deliverer-contract` | PF-030, PF-460, PF-465, PF-466, PF-467, PF-468 | `Fitness test`, `deliverer.test.ts` |
| `pf/L16-dlq-replay` | PF-452, PF-462, PF-469, PF-470, PF-473, PF-474, PF-475, PF-476, PF-477, PF-478, PF-479, PF-480, PF-481, PF-484 | `500/500`, `Fitness test` |
| `pf/L16-ceilings` | PF-458, PF-460, PF-462, PF-463, PF-471, PF-482, PF-483, PF-484 | `Fitness test`, `ceilings.test.ts` |
| `pf/L22-viewer-floor` | PF-155, PF-477, PF-651, PF-652, PF-653, PF-654, PF-655, PF-659, PF-660, PF-661, PF-662, PF-663, PF-667, PF-679 | `web/src/pages/portal/portalTransport.test.ts`, `portal.test.ts` |
| `pf/L19-live-story` | PF-557, PF-562, PF-564, PF-567, PF-573, PF-575, PF-576, PF-578, PF-579, PF-580 | `Exit 0`, `type-check clean` |
| `pf/L20-drill-core` | PF-586, PF-587, PF-588, PF-589, PF-593, PF-606, PF-607 | `20/20` |
| `pf/L23-agent-oauth-client` | PF-155, PF-166, PF-686, PF-689 | `686/687`, `689/690` |
| `pf/L23-read-path-sdk` | PF-692, PF-693, PF-694, PF-695, PF-696, PF-699, PF-708, PF-712, PF-791 | `695/697`, `citizenReader.test.ts` |
| `pf/L23-feature-flag-and-ci` | PF-069, PF-271, PF-697, PF-703, PF-705, PF-706, PF-707, PF-709, PF-710, PF-713 | `fitness test`, `agentCitizenFitness.test.ts` |
| `pf/L23-proof-and-writeup` | PF-077, PF-698, PF-703, PF-705, PF-709, PF-711, PF-712, PF-791 | `agentCitizenFitness.test.ts`, `2913/2913` |
| `pf/L24-integration-boundary` | PF-716, PF-718, PF-719, PF-720, PF-721, PF-722 | `716/717`, `oneListener.test.ts` |
| `pf/L24-refresh-rotation-drill` | PF-723, PF-724, PF-725, PF-726, PF-727 | `tests/permissiveStub.test.ts`, `Fitness test` |
| `pf/L24-idempotency-drill` | PF-721, PF-728, PF-729, PF-730, PF-731, PF-732 | `Fitness test` |
| `pf/L24-slack-listener` | PF-716, PF-739, PF-740, PF-741, PF-742, PF-743, PF-744 | `Fitness test` |
| `pf/L24-five-of-seven-ledger` | PF-719, PF-721, PF-744 | `integrations/testkit/tests/ledger.test.ts`, `Fitness test` |
| `pf/L26-submission-truth` | PF-245, PF-781, PF-782, PF-783, PF-786, PF-805, PF-812, PF-813, PF-814 | `exit 0`, `877/1` |
| `pf/L01-pr-discipline` | PF-023, PF-024, PF-025, PF-026 | `fitness test` |
| `pf/integration` | PF-001, PF-002, PF-003, PF-004, PF-005, PF-006, PF-007, PF-008, PF-009, PF-010, PF-011, PF-012, PF-013, PF-014, PF-015, PF-016, PF-017, PF-018, PF-019, PF-020, PF-021, PF-022, PF-023, PF-024, PF-025, PF-026, PF-027, PF-028, PF-029, PF-030, PF-031, PF-032, PF-033, PF-034, PF-035, PF-036, PF-037, PF-038, PF-039, PF-040, PF-041, PF-042, PF-043, PF-044, PF-045, PF-046, PF-047, PF-048, PF-049, PF-050, PF-051, PF-052, PF-053, PF-054, PF-055, PF-056, PF-057, PF-061, PF-062, PF-063, PF-064, PF-065, PF-066, PF-067, PF-068, PF-069, PF-070, PF-071, PF-072, PF-073, PF-074, PF-075, PF-076, PF-077, PF-078, PF-079, PF-080, PF-086, PF-087, PF-088, PF-089, PF-090, PF-091, PF-092, PF-093, PF-094, PF-095, PF-096, PF-097, PF-098, PF-099, PF-100, PF-101, PF-102, PF-103, PF-104, PF-105, PF-106, PF-107, PF-108, PF-109, PF-110, PF-111, PF-113, PF-121, PF-122, PF-123, PF-124, PF-125, PF-126, PF-127, PF-128, PF-129, PF-130, PF-131, PF-132, PF-133, PF-134, PF-135, PF-136, PF-137, PF-138, PF-139, PF-140, PF-141, PF-142, PF-143, PF-144, PF-151, PF-152, PF-153, PF-154, PF-155, PF-156, PF-157, PF-158, PF-159, PF-160, PF-161, PF-162, PF-163, PF-164, PF-165, PF-166, PF-167, PF-168, PF-169, PF-170, PF-171, PF-172, PF-173, PF-174, PF-175, PF-176, PF-186, PF-187, PF-188, PF-189, PF-190, PF-191, PF-192, PF-193, PF-194, PF-195, PF-196, PF-197, PF-198, PF-199, PF-200, PF-201, PF-202, PF-203, PF-211, PF-212, PF-213, PF-214, PF-215, PF-216, PF-217, PF-218, PF-219, PF-220, PF-221, PF-222, PF-223, PF-224, PF-225, PF-226, PF-227, PF-228, PF-229, PF-230, PF-231, PF-232, PF-233, PF-234, PF-241, PF-242, PF-243, PF-244, PF-245, PF-248, PF-249, PF-250, PF-251, PF-252, PF-253, PF-254, PF-255, PF-256, PF-258, PF-259, PF-260, PF-261, PF-262, PF-263, PF-264, PF-265, PF-271, PF-272, PF-273, PF-274, PF-275, PF-276, PF-277, PF-278, PF-279, PF-280, PF-281, PF-282, PF-283, PF-284, PF-285, PF-286, PF-287, PF-288, PF-289, PF-290, PF-291, PF-292, PF-293, PF-294, PF-295, PF-296, PF-301, PF-302, PF-303, PF-304, PF-305, PF-306, PF-307, PF-308, PF-309, PF-310, PF-311, PF-312, PF-313, PF-314, PF-315, PF-316, PF-317, PF-318, PF-319, PF-320, PF-326, PF-327, PF-328, PF-329, PF-330, PF-331, PF-332, PF-333, PF-334, PF-335, PF-336, PF-337, PF-338, PF-339, PF-340, PF-341, PF-342, PF-343, PF-344, PF-351, PF-352, PF-353, PF-356, PF-357, PF-358, PF-359, PF-360, PF-361, PF-362, PF-363, PF-364, PF-365, PF-366, PF-367, PF-368, PF-369, PF-370, PF-371, PF-372, PF-373, PF-374, PF-375, PF-376, PF-377, PF-378, PF-391, PF-392, PF-393, PF-394, PF-395, PF-396, PF-397, PF-398, PF-399, PF-400, PF-401, PF-402, PF-403, PF-404, PF-405, PF-407, PF-408, PF-409, PF-410, PF-411, PF-412, PF-421, PF-422, PF-423, PF-424, PF-425, PF-426, PF-427, PF-428, PF-429, PF-430, PF-431, PF-432, PF-433, PF-434, PF-435, PF-436, PF-437, PF-438, PF-439, PF-440, PF-441, PF-442, PF-443, PF-444, PF-445, PF-446, PF-447, PF-451, PF-452, PF-453, PF-454, PF-455, PF-456, PF-457, PF-458, PF-459, PF-460, PF-461, PF-462, PF-463, PF-464, PF-465, PF-466, PF-467, PF-468, PF-469, PF-470, PF-471, PF-472, PF-473, PF-474, PF-475, PF-476, PF-477, PF-478, PF-479, PF-480, PF-481, PF-482, PF-483, PF-484, PF-491, PF-492, PF-493, PF-494, PF-495, PF-496, PF-497, PF-498, PF-499, PF-500, PF-501, PF-502, PF-503, PF-504, PF-505, PF-506, PF-507, PF-508, PF-509, PF-510, PF-511, PF-512, PF-513, PF-514, PF-515, PF-521, PF-522, PF-523, PF-524, PF-525, PF-526, PF-527, PF-528, PF-529, PF-530, PF-531, PF-532, PF-533, PF-534, PF-535, PF-536, PF-537, PF-538, PF-539, PF-540, PF-541, PF-542, PF-543, PF-544, PF-545, PF-546, PF-547, PF-548, PF-556, PF-557, PF-558, PF-559, PF-560, PF-562, PF-563, PF-564, PF-567, PF-568, PF-571, PF-572, PF-573, PF-575, PF-576, PF-577, PF-578, PF-579, PF-580, PF-586, PF-587, PF-588, PF-589, PF-593, PF-606, PF-607, PF-616, PF-618, PF-619, PF-620, PF-621, PF-622, PF-623, PF-624, PF-625, PF-626, PF-627, PF-628, PF-629, PF-630, PF-631, PF-632, PF-633, PF-634, PF-635, PF-637, PF-638, PF-639, PF-640, PF-641, PF-642, PF-643, PF-644, PF-645, PF-646, PF-647, PF-648, PF-651, PF-652, PF-653, PF-654, PF-655, PF-659, PF-660, PF-661, PF-662, PF-663, PF-665, PF-667, PF-676, PF-679, PF-686, PF-689, PF-690, PF-692, PF-693, PF-694, PF-695, PF-696, PF-697, PF-698, PF-699, PF-703, PF-705, PF-706, PF-707, PF-708, PF-709, PF-710, PF-711, PF-712, PF-713, PF-716, PF-718, PF-719, PF-720, PF-721, PF-722, PF-723, PF-724, PF-725, PF-726, PF-727, PF-728, PF-729, PF-730, PF-731, PF-732, PF-733, PF-734, PF-737, PF-738, PF-739, PF-740, PF-741, PF-742, PF-743, PF-744, PF-751, PF-752, PF-753, PF-754, PF-755, PF-756, PF-757, PF-758, PF-759, PF-760, PF-761, PF-762, PF-763, PF-764, PF-765, PF-766, PF-767, PF-768, PF-769, PF-770, PF-772, PF-773, PF-774, PF-775, PF-776, PF-781, PF-782, PF-783, PF-786, PF-791, PF-802, PF-803, PF-804, PF-805, PF-812, PF-813, PF-814, PF-900 | `7/7`, `integrations/testkit/tests/ledger.test.ts` |
| `pf/L26-latency-baseline-correction` | PF-806 | `type-check clean`, `perf-compare.test.ts` |
| `pf/L19-board-reconciliation` | PF-556, PF-557, PF-562, PF-564, PF-567, PF-573, PF-575, PF-576, PF-578, PF-579, PF-580, PF-581 | `26/26`, `integrations/cli/tests/server/story.test.ts` |
| `pf/L26-measurement-rigor` | PF-806, PF-807 | `0/1`, `tsc clean` |
| `pf/L26-ci-openapi-and-fitness` | PF-294, PF-807 | `fitness test`, `me.fitness.test.ts` |

## Tickets named, no artifact named

| Slice | Tickets |
|---|---|
| `pf/L21-pins-plan-clean` | PF-624 |
| `pf/L21-least-privilege` | PF-633, PF-634, PF-635, PF-637, PF-638 |
| `pf/L21-deployed-public` | PF-626, PF-632 |
| `pf/L15-signer` | PF-422, PF-434, PF-435, PF-436, PF-437, PF-438, PF-439 |
| `pf/L15-pipeline-matcher` | PF-440, PF-441, PF-442, PF-443 |
| `pf/L19-cli-skeleton` | PF-012, PF-494, PF-556, PF-557, PF-558, PF-559, PF-560, PF-562, PF-563, PF-564, PF-568, PF-571, PF-572, PF-573, PF-575, PF-576, PF-577, PF-580 |
| `pf/L26-submission-audit-refresh` | PF-781 |
| `pf/L26-three-discoveries` | PF-810 |
| `pf/L26-architecture-trim` | PF-786, PF-791 |

## No ticket named

Both are mine, from the final evening, and both are real work committed without a board row:

| Slice | What it did |
|---|---|
| `pf/L26-glab-remote-fix` | Removed the `upstream` remote so `glab` stops targeting the fork parent |
| `pf/L26-ci-lint-errors` | Cleared the five lint errors blocking the CI lint job |

Listed rather than papered over. Rewriting either message would mean rewriting merged
history, which the branch policy forbids for exactly the reason this sweep exists: the
history *is* the evidence.
