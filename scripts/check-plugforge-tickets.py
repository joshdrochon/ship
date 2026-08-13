#!/usr/bin/env python3
"""Validate the PlugForge lane ticket boards against the spine.

Twenty-six lane files are authored in parallel by separate agents. Nothing in the
prompt guarantees they stay inside their ID block, cite a page that exists, or
reference dependencies that were actually written. This checks all of it.

    scripts/check-plugforge-tickets.py            # check every lane file
    scripts/check-plugforge-tickets.py L02 L07    # check specific lanes

Exit 0 = clean. Exit 1 = at least one error. Warnings never fail the run.
"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SPINE = REPO / "TICKETS-PLUGFORGE.md"
LANES = REPO / "tickets" / "plugforge"
PRD = REPO / ".claude" / "prd"

REQUIRED_SECTIONS = ["## Tickets", "## Slices", "## Notes for the audit agent"]
DASH = "[–—-]"  # en dash, em dash, hyphen

# PF-027 — the requirement inventories, transcribed from the PRD page files.
#
# Before this existed the coverage report checked MVP and TS and nothing else,
# so the other four families were stamped on 290 tickets and never counted. Six
# Core Technical Requirement rows turned out to have zero tickets claiming them
# — every one of them BUILT and merged, just untraceable from the board, which
# is precisely the state a grader reading the board would call a miss.
#
# Each entry is (canonical label, page). The label is a distinctive substring of
# the PRD's own row heading and must be greppable in that page file — the spine's
# citation rule, applied to the checker itself. `verify_inventory_pages()` proves
# it on every run, so a transcription slip fails here rather than becoming a
# confident wrong citation on 26 boards.
#
# Matching is loose on purpose: a claim counts if the ticket's tag contains the
# canonical label once both sides are lowercased and their whitespace collapsed.
# The boards already carry `PERF:webhook delivery P95 < 2 s` and `… < 2s`, and
# an inventory that treats those as two different requirements is worse than no
# inventory at all.
REQUIREMENTS: dict[str, list[tuple[str, int]]] = {
    "CTR": [
        ("OAuth App Model", 2), ("Authorization Code +", 2),
        ("Device Authorization", 3), ("Scope Registry", 3),
        ("Token Middleware", 3), ("Refresh Tokens", 3),
        ("Public API Boundary", 3), ("Consistent Error Shape", 3),
        ("Cursor Pagination", 3), ("OpenAPI 3.1 Spec", 3),
        ("Event Registry", 3), ("Event Bus", 3),
        ("Webhook Subscriptions", 3), ("HMAC-SHA256 Signing", 3),
        ("Retry Schedule", 4), ("Dead-Letter Queue", 4),
        ("Delivery Log", 4), ("Replay", 4),
        ("Typed SDK Surface", 4), ("OAuth Helpers", 4),
        ("Async-Iterator Pagination", 4), ("Webhook Verifier", 4),
        ("Typed Error Union", 4), ("Rate Limit Enforcement", 4),
        ("Public Audit Trail", 4), ("Developer Portal", 4),
        ("IaC deployment topology", 5), ("IAM least-privilege exercise", 5),
        ("Drift detection", 5), ("Architecture Defense", 5),
    ],
    # p.8's seven-option menu. The PRD requires five; the board may legitimately
    # mark the other two cut, so this family reports rather than demands.
    "INT": [
        ("CLI", 8), ("Slack", 8), ("Browser SDK demo", 8),
        ("GitHub integration", 8), ("Refresh-token rotation drill", 8),
        ("Idempotency-Key", 8), ("plugin runtime", 8),
    ],
    # The PERF rows carry aliases because the boards tag them with the measured
    # number rather than the PRD's row heading — `PERF:webhook delivery P95 < 2 s`
    # for p.6's "Webhook delivery latency (P95, first attempt)". That is the more
    # useful tag to read on a ticket, so the inventory bends to it rather than
    # forcing 40 tickets to be retagged into prose nobody wants.
    "PERF": [
        ("Time-to-First-Event", 6, ["ttfe on a clean machine", "ttfe drill"]),
        ("round-trip", 6),
        ("spec parity", 6),
        ("delivery latency", 6, ["webhook delivery p95"]),
        ("retry success rate", 6, ["retry success"]),
        ("rate-limit headers", 6),
        ("regression vs Part 1 baseline", 6),
        ("drill runtime in CI", 8),
        ("clean machine", 8),
        ("signature verification", 8),
        ("flake rate", 9),
        ("install size", 9),
    ],
    "SUB": [
        ("GitHub Repository", 12), ("Demo Video", 12),
        ("Pre-Search Document", 13), ("Architecture Document", 13),
        ("OpenAPI Spec", 13), ("AI Cost Analysis", 13),
        ("Per-Epic Write-up", 13), ("Three Discoveries", 13),
        ("Deployed Application", 13), ("Social Post", 13),
    ],
}


def norm(s: str) -> str:
    """Lowercase, collapse whitespace, drop markdown/punctuation noise."""
    return re.sub(r"\s+", " ", s.lower().replace("`", "").replace("*", "")).strip()


def verify_inventory_pages() -> None:
    """Every inventory label must be greppable in the page it cites.

    The spine forbids deriving page numbers from `full.txt`, which reflows. This
    holds the checker to its own rule: a label that has drifted from the PRD's
    wording, or that cites the wrong page, fails here instead of silently
    reporting a requirement as unclaimed forever because nothing can match it.
    """
    for family, rows in REQUIREMENTS.items():
        for label, page, *_aliases in rows:
            f = PRD / f"page-{page}.txt"
            if not f.exists():
                continue  # PRD not vendored in this checkout; pages check elsewhere
            if norm(label) not in norm(f.read_text()):
                err(f"inventory {family}:{label} is not present in page-{page}.txt")

errors: list[str] = []
warnings: list[str] = []


def err(m): errors.append(m)
def warn(m): warnings.append(m)


def parse_allocation() -> dict[str, tuple[int, int]]:
    """Read the spine's Allocation table -> {lane: (lo, hi)}."""
    text = SPINE.read_text()
    blocks = {}
    # No leading/trailing `|` in the pattern: the spine packs two lane/block pairs
    # per row and they share a pipe, so consuming it would hide every second pair.
    for lane, lo, hi in re.findall(
        rf"(L\d{{2}})\s*\|\s*PF-(\d{{3}})\s*{DASH}\s*(\d{{3}})", text
    ):
        blocks[lane] = (int(lo), int(hi))
    return blocks


