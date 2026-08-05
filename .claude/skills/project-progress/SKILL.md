# Project Progress

Full progress report for the FleetGraph build: what percentage is done, what's left,
and how much work remains — measured in **claude-hours**, never human-hours.

## Trigger

- User types `/project-progress`
- User asks "how far along are we", "what's the progress", "how much is left",
  "are we going to make it", "where do we stand"
- Start of a session, to establish where things are before deciding what to do

## Why claude-hours

A human-hour figure would be meaningless here — the bottleneck is not typing speed.
It is verification cycles, container startups, type-check rounds, and the round trips
where something turns out to be wrong. One ticket that touches a migration and needs a
fresh Postgres costs more than five that edit markdown, regardless of who is doing it.

So the unit is: **how long this takes me, at the rate this project has actually been
going.**

## Run it

```bash
node scripts/progress-report.mjs                    # the report
node scripts/progress-report.mjs --active-hours 7   # supply a known figure
node scripts/progress-report.mjs --json             # machine-readable
```

Every run appends to `.claude/progress-log.jsonl`, so the rate improves as the log
accumulates real deltas.

## Read the output in this order

1. **BY DEADLINE** — the only section that answers "are we going to make it". Compare
   claude-hours remaining against wall-clock hours remaining. A `⚠ over budget` flag
   means the bucket cannot be finished at the current rate.
2. **BY SECTION** — where the remaining work actually sits. More trustworthy than any
   single total, because sections group tickets of similar size.
3. **VELOCITY** — the rate, and where it came from.

## Rules for reporting this to the user

- **Never convert to human time.** Not "a day's work", not "a couple of afternoons".
- **Never present the total as a forecast.** It is a floor. Tickets are not equal —
  "commit this file" and "build a detector with tests" both count as one.
- **If there is no rate, say so.** Do not substitute an impression. The report prints
  `? no rate` against deadlines for exactly this reason.
- **Name what is on the critical path**, not just the counts. A section at 0% that
  blocks three others matters more than a larger section that blocks nothing.
- Pair the numbers with the two or three specific things that would change them.

## Why velocity is not derived from git

It was, in the first version, and it was wrong: it reported **98 tickets/claude-hour**
by measuring gaps between commits carrying `Closes:` trailers.

Work sat uncommitted for hours, then four commits landed within one minute of each
other closing 39 tickets between them — so the gaps measured almost none of the actual
work. `git filter-branch` had also rewritten committer dates, and author dates were no
better for the same reason.

That wrong number produced a green `✓ fits` against the MVP deadline. A fabricated
reassurance about a deadline is the single worst output this report could produce, so
the rate now comes from observed progress between runs, and prints nothing at all when
it has nothing to measure.

## Related

- `TICKETS.md` — what the tickets are, and the working process
- `node scripts/linear-import.mjs --verify` — checks the board against git history,
  so the percentages here are not counting closes with nothing behind them
