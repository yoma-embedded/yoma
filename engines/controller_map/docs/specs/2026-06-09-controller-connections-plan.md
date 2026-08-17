# connections (L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `connections` post-processor that re-expresses a `controller_map` JSON as two lossless views — **destinations** (where each controller pin goes, to what kind of device) and **paths** (what circuit each connection crosses) — preserving every component value (L1: no electrical interpretation).

**Architecture:** A new stdlib-only module `controller_map/connections.py` reads the JSON that `controller_map` emits (file or stdin), flattens every `signal_pins[].traced[]` entry into one flat connection record (carrying both destination and the via path), then projects that canonical list into the two views. Pure post-processor — never touches the netlist parsers. A new console script `connections` makes it pipeable: `controller_map ... | connections --view destinations`.

**Tech Stack:** Python 3.13+, stdlib only (`json`, `argparse`, `re`, `sys`, `pathlib`); `uv` for run/sync; verification via a plain runnable assert script (project has no pytest convention).

**Spec:** `docs/specs/2026-06-09-controller-connections-design.md`.

> **Version control note:** This project is **not** git-initialized and the user has not requested commits, so each task ends with a **green test run** as its checkpoint instead of a commit. If you want history, run `git init` first and commit at each checkpoint.

---

## File Structure

- **Create** `controller_map/connections.py` — model-free dict transforms + `main()`. One responsibility: turn a controller_map dict into the canonical list and the two views. ~160 lines.
- **Create** `tests/check_connections.py` — runnable assert script mirroring `tests/check.py`'s style (`check(cond, msg)` helper, in-process map generation from the committed fixtures, exits non-zero on first failure).
- **Modify** `pyproject.toml:15-16` — add the `connections` console-script entry point.
- **Modify** `README.md` — short "Two views (`connections`)" usage section.

The canonical builder, the two projections, and `main()` all live in the one small module because they change together and share the `endpoint_class` map and sort key; splitting them would scatter one responsibility.

---

## Task 1: Canonical connection builder

**Files:**
- Create: `controller_map/connections.py`
- Test: `tests/check_connections.py`

- [ ] **Step 1: Write the failing test**

Create `tests/check_connections.py`:

```python
"""Reproducible verification for the connections post-processor (plain script, no pytest).

Builds each fixture's controller_map in-process (so it never depends on the gitignored
out/ artifacts), converts it to the JSON-shaped dict, and exercises connections on it.
Run:  uv run python tests/check_connections.py
Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

from controller_map.controller_map import create_controller_map
from controller_map.connections import build_connections

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
    """A controller_map as a plain JSON-shaped dict (what connections consumes)."""
    return dataclasses.asdict(create_controller_map(path, Path("/dev/null"), **kw))


def conns_for(cmap: dict, net: str) -> list[dict]:
    return [c for c in build_connections(cmap) if c["net"] == net]


rp = amap(FIX / "RP2040_kicad_netlist.xml")
na = amap(FIX / "pca10056.NET")
nu = amap(FIX / "pca10056.NET", main_controller="U1")

print("== canonical builder ==")
rc = build_connections(rp)
check(len(rc) == sum(len(p["traced"]) for p in rp["signal_pins"]),
      "round-trip: exactly one connection per traced entry (none dropped/duplicated)")

q = conns_for(rp, "/QSPI_SS")
check(len(q) == 3, f"QSPI_SS -> 3 connections (got {len(q)})")
cls = {(c["endpoint"]["ref"] if c["endpoint"] else f"RAIL:{c['rail']}"): c["endpoint_class"]
       for c in q}
check(cls == {"U2": "ic", "J2": "connector", "RAIL:+3V3": "rail"},
      "QSPI_SS endpoint_class: U2 ic, J2 connector, +3V3 rail")
railc = next(c for c in q if c["rail"] == "+3V3")
check(railc["dnf"] is True and railc["via"][0]["value"] == "DNF" and railc["hops"] == 1,
      "QSPI_SS +3V3 path: dnf flagged, via value 'DNF' preserved verbatim, hops==1")

print(f"\nALL {_checks} CHECKS PASSED")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/check_connections.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'controller_map.connections'`.

- [ ] **Step 3: Write minimal implementation**

Create `controller_map/connections.py`:

