# Refresh-token rotation drill

PRD p.8, option 5 of the seven integrations. PF-723 – PF-727.

```
pnpm drill:refresh
```

One command. It boots two Ship instances, runs the drill against them, and takes
them down. `DATABASE_URL` must point at a migrated database; nothing else is
required, and nothing in this package reads it.

## What it proves, and why from out here

PRD p.3, Refresh Tokens: *"One-time-use refresh tokens with rotation"* and
*"Stolen-refresh-token detection: reuse invalidates the family."*

`api/src/platform/oauth/rotation.test.ts` already proves the server does the
right thing to its own tables. What nobody had proved is that the guarantee is
**visible to the client holding the credential** — and the client-visible half is
the only half a thief is constrained by. So every assertion here is made over
HTTP through `@ship/sdk`, and this package physically cannot read a row: the
ESLint fence makes a `pg` import a build failure and
`scripts/check-integration-credentials.mjs` makes a `DATABASE_URL` read a CI
failure.

| Ticket | Assertion |
|---|---|
| PF-723 | The first pair comes from a real device grant. No fixture token exists in this package. The access token answers 200 on `/api/v1/me` before any rotation assertion runs. |
| PF-724 | `R1` → `{A2, R2}`; `R2 !== R1`; `A2` answers 200; presenting `R1` again fails. |
| PF-725 | `R1`→`R2`→`R3`, then the thief replays the long-spent `R1`. Afterwards `R3` no longer exchanges **and `A3` — never itself stolen — returns 401**. That last clause is the one the ticket exists for: a platform that revokes only the token presented passes everything above it. |
| PF-726 | Reused, expired and unknown are three distinct wire responses. Recorded to `test-results/refresh-failure-shapes.txt`. |
| PF-727 | One command, no sleeps, and it goes red against a permissive server. |

## Two instances, and the reason there are two

PF-727: *"Token expiry is produced by configuring a short TTL at boot, never by
waiting."* p.11 rules out `setTimeout` waits by name and p.9 sets drill flake at
zero over twenty consecutive runs — "sleep past a two-second TTL" would pass here
and flake on a loaded runner.

A process has one TTL config, so the expired case gets its own process, booted
with `SHIP_REFRESH_TOKEN_TTL_SECONDS=0`. Every refresh token it issues is born
expired (`rotation.ts` rejects on `expiresAt <= now`), so the case costs no
elapsed time at all. That knob is new — the `TokenTtlConfig` seam already existed
and said in its own comment that it was there "so a drill can boot with a
2-second access TTL", but nothing wired it to a boot-time value.

## The anti-vacuity half

`tests/permissiveStub.test.ts` runs the **same** `runRotationDrill` and the same
`rotationViolations` against a stub token endpoint that re-issues on every
refresh token it is shown, spent or invented, and asserts the result is a
non-empty list of violations naming one-time use, family revocation and the 401.

That is what makes the green run mean something. If somebody softens an
assertion to make the real run pass, this run goes green too and fails — a drill
that cannot fail is a screenshot. It needs no database and no booted Ship, so the
proof cannot itself fail for environmental reasons.

## What is asserted, and what is deliberately not

PF-726 asserts the three failures are **distinguishable**. It does not assert
what the codes are. p.2 names distinct 401 codes for *bearer* tokens and RFC
6749's `invalid_grant` for the token endpoint; it names no code set for refresh
failures, and inventing one from a consumer lane would silently write L06's
contract. For the record, this is what a run observes today — the descriptions
are L06's `REFRESH_ERROR_DESCRIPTIONS`, and this drill would still pass if they
changed, as long as they stayed pairwise distinct:

```
reused   400 {"error":"invalid_grant","error_description":"The refresh token has already been used or its family was revoked."}
expired  400 {"error":"invalid_grant","error_description":"The refresh token has expired."}
unknown  400 {"error":"invalid_grant","error_description":"The refresh token is not valid for this client."}
```
