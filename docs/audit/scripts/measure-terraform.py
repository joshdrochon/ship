#!/usr/bin/env python3
"""
Category 8 - Terraform Plan Review: canonical measurement.

Reproduces every number quoted in docs/audit/cat8-terraform.md:
  * .tf file count and per-root/per-module resource, data and module block counts
  * provider requirements per root (source + version constraint)
  * pinned-vs-constrained classification of every constraint
  * .terraform.lock.hcl presence, the versions each lock records, and whether
    the locked version actually satisfies the constraint the config declares
  * git-tracked-vs-gitignored status of lock files and saved plan files

Written in Python deliberately: shell/regex counting produced wrong numbers
twice on this project (see the Category 1 and Category 2 re-baselines).
HCL blocks are counted with a brace-depth scanner that strips comments and
string literals first, so `#` inside a string or `{` inside a jsonencode()
body cannot skew the count.

Usage:
    docs/audit/scripts/measure-terraform.py            # human-readable report
    docs/audit/scripts/measure-terraform.py --json     # machine-readable
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TF_DIR = REPO / "terraform"

# A "root" is a directory Terraform would be run from (has a backend or a
# provider block). A "module" is one that is only ever consumed via source=.
LEGACY_ROOTS = ["", "bootstrap", "environments/dev", "environments/shadow", "environments/prod"]

# Phase 2 roots (lane 8). Kept in a separate list so the legacy AWS baseline
# above stays byte-identical to what the audit measured, and skipped when the
# directory is absent so this script still runs against a pre-lane-8 checkout —
# which is what makes the before/after comparison the same script on both sides.
PHASE2_ROOTS = ["local-config", "render"]

ROOTS = LEGACY_ROOTS + [r for r in PHASE2_ROOTS if (TF_DIR / r).is_dir()]

MODULES = [
    "modules/aurora",
    "modules/cloudfront-s3",
    "modules/elastic-beanstalk",
    "modules/security-groups",
    "modules/ssm",
    "modules/vpc",
]


# --------------------------------------------------------------------------
# HCL scanning
# --------------------------------------------------------------------------
def strip_noise(src: str) -> str:
    """Remove comments and string-literal contents, preserving offsets.

    Replaces the *contents* of strings with spaces rather than deleting them,
    so that braces and '#' inside a string or heredoc cannot be miscounted as
    HCL syntax. Line structure is preserved so line numbers stay valid.
    """
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        # line comments
        if c == "#" or (c == "/" and i + 1 < n and src[i + 1] == "/"):
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        # block comments
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            out.append("  ")
            i += 2
            continue
        # heredocs: <<EOT ... EOT  /  <<-EOT ... EOT
        m = re.match(r"<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n", src[i:])
        if m:
            tag = m.group(1)
            out.append(" " * m.end())
            i += m.end()
            end = re.search(rf"^\s*{re.escape(tag)}\s*$", src[i:], re.MULTILINE)
            stop = i + end.start() if end else n
            while i < stop:
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            continue
        # quoted strings
        if c == '"':
            out.append('"')
            i += 1
            while i < n and src[i] != '"':
                if src[i] == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            if i < n:
                out.append('"')
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


BLOCK_RE = re.compile(
    r'^[ \t]*(resource|data|module|provider|variable|output|terraform)\b([^\n{]*)\{',
    re.MULTILINE,
)


def scan_blocks(path: Path):
    """Return top-level block records for one .tf file."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    clean = strip_noise(raw)

    # depth at each offset, so we can keep only depth-0 (top-level) blocks
    depth, depths = 0, []
    for ch in clean:
        depths.append(depth)
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1

    blocks = []
    for m in BLOCK_RE.finditer(clean):
        if depths[m.start(1)] != 0:
            continue  # nested (e.g. a `terraform {}` inside something else)
        labels = re.findall(r'"([^"]*)"', raw[m.start(2) + m.start() - m.start(): m.end(2)])
        # re-extract labels from the raw text on the same line for fidelity
        line_start = raw.rfind("\n", 0, m.start()) + 1
        line_end = raw.find("{", m.start())
        labels = re.findall(r'"([^"]*)"', raw[line_start:line_end])
        blocks.append(
            {
                "kind": m.group(1),
                "labels": labels,
                "line": clean.count("\n", 0, m.start()) + 1,
            }
        )
    return blocks