```python
"""connections — re-express a controller_map JSON as two lossless views: 'destinations'
(where each pin goes, to what kind of device) and 'paths' (what circuit each connection
crosses). Pure post-processor over controller_map's JSON output; preserves every component
value (L1 — no electrical interpretation). See
docs/specs/2026-06-09-controller-connections-design.md.
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


def build_connections(cmap: dict) -> list[dict]:
    """Flatten every signal pin's traced[] into one flat, deterministically-sorted connection
    record each. Each record carries BOTH the destination (endpoint/rail + class) and the via
    path (full values preserved verbatim), so it loses nothing."""
    conns: list[dict] = []
    for p in cmap["signal_pins"]:
        for t in p["traced"]:
            conns.append({
                "controller_pin": p["pin"],
                "pin_name": p["pin_name"],
                "net": p["net"],
                "endpoint": t["endpoint"],            # dict or None, copied through
                "rail": t["rail"],
                "endpoint_class": _endpoint_class(t["endpoint"], t["rail"]),
                "via": t["via"],                      # full raw values preserved
                "hops": len(t["via"]),
                "dnf": t["dnf"],
            })
    conns.sort(key=lambda c: (
        natkey(c["controller_pin"]),
        natkey(c["endpoint"]["ref"]) if c["endpoint"] else (),
        natkey(c["endpoint"]["pin"]) if c["endpoint"] else (),
        c["rail"] or "",
    ))
    return conns
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/check_connections.py`
Expected: PASS — ends with `ALL 4 CHECKS PASSED`.

- [ ] **Step 5: Checkpoint**

Run the full existing suite to confirm nothing regressed:
Run: `uv run python tests/check.py`
Expected: `ALL 21 CHECKS PASSED`.
(Optional commit if you ran `git init`: `git add -A && git commit -m "feat(connections): canonical connection builder"`.)

---

## Task 2: The two projections — destinations & paths

**Files:**
- Modify: `controller_map/connections.py` (add two functions after `build_connections`)
- Test: `tests/check_connections.py` (add a block before the final `print`)

- [ ] **Step 1: Write the failing test**

In `tests/check_connections.py`, add this import to the existing import line:

```python
from controller_map.connections import build_connections, to_destinations, to_paths
```

Then insert this block **immediately before** the final `print(f"\nALL {_checks} CHECKS PASSED")` line:

```python
def dests_for(dmap: list[dict], net: str) -> list[dict]:
    return next(g for g in dmap if g["net"] == net)["destinations"]


print("== destinations view (去向) ==")
nud = to_destinations(build_connections(nu))
got = {(d["ref"], d["class"]) for d in dests_for(nud, "P0.14")}
check(got == {("P24", "connector"), ("LED2", "led")},
      "P0.14 destinations: P24 connector + LED2 led")

nad = to_destinations(build_connections(na))
keys = {(d["ref"], d["rail"], d["class"]) for d in dests_for(nad, "IMCU_RESET")}
check(keys == {("J4", None, "connector"), ("TP50", None, "testpoint"),
               (None, "VDD_IMCU", "rail")},
      "IMCU_RESET destinations: J4 connector, TP50 testpoint, VDD_IMCU rail")

print("== paths view (途经电路) — full values preserved ==")
np_ = to_paths(build_connections(nu))
led = next(p for p in np_ if p["to"] and p["to"]["ref"] == "LED2")
check(led["via"][0]["ref"] == "SB6" and led["via"][0]["kind"] == "solderbridge",
      "P0.14 -> LED2 path crosses closed solder bridge SB6")
p24 = next(p for p in np_ if p["to"] and p["to"]["ref"] == "P24")
check(p24["via"] == [] and p24["hops"] == 0, "P0.14 -> P24 is a direct path (no via)")

nap = to_paths(build_connections(na))
rstrail = next(p for p in nap if p["controller_pin"] == "AC31" and p["rail"] == "VDD_IMCU")
check(rstrail["to"] is None and rstrail["via"][0]["value"] == "100k",
      "IMCU_RESET pull-up path preserves 100k value (no-loss; L1 does not label it a pull-up)")
swd = [p for p in nap if p["controller_pin"] == "AK28"]
check(len(swd) == 2 and all(p["via"][0]["value"] == "150R" for p in swd),
      "SWD1_CLK: both paths preserve the 150R series value")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/check_connections.py`
Expected: FAIL — `ImportError: cannot import name 'to_destinations' from 'controller_map.connections'`.

- [ ] **Step 3: Write minimal implementation**

In `controller_map/connections.py`, add after `build_connections`:

