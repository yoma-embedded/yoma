"""connections — re-express a controller_map JSON as lean connection records: where each
controller pin goes (to what kind of device) and what circuit each connection crosses, with
component values preserved (L1 — no electrical interpretation). Pure post-processor over
controller_map's JSON output. See docs/specs/2026-06-09-controller-connections-design.md.

Each connection is one flat record:
    {"pin","net","to","class","value","via":[{"ref","value","kind"}],"dnf"}
where `to` is "REF.PIN" for a device or the rail name for a power/gnd termination
(`class == "rail"` disambiguates); `value` is the destination part's value (null for a rail).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from .netlist_model import natkey

TOOL_NAME = "connections v0.1.0"

# Endpoint device class by leading-alpha ref token (factual, prefix-based — L1, no electrical
# interpretation). A rail termination is class "rail" regardless of prefix. Keyed on the FULL
# leading-alpha token so "LED2"->"LED"->led and "L4"->"L"->passive never collide.
_ENDPOINT_CLASS = {
    "P": "connector", "J": "connector",
    "U": "ic",
    "LED": "led",
    "TP": "testpoint",
    "Y": "crystal", "X": "crystal",
    "SW": "switch", "S": "switch",
    "D": "diode", "Q": "transistor", "K": "relay",
    "FB": "passive", "FL": "passive", "R": "passive", "L": "passive", "C": "passive",
    "SB": "bridge", "JP": "bridge", "LK": "bridge",
}


def _leading_alpha(ref: str) -> str:
    m = re.match(r"[A-Za-z]+", ref)
    return m.group(0) if m else ""


def _endpoint_class(endpoint: dict | None, rail: str | None) -> str:
    if rail is not None:
        return "rail"
    if endpoint is None:
        return "other"
    return _ENDPOINT_CLASS.get(_leading_alpha(endpoint["ref"]).upper(), "other")


def _to(endpoint: dict | None, rail: str | None) -> str | None:
    """Destination as a single token: 'REF.PIN' for a device, or the rail name for a rail."""
    if rail is not None:
        return rail
    if endpoint is None:
        return None
    return f"{endpoint['ref']}.{endpoint['pin']}"


def _lean_via(via: list[dict]) -> list[dict]:
    """Keep only what a reader needs from each crossed part: ref, value, kind. The component
    value (e.g. '100k', '150R') is preserved verbatim — that is the no-loss guarantee."""
    return [{"ref": v["ref"], "value": v["value"], "kind": v["kind"]} for v in via]


def build_connections(cmap: dict) -> list[dict]:
    """Flatten every signal pin's traced[] into one lean, deterministically-sorted connection
    record each. Each record carries both the destination (to/class/value) and the via path."""
    conns: list[dict] = []
    for p in cmap["signal_pins"]:
        for t in p["traced"]:
            ep, rail = t["endpoint"], t["rail"]
            conns.append({
                "pin": p["pin"],
                "net": p["net"],
                "to": _to(ep, rail),
                "class": _endpoint_class(ep, rail),
                "value": ep["value"] if ep else None,
                "via": _lean_via(t["via"]),
                "dnf": t["dnf"],
            })
    conns.sort(key=lambda c: (natkey(c["pin"]), natkey(c["to"] or "")))
    return conns


def to_destinations(conns: list[dict]) -> list[dict]:
    """View 1 (去向): per pin, the distinct destinations it reaches (device or rail). A
    destination's `dnf` is True only if EVERY path to it is open (factual aggregation)."""
    groups: dict[str, dict] = {}
    for c in conns:
        g = groups.setdefault(c["pin"], {"pin": c["pin"], "net": c["net"], "_d": {}})
        d = g["_d"].get(c["to"])
        if d is None:
            g["_d"][c["to"]] = {"to": c["to"], "class": c["class"],
                                "value": c["value"], "dnf": c["dnf"]}
        else:
            d["dnf"] = d["dnf"] and c["dnf"]
    out: list[dict] = []
    for g in groups.values():
        dests = list(g.pop("_d").values())
        dests.sort(key=lambda d: natkey(d["to"] or ""))
        g["dests"] = dests
        out.append(g)
    out.sort(key=lambda g: natkey(g["pin"]))
    return out


def to_paths(conns: list[dict]) -> list[dict]:
    """View 2 (途经电路): each connection with the circuit it crosses, values intact."""
    return [{"pin": c["pin"], "net": c["net"], "to": c["to"], "via": c["via"], "dnf": c["dnf"]}
            for c in conns]


# ----------------------------------------------------------------------------- CLI

def _header(cmap: dict) -> dict:
    ctrl = cmap.get("controller") or {}
    return {
        "source": cmap.get("source"),
        "format": cmap.get("format"),
        "controller": {"ref": ctrl.get("ref"), "part": ctrl.get("part")},
    }


def canonical_doc(cmap: dict, conns: list[dict]) -> dict:
    return {**_header(cmap), "connections": conns}


def destinations_doc(cmap: dict, conns: list[dict]) -> dict:
    return {**_header(cmap), "pins": to_destinations(conns)}


def paths_doc(cmap: dict, conns: list[dict]) -> dict:
    return {**_header(cmap), "paths": to_paths(conns)}


def load_input(path: Path | None) -> dict:
    text = path.read_text(encoding="utf-8") if path is not None else sys.stdin.read()
    data = json.loads(text)
    if not isinstance(data, dict) or "signal_pins" not in data:
        raise SystemExit("error: input is not a controller_map JSON (no 'signal_pins' key)")
    return data


def _dump(obj: dict, out_path: str | None) -> None:
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    if out_path is not None:
        print(f"Writing {out_path}", file=sys.stderr)
        Path(out_path).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="connections",
        description="Re-express a controller_map JSON as lean connection records: where each "
        "pin goes (to what kind of device) and what circuit each connection crosses. Reads "
        "the JSON from a file or stdin; JSON to stdout (or --output), diagnostics to stderr.",
    )
    ap.add_argument("input", nargs="?", help="controller_map JSON file (stdin if omitted)")
    ap.add_argument("--view", choices=["canonical", "destinations", "paths"],
                    default="canonical", help="which view to emit (default: canonical)")
    ap.add_argument("--output", help="write JSON here (stdout if omitted)")
    ap.add_argument("--split", action="store_true",
                    help="write all three views to <stem>_{connections,destinations,paths}.json")
    ap.add_argument("--version", action="version", version=TOOL_NAME)
    args = ap.parse_args()

    cmap = load_input(Path(args.input) if args.input else None)
    conns = build_connections(cmap)

    if args.split:
        stem_src = args.output or args.input
        if not stem_src:
            raise SystemExit("error: --split needs --output or an input path to derive a stem")
        stem = Path(stem_src).with_suffix("")
        _dump(canonical_doc(cmap, conns), f"{stem}_connections.json")
        _dump(destinations_doc(cmap, conns), f"{stem}_destinations.json")
        _dump(paths_doc(cmap, conns), f"{stem}_paths.json")
        return

    builder = {"canonical": canonical_doc, "destinations": destinations_doc,
               "paths": paths_doc}[args.view]
    _dump(builder(cmap, conns), args.output)


if __name__ == "__main__":
    main()
