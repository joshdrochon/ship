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

        for slug in re.findall(r"`pf/(L\d{2})-[\w-]+`", text):
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