```python
def to_destinations(conns: list[dict]) -> list[dict]:
    """View 1 (去向): per pin, the distinct destinations it reaches (device or rail). A
    destination's `dnf` is True only if EVERY traced path to it is open (factual aggregation
    of the per-path flags, not interpretation)."""
    groups: dict[str, dict] = {}
    for c in conns:
        g = groups.setdefault(c["controller_pin"], {
            "controller_pin": c["controller_pin"],
            "pin_name": c["pin_name"],
            "net": c["net"],
            "_d": {},
        })
        ep, rail = c["endpoint"], c["rail"]
        key = ("rail", rail) if rail is not None else (ep["ref"], ep["pin"])
        d = g["_d"].get(key)
        if d is None:
            g["_d"][key] = {
                "ref": ep["ref"] if ep else None,
                "pin": ep["pin"] if ep else None,
                "value": ep["value"] if ep else None,
                "rail": rail,
                "class": c["endpoint_class"],
                "dnf": c["dnf"],
            }
        else:
            d["dnf"] = d["dnf"] and c["dnf"]
    out: list[dict] = []
    for g in groups.values():
        dests = list(g.pop("_d").values())
        dests.sort(key=lambda d: (
            natkey(d["ref"]) if d["ref"] else (),
            natkey(d["pin"]) if d["pin"] else (),
            d["rail"] or "",
        ))
        g["destinations"] = dests
        out.append(g)
    out.sort(key=lambda g: natkey(g["controller_pin"]))
    return out


def to_paths(conns: list[dict]) -> list[dict]:
    """View 2 (途经电路): each connection with the circuit it crosses, full values intact.
    `to` is the endpoint ref/pin, or None for a rail termination (then `rail` is set)."""
    paths: list[dict] = []
    for c in conns:
        ep = c["endpoint"]
        paths.append({
            "controller_pin": c["controller_pin"],
            "net": c["net"],
            "to": {"ref": ep["ref"], "pin": ep["pin"]} if ep else None,
            "rail": c["rail"],
            "via": c["via"],
            "hops": c["hops"],
            "dnf": c["dnf"],
        })
    return paths
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/check_connections.py`
Expected: PASS — ends with `ALL 10 CHECKS PASSED`.

- [ ] **Step 5: Checkpoint**

Run: `uv run python tests/check_connections.py`
Expected: `ALL 10 CHECKS PASSED`.
(Optional commit: `git add -A && git commit -m "feat(connections): destinations + paths projections"`.)

---

## Task 3: CLI `main()`, doc wrappers, console script

**Files:**
- Modify: `controller_map/connections.py` (add doc wrappers, `load_input`, `main`, `__main__`)
- Modify: `pyproject.toml:15-16`
- Test: `tests/check_connections.py` (add a CLI block before the final `print`)

- [ ] **Step 1: Write the failing test**

In `tests/check_connections.py`, add to the top imports:

```python
import contextlib
import io
import json
import tempfile
from controller_map import connections as C
```

Insert this block **immediately before** the final `print(f"\nALL {_checks} CHECKS PASSED")` line:

```python
print("== CLI ==")
tmp = Path(tempfile.mkdtemp())
mp = tmp / "rp_map.json"
mp.write_text(json.dumps(rp), encoding="utf-8")

buf = io.StringIO()
sys.argv = ["connections", str(mp), "--view", "destinations"]
with contextlib.redirect_stdout(buf):
    C.main()
doc = json.loads(buf.getvalue())
check(doc["tool"].startswith("connections") and any(g["net"] == "/QSPI_SS" for g in doc["pins"]),
      "CLI --view destinations emits a doc whose pins include QSPI_SS")

out = tmp / "rp.json"
sys.argv = ["connections", str(mp), "--output", str(out), "--split"]
with contextlib.redirect_stdout(io.StringIO()):
    C.main()
for suffix in ("connections", "destinations", "paths"):
    f = tmp / f"rp_{suffix}.json"
    check(f.exists(), f"--split wrote rp_{suffix}.json")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/check_connections.py`
Expected: FAIL — `AttributeError: module 'controller_map.connections' has no attribute 'main'`.

- [ ] **Step 3: Write minimal implementation**

In `controller_map/connections.py`, append:

```python
def _header(cmap: dict) -> dict:
    return {
        "tool": TOOL_NAME,
        "source": cmap.get("source"),
        "format": cmap.get("format"),
        "controller": cmap.get("controller"),
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
        description="Re-express a controller_map JSON as two lossless views: 'destinations' "
        "(where each pin goes, to what kind of device) and 'paths' (what circuit each "
        "connection crosses). Reads the JSON from a file or stdin; JSON to stdout (or "
        "--output), diagnostics to stderr.",
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/check_connections.py`
Expected: PASS — ends with `ALL 13 CHECKS PASSED`.

- [ ] **Step 5: Register the console script**

Edit `pyproject.toml`; change the `[project.scripts]` section from:

```toml
[project.scripts]
controller_map = "controller_map.controller_map:main"
```

to:

```toml
[project.scripts]
controller_map = "controller_map.controller_map:main"
connections = "controller_map.connections:main"
```

Then re-install so the entry point registers:
Run: `uv sync`
Expected: resolves and installs `controller_map` (editable); no errors.

