#!/usr/bin/env python3
"""
Stop hook: enforce that claims about the ShipShape brief are backed by real citations.

Reads the hook payload on stdin, pulls the last assistant message out of the
transcript, and checks three things:

  1. If the message asserts what the brief requires, it must cite a page (p.N).
  2. Any quoted phrase must actually appear in the PRD text, on the page cited.
  3. If the message proposes work, it must map that work back to a page — every
     action item traces to the brief, or is explicitly declared as not brief-driven.

Check 3 is the one that catches drift. Inventing plausible-sounding work is the
default failure mode on a long project: the task list slowly stops matching the
document being graded. Requiring a page number per action item makes an unmapped
task impossible to state casually, and the escape hatch (ORIGIN_DISCLAIMERS) means
genuinely self-directed work is declared as such rather than dressed in a citation.

Page text lives in .claude/prd/page-N.txt, extracted from the source PDF with
pdftotext -layout. Regenerate with .claude/hooks/extract-prd.sh if the PDF changes.

Exit 0 = allow. Prints {"decision":"block","reason":...} to allow-with-feedback.
"""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PRD_DIR = REPO / ".claude" / "prd"
MANIFEST = PRD_DIR / "source.json"
STATE_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "shipshape-citation-hook"
# After this many consecutive blocks on one session, stand down. A hook that
# can't be satisfied is worse than no hook.
MAX_BLOCKS = 2

# Language that asserts what the brief demands. Deliberately narrow: prose that
# merely mentions the audit shouldn't trip this.
CLAIM_PATTERNS = [
    r"\bthe (?:brief|prd|spec|rubric)\b[^.\n]{0,60}\b(?:says|requires|states|demands|calls for|mandates)",
    r"\b(?:required|requires|mandated|mandatory)\b[^.\n]{0,40}\b(?:by|per|under)\b[^.\n]{0,30}\b(?:brief|prd|spec|rubric|requirement)",
    r"\bper the (?:brief|prd|spec|rubric|requirements?)\b",
    r"\baccording to the (?:brief|prd|spec|rubric)\b",
    r"\bImplementation Rule\s+\d+",
    r"\bCategory\s+\d+\b[^.\n]{0,60}\b(?:requires|demands|target|deliverable|says)",
    r"\bhard gate\b",
    r"\bautomatic fail\b",
]

# Language that proposes work: commitments, recommendations, and next-step framing.
# Matched against the message, then gated on DOMAIN_TOKENS below so ordinary
# conversation about the code doesn't demand a page number.
ACTION_PATTERNS = [
    r"\bnext (?:step|up|action|task)s?\b",
    r"\b(?:first|start) (?:up|with|by|here)\b",
    r"\bI'?ll (?:build|write|add|start|implement|create|wire|fix|set up|do)\b",
    r"\b(?:we|you) (?:should|need to|have to|must) (?:build|write|add|start|implement|create|wire|fix|do)\b",
    r"\blet'?s (?:build|write|add|start|implement|create|wire|fix|do|tackle)\b",
    r"\bplan (?:of attack|is)\b",
    r"\b(?:road ?map|work ?stream|action items?|to-?do list)\b",
    r"\brecommend(?:ed)? (?:order|sequence|starting)\b",
]

# ShipShape-specific vocabulary. An action proposal only needs a citation if it is
# about the graded work; "let's fix this typo" is not a submission requirement.
DOMAIN_TOKENS = [
    r"\bcategor(?:y|ies)\b",
    r"\bimplementation rule\b",
    r"\brule\s+\d+\b",
    r"\bphase\s+[12]\b",
    r"\bdeliverable\b",
    r"\bsubmission\b",
    r"\bimprovement target\b",
    r"\bbaseline\b",
    r"\baudit report\b",
    r"\bdiscovery (?:write-?up|requirement)\b",
    r"\bdemo video\b",
    r"\bcost analysis\b",
    r"\bblast radius\b",
    r"\bdrift detection\b",
]