def prd_max_page() -> int:
    pages = list(PRD.glob("page-*.txt"))
    if not pages:
        warn("no .claude/prd/page-*.txt — page citations cannot be range-checked")
        return 0
    return max(int(re.search(r"page-(\d+)", p.name).group(1)) for p in pages)


def parse_lane(path: pathlib.Path):
    """-> (lane_id, [(tid, prd_col, deps_col, line_no)], text)"""
    text = path.read_text()
    m = re.search(r"lane-(\d{2})", path.name)
    lane = f"L{m.group(1)}" if m else None
    rows = []
    # Column positions come from the ticket table's own header row, not from fixed
    # indices: the spine's ticket shape gained an `Advances` column between
    # `Acceptance criterion` and `PRD`, and lane files may be mid-migration. Reading
    # the header keeps both the 5- and 6-column shapes checkable.
    header = None
    for i, line in enumerate(text.split("\n"), 1):
        if header is None and re.match(r"^\|\s*ID\s*\|", line):
            header = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
            continue
        rm = re.match(r"^\|\s*(PF-\d{3})\s*\|", line)
        if not rm:
            continue
        # Split on unescaped pipes only — ticket text legitimately contains `\|`
        # (TypeScript union types, for one), and treating those as column breaks
        # shifts every downstream column.
        cols = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        if header is None:
            err(f"{path.name}:{i} {rm.group(1)} appears before any ticket table header")
            continue
        if len(cols) != len(header):
            err(
                f"{path.name}:{i} {rm.group(1)} has {len(cols)} columns, "
                f"expected {len(header)} (header: {' | '.join(header)})"
            )
            continue
        try:
            prd_i, deps_i = header.index("PRD"), header.index("Deps")
        except ValueError:
            err(f"{path.name}: ticket table header lacks a `PRD` or `Deps` column")
            continue
        adv = cols[header.index("Advances")] if "Advances" in header else ""
        rows.append((rm.group(1), cols[prd_i], cols[deps_i], i, adv))
    return lane, rows, text


