#!/usr/bin/env python3
"""Render cargo-about's JSON (stdin) as THIRD-PARTY-CRATES.md (stdout).

The workspace's own crates (no registry source) are left out: they are PhotoSuite itself.
"""
import json
import sys


def third_party(krate):
    return krate.get("source") is not None


def fence(text):
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return ticks


def main():
    data = json.load(sys.stdin)
    crates = sorted(
        (c for c in data["crates"] if third_party(c["package"])),
        key=lambda c: (c["package"]["name"], c["package"]["version"]),
    )
    out = [
        "# Third-party Rust crates",
        "",
        "The PhotoSuite binaries link the Rust crates below, each used under the licence shown. The",
        "full licence texts follow, grouped by text. This file is generated from `Cargo.lock` by",
        "`packaging/notices/generate.sh` (cargo-about); don't edit it by hand. Other bundled material",
        "(fonts, icons, lens data, presets) is listed in `THIRD-PARTY-NOTICES.md`.",
        "",
        f"## Crates ({len(crates)})",
        "",
        "| Crate | Version | Licence |",
        "|:---|:---|:---|",
    ]
    for c in crates:
        p = c["package"]
        out.append(f"| [{p['name']}](https://crates.io/crates/{p['name']}) | {p['version']} | {c['license']} |")
    out += ["", "## Licence texts", ""]
    for lic in data["licenses"]:
        users = sorted(
            {(u["crate"]["name"], u["crate"]["version"]) for u in lic["used_by"] if third_party(u["crate"])}
        )
        if not users:
            continue
        text = lic["text"].strip("\n")
        f = fence(text)
        out += [
            f"### {lic['name']}",
            "",
            "Used by: " + ", ".join(f"{n} {v}" for n, v in users),
            "",
            f + "text",
            text,
            f,
            "",
        ]
    sys.stdout.write("\n".join(out))


if __name__ == "__main__":
    main()