def scan_dir(rel: str):
    d = TF_DIR / rel if rel else TF_DIR
    files = sorted(p for p in d.glob("*.tf"))
    counts = {"resource": 0, "data": 0, "module": 0}
    resources, modules = [], []
    for f in files:
        for b in scan_blocks(f):
            if b["kind"] in counts:
                counts[b["kind"]] += 1
            if b["kind"] == "resource" and len(b["labels"]) >= 2:
                resources.append(
                    {"type": b["labels"][0], "name": b["labels"][1],
                     "file": f.name, "line": b["line"]}
                )
            if b["kind"] == "module" and b["labels"]:
                modules.append(b["labels"][0])
    return {
        "dir": rel or ".",
        "tf_files": [f.name for f in files],
        "counts": counts,
        "resources": resources,
        "module_calls": modules,
    }


# --------------------------------------------------------------------------
# providers / versions / locks
# --------------------------------------------------------------------------
REQUIRED_VERSION_RE = re.compile(r'required_version\s*=\s*"([^"]+)"')
PROVIDER_BLOCK_RE = re.compile(
    r'([A-Za-z0-9_-]+)\s*=\s*\{[^}]*?source\s*=\s*"([^"]+)"[^}]*?version\s*=\s*"([^"]+)"[^}]*?\}',
    re.DOTALL,
)

# An exactly-pinned constraint is a bare version or one prefixed with '='.
PINNED_RE = re.compile(r'^\s*=?\s*\d+\.\d+\.\d+\s*$')


def classify(constraint: str) -> str:
    parts = [p.strip() for p in constraint.split(",")]
    if all(PINNED_RE.match(p) for p in parts) and len(parts) == 1:
        return "pinned"
    return "constrained"


def read_requirements(rel: str):
    d = TF_DIR / rel if rel else TF_DIR
    req_version, providers = None, {}
    for f in sorted(d.glob("*.tf")):
        src = strip_noise_keep_strings(f.read_text(encoding="utf-8", errors="replace"))
        m = REQUIRED_VERSION_RE.search(src)
        if m and req_version is None:
            req_version = m.group(1)
        block = re.search(r"required_providers\s*\{(.*?)\n  \}", src, re.DOTALL)
        if block:
            for name, source, version in PROVIDER_BLOCK_RE.findall(block.group(1)):
                providers[name] = {
                    "source": source,
                    "constraint": version,
                    "status": classify(version),
                }
    return {"required_version": req_version, "providers": providers}