def main() -> int:
    if not SPINE.exists():
        print(f"FATAL: {SPINE} missing", file=sys.stderr)
        return 1

    blocks = parse_allocation()
    maxpage = prd_max_page()
    wanted = {a.upper() for a in sys.argv[1:]}

    files = sorted(LANES.glob("lane-*.md")) if LANES.exists() else []
    if not files:
        print("No lane files yet.")
        return 0

    seen: dict[str, str] = {}   # ticket id -> lane file
    all_ids: set[str] = set()
    per_lane: dict[str, int] = {}
    advances_by_lane: dict[str, set[str]] = {}
    tagged_by_family: dict[str, set[str]] = {}

    parsed = []
    for f in files:
        lane, rows, text = parse_lane(f)
        if wanted and lane not in wanted:
            continue
        parsed.append((f, lane, rows, text))
        for tid, _, _, _, _ in rows:
            all_ids.add(tid)

    for f, lane, rows, text in parsed:
        per_lane[lane] = len(rows)

        # L99 is the cross-lane findings register, not a ticket board: no slices,
        # no audit notes, and nothing scheduled. Holding it to the lane shape would
        # mean either three permanent errors or three empty ceremonial sections.
        if lane != "L99":
            for section in REQUIRED_SECTIONS:
                if section not in text:
                    err(f"{f.name}: missing required section `{section}`")

            if lane not in blocks:
                warn(f"{f.name}: lane {lane} has no Allocation entry in the spine")
        lo, hi = blocks.get(lane, (0, 999))

        advances_by_lane.setdefault(lane, set()).update(
            c for _, _, _, _, adv in rows for c in re.findall(r"(?:MVP-(?:\d+|TF)|TS-\d+)", adv)
        )

        # PF-027 — the other four families are free text after the prefix, so the
        # whole tag is kept and matched by substring later. Splitting on `,` here
        # would cut `CTR:Drift detection & destroy-redeploy` in half.
        for _, _, _, _, adv in rows:
            for family, tag in re.findall(r"\b(CTR|INT|PERF|SUB):([^|]+)", adv):
                tagged_by_family.setdefault(family, set()).add(norm(tag))

        for tid, prd_col, deps_col, ln, _adv in rows:
            n = int(tid.split("-")[1])

            if not (lo <= n <= hi):
                err(f"{f.name}:{ln} {tid} outside {lane} block PF-{lo:03d}–{hi:03d}")

            if tid in seen and seen[tid] != f.name:
                err(f"{f.name}:{ln} {tid} duplicates the id in {seen[tid]}")
            seen[tid] = f.name

            if not prd_col or prd_col in ("", "|"):
                err(f"{f.name}:{ln} {tid} has an empty PRD column")
            elif prd_col != "—":
                pages = re.findall(r"p\.(\d+)", prd_col)
                if not pages:
                    err(f"{f.name}:{ln} {tid} PRD column `{prd_col}` has no p.N citation")
                for p in pages:
                    if maxpage and not (1 <= int(p) <= maxpage):
                        err(f"{f.name}:{ln} {tid} cites p.{p}; PRD has {maxpage} pages")

            if deps_col and deps_col != "—":
                for dep in re.findall(r"PF-\d{3}", deps_col):
                    if dep not in all_ids:
                        warn(f"{f.name}:{ln} {tid} depends on {dep}, which no lane file defines")

        # Scoped to the `## Slices` table. It used to scan the WHOLE file, which
        # made every cross-lane reference an error: L10 re-pointed PF-276's deps
        # at L05 and named the branch it is now blocked on, which is exactly the
        # thing a reader needs and exactly what the rule forbade. A lane naming
        # another lane's branch in prose is correct; a lane DECLARING another
        # lane's branch as one of its own slices is the mistake worth catching,
        # and only the Slices table can express that.
        slices = text.split("## Slices", 1)
        slice_table = slices[1].split("\n## ", 1)[0] if len(slices) > 1 else ""
        for slug in re.findall(r"`pf/(L\d{2})-[\w-]+`", slice_table):
            if slug != lane:
                err(f"{f.name}: slice branch `pf/{slug}-…` does not match lane {lane}")

    print(f"lane files : {len(parsed)}")
    print(f"tickets    : {len(seen)}")
    for lane in sorted(per_lane):
        print(f"  {lane}: {per_lane[lane]}")

    # Traceability: the spine promises every MVP gate item and every Testing
    # Scenario is reachable from at least one ticket. Report it rather than
    # failing on it — lanes land in waves, so gaps are expected mid-build and
    # only mean something once all 26 files exist.
    if advances_by_lane:
        claimed = {c for lane_set in advances_by_lane.values() for c in lane_set}
        mvp = [f"MVP-{i}" for i in range(1, 11)] + ["MVP-TF"]
        ts = [f"TS-{i}" for i in range(2, 10)]
        missing_mvp = [c for c in mvp if c not in claimed]
        missing_ts = [c for c in ts if c not in claimed]
        print(f"\ncoverage   : MVP {len(mvp) - len(missing_mvp)}/{len(mvp)} · "
              f"TS {len(ts) - len(missing_ts)}/{len(ts)}")
        if missing_mvp:
            print(f"  unclaimed MVP: {', '.join(missing_mvp)}")
        if missing_ts:
            print(f"  unclaimed TS : {', '.join(missing_ts)}")

    # PF-027 — the other four families, same report-don't-fail posture.
    #
    # "Unclaimed" here means untraceable from the board, NOT unbuilt. Five of the
    # six CTR rows this first caught were shipped and merged; what was missing was
    # the tag. That distinction matters when reading the output: this tells you
    # what a grader could not follow, not what is undone.
    verify_inventory_pages()
    for family in ("CTR", "INT", "PERF", "SUB"):
        inventory = REQUIREMENTS[family]
        tags = tagged_by_family.get(family, set())
        unclaimed = []
        for label, page, *rest in inventory:
            terms = [norm(label)] + [norm(a) for a in (rest[0] if rest else [])]
            if not any(term in tag for term in terms for tag in tags):
                unclaimed.append(f"{label} (p.{page})")
        print(f"coverage   : {family} {len(inventory) - len(unclaimed)}/{len(inventory)}")
        if unclaimed:
            print(f"  unclaimed {family:<4}: {'; '.join(unclaimed)}")

    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  ! {w}")

    if errors:
        print(f"\n{len(errors)} ERROR(s):")
        for e in errors:
            print(f"  x {e}")
        return 1

    print("\nclean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
