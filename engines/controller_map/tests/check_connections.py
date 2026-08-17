"""Reproducible verification for the connections post-processor (plain script, no pytest).

Builds each fixture's controller_map in-process (so it never depends on the gitignored
out/ artifacts), round-trips it through JSON (so sequences are lists — exactly what the CLI
receives reading a real .json), and exercises connections on it.
Run:  uv run python tests/check_connections.py
Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import sys
import tempfile
from pathlib import Path

from controller_map.controller_map import create_controller_map
from controller_map import connections as C
from controller_map.connections import build_connections, to_destinations, to_paths

FIX = Path(__file__).parent / "fixtures"
_checks = 0


def check(cond: bool, msg: str) -> None:
    global _checks
    _checks += 1
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  ok: {msg}")


def amap(path: Path, **kw) -> dict:
    """A controller_map as a plain JSON-shaped dict (what connections consumes). Round-trips
    through JSON so sequences are lists — exactly what the tool sees reading a real .json
    file (dataclasses.asdict alone would leave tuples, which the CLI never receives)."""
    cmap = create_controller_map(path, Path(os.devnull), **kw)
    return json.loads(json.dumps(dataclasses.asdict(cmap)))


def conns_for(cmap: dict, net: str) -> list[dict]:
    return [c for c in build_connections(cmap) if c["net"] == net]


def dests_for(dmap: list[dict], net: str) -> list[dict]:
    return next(g for g in dmap if g["net"] == net)["dests"]


rp = amap(FIX / "RP2040_kicad_netlist.xml")
na = amap(FIX / "pca10056.NET")
nu = amap(FIX / "pca10056.NET", main_controller="U1")

print("== canonical builder (lean) ==")
rc = build_connections(rp)
check(len(rc) == sum(len(p["traced"]) for p in rp["signal_pins"]),
      "round-trip: exactly one connection per traced entry (none dropped/duplicated)")
check(set(rc[0]) == {"pin", "net", "to", "class", "value", "via", "dnf"},
      "lean record keys are exactly: pin, net, to, class, value, via, dnf")

q = conns_for(rp, "/QSPI_SS")
check(len(q) == 3, f"QSPI_SS -> 3 connections (got {len(q)})")
check({c["to"]: c["class"] for c in q} == {"U2.1": "ic", "J2.1": "connector", "+3V3": "rail"},
      "QSPI_SS: to/class are U2.1 ic, J2.1 connector, +3V3 rail")
railc = next(c for c in q if c["class"] == "rail")
check(railc["to"] == "+3V3" and railc["dnf"] is True and railc["via"][0]["value"] == "DNF",
      "QSPI_SS +3V3 path: rail merged into 'to', dnf flagged, via value 'DNF' preserved")
check(set(railc["via"][0]) == {"ref", "value", "kind"},
      "via entry is lean: ref, value, kind (no pin_in/pin_out/dnf)")

print("== destinations view (去向) ==")
nud = to_destinations(build_connections(nu))
got = {(d["to"], d["class"]) for d in dests_for(nud, "P0.14")}
check(got == {("P24.4", "connector"), ("LED2.1", "led")},
      "P0.14 destinations: P24.4 connector + LED2.1 led")

nad = to_destinations(build_connections(na))
keys = {(d["to"], d["class"]) for d in dests_for(nad, "IMCU_RESET")}
check(keys == {("J4.10", "connector"), ("TP50.1", "testpoint"), ("VDD_IMCU", "rail")},
      "IMCU_RESET destinations: J4.10 connector, TP50.1 testpoint, VDD_IMCU rail")

print("== paths view (途经电路) — values preserved ==")
np_ = to_paths(build_connections(nu))
p014 = [p for p in np_ if p["net"] == "P0.14"]  # scope: P24 is a shared header on many nets
led = next(p for p in p014 if p["to"] == "LED2.1")
check(led["via"][0]["ref"] == "SB6" and led["via"][0]["kind"] == "solderbridge",
      "P0.14 -> LED2.1 path crosses closed solder bridge SB6")
p24 = next(p for p in p014 if p["to"] == "P24.4")
check(p24["via"] == [], "P0.14 -> P24.4 is a direct path (no via)")

nap = to_paths(build_connections(na))
rstrail = next(p for p in nap if p["pin"] == "AC31" and p["to"] == "VDD_IMCU")
check(rstrail["via"][0]["value"] == "100k",
      "IMCU_RESET pull-up path preserves 100k value (no-loss; L1 does not label it)")
swd = [p for p in nap if p["pin"] == "AK28"]
check(len(swd) == 2 and all(p["via"][0]["value"] == "150R" for p in swd),
      "SWD1_CLK: both paths preserve the 150R series value")

print("== CLI + slim header ==")
tmp = Path(tempfile.mkdtemp())
mp = tmp / "rp_map.json"
mp.write_text(json.dumps(rp), encoding="utf-8")

buf = io.StringIO()
sys.argv = ["connections", str(mp), "--view", "destinations"]
with contextlib.redirect_stdout(buf):
    C.main()
doc = json.loads(buf.getvalue())
check(doc.get("source") == "RP2040_minimal_r2" and any(g["net"] == "/QSPI_SS" for g in doc["pins"]),
      "CLI --view destinations emits a lean doc (source + pins incl. QSPI_SS)")
check("tool" not in doc and set(doc["controller"]) == {"ref", "part"},
      "header is slim: no 'tool'; controller is just ref + part")

out = tmp / "rp.json"
sys.argv = ["connections", str(mp), "--output", str(out), "--split"]
with contextlib.redirect_stdout(io.StringIO()):
    C.main()
for suffix in ("connections", "destinations", "paths"):
    f = tmp / f"rp_{suffix}.json"
    check(f.exists(), f"--split wrote rp_{suffix}.json")

print(f"\nALL {_checks} CHECKS PASSED")