- [ ] **Step 6: Verify the end-to-end pipe**

Run: `uv run controller_map tests/fixtures/pca10056.NET --main-controller U1 | uv run connections --view destinations | head -30`
Expected: JSON beginning `{ "tool": "connections v0.1.0", ... "pins": [ ...` printed to stdout (controller_map's diagnostics appear separately on stderr).

- [ ] **Step 7: Checkpoint**

Run: `uv run python tests/check_connections.py && uv run python tests/check.py`
Expected: `ALL 13 CHECKS PASSED` then `ALL 21 CHECKS PASSED`.
(Optional commit: `git add -A && git commit -m "feat(connections): CLI + console script"`.)

---

## Task 4: README usage section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the usage section**

Append to `README.md` (after the "Output (per signal pin)" section, before "Known limitations"):

```markdown
## Two views (`connections`)

`connections` is a post-processor over the JSON above. It re-expresses each pin's
connections as two complementary, **lossless** views (no component value is dropped; no
electrical interpretation is added):

- **destinations (去向)** — where each pin ultimately goes, and to what kind of device
  (`connector` / `ic` / `led` / `testpoint` / `crystal` / `rail` / …).
- **paths (途经电路)** — what circuit each of those connections crosses (the series
  resistors / bridges / etc., with their values preserved verbatim).

```sh
# pipe straight from controller_map (JSON on stdout pipes cleanly)
uv run controller_map tests/fixtures/pca10056.NET --main-controller U1 \
  | uv run connections --view destinations

# or from a saved map; --split writes <stem>_{connections,destinations,paths}.json
uv run connections out/nordic_nRF52840_controller_map.json --output out/nrf52840.json --split
```

`--view canonical` (default) emits one flat list where each record carries both the
destination and the via path. See `docs/specs/2026-06-09-controller-connections-design.md`.
```

- [ ] **Step 2: Verify the documented commands run**

Run: `uv run connections out/nordic_nRF52840_controller_map.json --view paths | head -20`
Expected: JSON beginning `{ "tool": "connections v0.1.0", ... "paths": [ ...`.
(If `out/` is empty, first run: `uv run controller_map tests/fixtures/pca10056.NET --main-controller U1 --output out/nordic_nRF52840_controller_map.json`.)

- [ ] **Step 3: Final checkpoint**

Run: `uv run python tests/check_connections.py && uv run python tests/check.py`
Expected: `ALL 13 CHECKS PASSED` then `ALL 21 CHECKS PASSED`.
(Optional commit: `git add -A && git commit -m "docs(connections): README usage section"`.)

---

## Self-Review

**Spec coverage:**
- §1 purpose / L1 scope / post-processor → Tasks 1-3 (reads JSON, no interpretation). ✓
- §2 input (file/stdin + validation) → Task 3 `load_input`. ✓
- §3 canonical record (endpoint/rail/class/via/hops/dnf) → Task 1 `build_connections`. ✓
- §4 two views + CLI (`--view`, `--output`, `--split`) → Tasks 2-3. ✓
- §5 `endpoint_class` prefix map → Task 1 `_ENDPOINT_CLASS`/`_endpoint_class`. ✓
- §6 determinism (natkey sort) → Task 1 + Task 2 sorts. ✓
- §7 project changes (module, console script, test) → Tasks 1-4. ✓
- §9 validated outputs (P0.14, IMCU_RESET, SWD1_CLK, QSPI_SS, round-trip) → Tasks 1-2 asserts. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command and expected output. ✓

**Type consistency:** `build_connections(cmap: dict) -> list[dict]` consumed by `to_destinations`/`to_paths`/`*_doc`; `_endpoint_class(endpoint, rail)` matches call site; `natkey` imported from `netlist_model` (verified signature `natkey(s: str)`); CLI builder dict keys (`canonical`/`destinations`/`paths`) match `--view` choices. ✓

---

## As-built notes (deviations found during execution)

1. **Test data must round-trip through JSON.** `dataclasses.asdict` preserves **tuples**, but
   `connections` consumes a real **JSON** document where every sequence is a **list**. The
   `amap` helper was changed to `json.loads(json.dumps(dataclasses.asdict(cmap)))` so `via == []`
   comparisons are faithful to what the CLI actually receives. (`import json` is in the test.)
2. **Shared-net lookups must be scoped.** A header like `P24` is reached by many controller
   pins, so the paths-view assert filters to `net == "P0.14"` before selecting the `P24`/`LED2`
   paths (an unscoped `next(... ref=="P24")` grabs another pin's connection).
3. **Check counts (actual):** connections suite = **14** checks (plan text estimated 13);
   existing `tests/check.py` = **24** (README's "21" predates added cases). Both green.
```