# Declaring work as self-directed satisfies check 3. Without this, the hook would
# force a fabricated citation onto legitimately self-directed work — which is the
# exact failure it exists to prevent, inverted.
ORIGIN_DISCLAIMERS = [
    r"\bnot brief-driven\b",
    r"\bnot (?:in|from) the brief\b",
    r"\bours,? not the brief'?s\b",
    r"\bour (?:own )?(?:decision|call|choice)\b",
    r"\bbrief (?:does not|doesn'?t) (?:specify|say|mention|require)\b",
    r"\bno page (?:for this|covers this)\b",
]

# p.4  ·  p. 4  ·  pp.4-5  ·  page 4  ·  pages 4-5
CITATION_RE = re.compile(r"\bpp?\.?\s?(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b|\bpages?\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b", re.I)

# Quoted spans worth verifying: markdown blockquotes and "double quotes".
BLOCKQUOTE_RE = re.compile(r"^>\s?(.+)$", re.M)
DQUOTE_RE = re.compile(r"[\"“]([^\"”\n]{25,400})[\"”]")

MIN_QUOTE_WORDS = 6


def norm(text: str) -> str:
    """Collapse whitespace and smart punctuation so PDF line wrapping doesn't matter."""
    text = text.replace("’", "'").replace("‘", "'")
    text = text.replace("“", '"').replace("”", '"')
    text = text.replace("—", "-").replace("–", "-").replace("−", "-")
    return re.sub(r"\s+", " ", text).strip().lower()


def load_manifest():
    """Which document is the current source of truth, and is our text still from it?

    Returns (manifest, staleness_problem). A staleness problem means the extracted
    text can no longer be trusted to represent the named brief.
    """
    if not MANIFEST.exists():
        return None, None  # not configured; fail open
    try:
        m = json.loads(MANIFEST.read_text())
    except (OSError, json.JSONDecodeError):
        return None, None

    pdf = Path(m.get("path", ""))
    if not pdf.exists():
        return m, (
            f"Source brief is missing: {pdf}\n"
            f"    Expected '{m.get('label')}'. Restore it, or re-point the hook:\n"
            f"    .claude/hooks/extract-prd.sh <new-brief.pdf> \"<label>\""
        )

    h = hashlib.sha256()
    try:
        with pdf.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return m, None
    if h.hexdigest() != m.get("sha256"):
        return m, (
            f"Source brief has changed since extraction: {pdf}\n"
            f"    The page text still reflects the old '{m.get('label')}'.\n"
            f"    Re-run: .claude/hooks/extract-prd.sh"
        )
    return m, None


def load_pages(max_page: int):
    pages = {}
    for n in range(1, max_page + 1):
        f = PRD_DIR / f"page-{n}.txt"
        if f.exists():
            pages[n] = norm(f.read_text(errors="replace"))
    return pages


def last_assistant_text(transcript_path: str) -> str:
    p = Path(transcript_path)
    if not p.exists():
        return ""
    chunks = []
    try:
        lines = p.read_text(errors="replace").splitlines()
    except OSError:
        return ""
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") == "user":
            break  # walked back past our own turn
        if rec.get("type") != "assistant":
            continue
        content = rec.get("message", {}).get("content", [])
        if isinstance(content, str):
            chunks.append(content)
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                chunks.append(block.get("text", ""))
    return "\n".join(reversed(chunks))


def cited_pages(text: str):
    out = set()
    for m in CITATION_RE.finditer(text):
        start = m.group(1) or m.group(3)
        end = m.group(2) or m.group(4)
        if not start:
            continue
        a = int(start)
        b = int(end) if end else a
        if a > b:
            a, b = b, a
        out.update(range(a, b + 1))
    return out