def strip_noise_keep_strings(src: str) -> str:
    """Strip only comments; keep string contents (we need to read them here)."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    out = []
    for line in src.split("\n"):
        in_str, buf = False, []
        i = 0
        while i < len(line):
            c = line[i]
            if c == '"' and (i == 0 or line[i - 1] != "\\"):
                in_str = not in_str
            if not in_str and (c == "#" or (c == "/" and i + 1 < len(line) and line[i + 1] == "/")):
                break
            buf.append(c)
            i += 1
        out.append("".join(buf))
    return "\n".join(out)


LOCK_PROVIDER_RE = re.compile(
    r'provider\s+"([^"]+)"\s*\{(.*?)\n\}', re.DOTALL
)


def read_lock(rel: str):
    d = TF_DIR / rel if rel else TF_DIR
    p = d / ".terraform.lock.hcl"
    if not p.exists():
        return None
    src = p.read_text(encoding="utf-8", errors="replace")
    out = {}
    for source, body in LOCK_PROVIDER_RE.findall(src):
        ver = re.search(r'version\s*=\s*"([^"]+)"', body)
        con = re.search(r'constraints\s*=\s*"([^"]+)"', body)
        hashes = len(re.findall(r'"(h1:|zh:)', body))
        out[source] = {
            "version": ver.group(1) if ver else None,
            "constraints": con.group(1) if con else None,
            "hash_count": hashes,
        }
    return out


def satisfies_tilde(version: str, constraint: str) -> bool | None:
    """Evaluate `~> X.Y` / `~> X.Y.Z` and exact `X.Y.Z` / `= X.Y.Z` pins.

    Exact pins were originally out of scope because the repo had none. Once lane 8
    pinned every constraint, returning None for them turned the
    constraint/lock-conflict check into a silent pass — it would have reported
    "none" while six module lock files still recorded aws 6.28.0 against a
    5.100.0 pin. Handled explicitly rather than skipped.
    """
    constraint = constraint.strip()
    exact = re.match(r"=?\s*(\d+\.\d+\.\d+)$", constraint)
    if exact:
        return version.strip() == exact.group(1)
    m = re.match(r"~>\s*(\d+)\.(\d+)(?:\.(\d+))?$", constraint)
    if not m:
        return None
    v = [int(x) for x in version.split(".")]
    major, minor, patch = int(m.group(1)), int(m.group(2)), m.group(3)
    if patch is None:  # ~> X.Y  => >= X.Y, < (X+1).0
        return v[0] == major and v[1] >= minor
    return v[0] == major and v[1] == minor and v[2] >= int(patch)


def git_tracked(paths):
    try:
        res = subprocess.run(
            ["git", "ls-files", "--"] + [str(p) for p in paths],
            cwd=REPO, capture_output=True, text=True, check=True,
        )
        return set(res.stdout.split())
    except Exception:
        return set()


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not TF_DIR.is_dir():
        sys.exit(f"no terraform/ directory at {TF_DIR}")

    report = {"roots": {}, "modules": {}, "totals": {}, "lock_status": {}, "git": {}}

    all_tf = sorted(TF_DIR.rglob("*.tf"))
    report["totals"]["tf_files"] = len(all_tf)

    grand = {"resource": 0, "data": 0, "module": 0}
    for group, names in (("roots", ROOTS), ("modules", MODULES)):
        for rel in names:
            info = scan_dir(rel)
            info["requirements"] = read_requirements(rel)
            info["lock"] = read_lock(rel)
            report[group][rel or "."] = info
            for k in grand:
                grand[k] += info["counts"][k]
    report["totals"]["blocks"] = grand

    # lock coverage + constraint satisfaction
    for group in ("roots", "modules"):
        for rel, info in report[group].items():
            lock = info["lock"]
            entry = {"has_lock": lock is not None, "group": group, "mismatches": []}
            if lock:
                entry["locked"] = {s: v["version"] for s, v in lock.items()}
                for source, rec in lock.items():
                    short = source.split("/")[-1]
                    decl = info["requirements"]["providers"].get(short)
                    if decl is None:
                        entry["mismatches"].append(
                            f"{source} {rec['version']} locked but no required_providers "
                            f"entry declares it here"
                        )
                        continue
                    ok = satisfies_tilde(rec["version"], decl["constraint"])
                    if ok is False:
                        entry["mismatches"].append(
                            f"{source} locked at {rec['version']} does NOT satisfy "
                            f"declared constraint {decl['constraint']}"
                        )
            report["lock_status"][rel] = entry

    locks = [TF_DIR / (r if r else ".") / ".terraform.lock.hcl" for r in ROOTS + MODULES]
    existing = [p for p in locks if p.exists()]
    tracked = git_tracked(existing)
    report["git"]["lock_files_on_disk"] = len(existing)
    report["git"]["lock_files_tracked"] = len(tracked)
    gi = (TF_DIR / ".gitignore")
    report["git"]["lock_in_gitignore"] = (
        ".terraform.lock.hcl" in gi.read_text().split() if gi.exists() else False
    )
    plans = [p for p in TF_DIR.rglob("*") if p.name in ("tfplan", "plan.out", "tfplan.binary")]
    report["git"]["saved_plan_files"] = [str(p.relative_to(REPO)) for p in plans]
    report["git"]["saved_plan_files_tracked"] = sorted(git_tracked(plans))

    if args.json:
        print(json.dumps(report, indent=2))
        return

    # ---------------- human-readable ----------------
    t = report["totals"]
    print("=" * 74)
    print("Category 8 - Terraform baseline")
    print("=" * 74)
    print(f"\n.tf files under terraform/ : {t['tf_files']}")
    print(f"resource blocks (all)      : {t['blocks']['resource']}")
    print(f"data blocks (all)          : {t['blocks']['data']}")
    print(f"module calls (all)         : {t['blocks']['module']}")

    print("\n--- Roots (directories terraform is run from) ---")
    print(f"{'root':<26}{'res':>5}{'data':>6}{'mod':>5}  {'req_version':<12} lock")
    for rel in ROOTS:
        i = report["roots"][rel or "."]
        c = i["counts"]
        lock = "yes" if i["lock"] else "NO"
        rv = i["requirements"]["required_version"] or "-"
        print(f"{(rel or 'terraform/'):<26}{c['resource']:>5}{c['data']:>6}{c['module']:>5}  {rv:<12} {lock}")

    print("\n--- Modules (consumed via source=) ---")
    print(f"{'module':<26}{'res':>5}{'data':>6}{'mod':>5}  {'req_version':<12} lock")
    for rel in MODULES:
        i = report["modules"][rel]
        c = i["counts"]
        lock = "yes" if i["lock"] else "NO"
        rv = i["requirements"]["required_version"] or "-"
        print(f"{rel:<26}{c['resource']:>5}{c['data']:>6}{c['module']:>5}  {rv:<12} {lock}")

    print("\n--- Provider requirements declared per root ---")
    for rel in ROOTS:
        i = report["roots"][rel or "."]
        provs = i["requirements"]["providers"]
        label = rel or "terraform/"
        if not provs:
            print(f"{label:<26} (none declared)")
        for name, p in sorted(provs.items()):
            print(f"{label:<26} {p['source']:<26} {p['constraint']:<10} {p['status'].upper()}")

    pinned = sum(
        1
        for g in ("roots", "modules")
        for i in report[g].values()
        for p in i["requirements"]["providers"].values()
        if p["status"] == "pinned"
    )
    total_decl = sum(
        1
        for g in ("roots", "modules")
        for i in report[g].values()
        for p in i["requirements"]["providers"].values()
    )
    print(f"\nprovider constraints declared: {total_decl}  |  exactly pinned: {pinned}  "
          f"|  range-constrained: {total_decl - pinned}")

    print("\n--- Lock files ---")
    print(f"on disk: {report['git']['lock_files_on_disk']}   "
          f"git-tracked: {report['git']['lock_files_tracked']}   "
          f"'.terraform.lock.hcl' listed in terraform/.gitignore: "
          f"{report['git']['lock_in_gitignore']}")
    for rel, e in report["lock_status"].items():
        if not e["has_lock"]:
            print(f"  MISSING  {rel}")
    for rel, e in report["lock_status"].items():
        if e["has_lock"]:
            vers = ", ".join(f"{k.split('/')[-1]}={v}" for k, v in e["locked"].items())
            print(f"  present  {rel:<24} {vers}")
    print("\n  constraint/lock conflicts:")
    any_mm = False
    for rel, e in report["lock_status"].items():
        for mm in e["mismatches"]:
            any_mm = True
            print(f"    {rel}: {mm}")
    if not any_mm:
        print("    none")

    print("\n--- Saved plan files committed to the repo ---")
    if report["git"]["saved_plan_files_tracked"]:
        for p in report["git"]["saved_plan_files_tracked"]:
            print(f"  TRACKED  {p}")
    else:
        print("  none tracked")
    print()


if __name__ == "__main__":
    main()