def extract_quotes(text: str):
    quotes = []
    for m in BLOCKQUOTE_RE.finditer(text):
        quotes.append(m.group(1).strip())
    for m in DQUOTE_RE.finditer(text):
        quotes.append(m.group(1).strip())
    # Drop anything too short to be a meaningful verbatim claim, and anything
    # that's obviously a file path, command, or identifier rather than prose.
    keep = []
    for q in quotes:
        if len(q.split()) < MIN_QUOTE_WORDS:
            continue
        if re.search(r"[/\\]|\$\(|`|^\w+\(\)", q):
            continue
        keep.append(q)
    return keep


def state_file(session_id: str) -> Path:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "nosession")
    return STATE_DIR / f"{safe}.count"


def read_count(f: Path) -> int:
    try:
        return int(f.read_text().strip())
    except (OSError, ValueError):
        return 0


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    session_id = payload.get("session_id", "")
    counter = state_file(session_id)

    text = last_assistant_text(payload.get("transcript_path", ""))
    if not text.strip():
        counter.write_text("0")
        sys.exit(0)

    manifest, stale = load_manifest()
    max_page = (manifest or {}).get("pages", 0)
    pages = load_pages(max_page) if max_page else {}
    if not pages:
        sys.exit(0)  # nothing to verify against; never block on our own misconfig

    problems = []
    if stale:
        problems.append(stale)

    cites = cited_pages(text)
    makes_claim = any(re.search(p, text, re.I) for p in CLAIM_PATTERNS)

    if makes_claim and not cites:
        problems.append(
            "States what the brief requires but cites no page. Add a p.N citation, "
            "or drop the requirement framing if you are not actually claiming it."
        )

    # Check 3: work proposed must trace to a page, or be declared self-directed.
    proposes_work = any(re.search(p, text, re.I) for p in ACTION_PATTERNS)
    in_domain = any(re.search(p, text, re.I) for p in DOMAIN_TOKENS)
    disclaims = any(re.search(p, text, re.I) for p in ORIGIN_DISCLAIMERS)
    if proposes_work and in_domain and not cites and not disclaims:
        problems.append(
            "Proposes work on the graded deliverables but maps it to nothing. Every action "
            "item needs the p.N it comes from, so the task list cannot drift away from the "
            "document being graded. If this work is genuinely self-directed, say so outright "
            "(e.g. 'the brief does not specify this') rather than attaching a citation to it."
        )

    label = (manifest or {}).get("label", "the brief")
    for n in sorted(cites):
        if n < 1 or n > max_page:
            problems.append(f"Cited p.{n}, but {label} is only {max_page} pages.")

    haystack_all = "\n".join(pages.values())
    for q in extract_quotes(text):
        nq = norm(q)
        if nq in haystack_all:
            if cites and not any(nq in pages.get(n, "") for n in cites):
                found_on = [str(n) for n in sorted(pages) if nq in pages[n]]
                problems.append(
                    f'Quote "{q[:70]}..." is real but appears on p.{",".join(found_on)}, '
                    f'not the page(s) you cited ({",".join(str(c) for c in sorted(cites))}).'
                )
        else:
            problems.append(
                f'Quote "{q[:70]}..." does not appear anywhere in the brief. '
                "Either it is paraphrase presented as a quotation, or it is fabricated. "
                "Quote verbatim or drop the quotation marks."
            )

    if not problems:
        counter.write_text("0")
        sys.exit(0)

    n_blocked = read_count(counter)
    if n_blocked >= MAX_BLOCKS:
        counter.write_text("0")
        print(json.dumps({
            "systemMessage": "PRD citation check still failing after "
                             f"{MAX_BLOCKS} attempts — standing down for this turn.\n  - "
                             + "\n  - ".join(problems)
        }))
        sys.exit(0)

    counter.write_text(str(n_blocked + 1))
    print(json.dumps({
        "decision": "block",
        "reason": f"Citation check failed against {label}. Fix these before finishing:\n  - "
                  + "\n  - ".join(problems)
                  + f"\n\nPage text: .claude/prd/page-N.txt (N = 1..{max_page}). "
                    "Verify with grep before re-asserting.",
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
