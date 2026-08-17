"""Format-agnostic internal netlist model.

Both parsers (KiCad XML, Altium OrCAD .NET) produce a `_Netlist`. Everything here
is throwaway internal scaffolding (prefixed `_`); it is never serialized. Fields that
a given format cannot provide are left empty/None, and the analysis layer degrades
gracefully (see controller_map.py):

  - KiCad provides libpart pin `name`/`type` and node `pinfunction`.
  - Altium OrCAD provides neither: `libparts` is empty, pin names/types are "",
    `pinfunction` is None. Pin naming then falls back to the bare pin number and
    power classification falls back to the net name only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import NewType

_Ref = NewType("_Ref", str)
_PinNum = NewType("_PinNum", str)
_NetName = NewType("_NetName", str)


def natkey(s: str) -> tuple[tuple[int, object], ...]:
    """Natural sort key: '10' sorts after '2', 'A1' before 'A10'. Each chunk is type-tagged
    `(0, int)` or `(1, str)` so numeric and alpha pins (e.g. '2' and 'A1' on one net) never
    compare int-vs-str. Deterministic and total."""
    return tuple((0, int(t)) if t.isdigit() else (1, t) for t in re.findall(r"\d+|\D+", s))


@dataclass(frozen=True)
class _LibPin:
    num: _PinNum
    name: str  # "" if unknown (Altium)
    type: str  # "" if unknown (Altium); e.g. "power_in", "bidirectional", "passive"


@dataclass
class _LibPart:
    lib: str
    part: str
    pins: dict[_PinNum, _LibPin]


@dataclass(frozen=True)
class _Comp:
    ref: _Ref
    value: str  # KiCad <value> / Altium comment, e.g. "RP2040", "nRF52840-QIAA", "100nF"
    lib: str  # "" for Altium
    part: str  # "" for Altium
    footprint: str  # may be ""
    sheetpath: str  # may be ""
    # All distinct non-empty values seen for this ref (Altium board-variant expansion
    # emits one full record per variant, e.g. C11 as both "120uF" and "470uF").
    # Empty when the ref appeared once; `value` is then the first non-empty one.
    values: tuple[str, ...] = ()


@dataclass(frozen=True)
class _Node:
    ref: _Ref
    pin: _PinNum
    pinfunction: str | None


@dataclass(frozen=True)
class _Net:
    name: _NetName
    nodes: frozenset[_Node]


@dataclass
class _Netlist:
    source: str  # board name (KiCad: Path(design/source).stem; Altium: file stem)
    comps: dict[_Ref, _Comp]
    libparts: dict[tuple[str, str], _LibPart]  # keyed (lib, part); empty for Altium
    nets: list[_Net]
    # derived indices, built once by build_indices():
    net_of: dict[_Ref, dict[_PinNum, _NetName]] = field(default_factory=dict)
    net_nodes: dict[_NetName, list[_Node]] = field(default_factory=dict)
    pins_of: dict[_Ref, set[_PinNum]] = field(default_factory=dict)

    def libpart_for(self, ref: _Ref) -> _LibPart | None:
        comp = self.comps.get(ref)
        if comp is None:
            return None
        return self.libparts.get((comp.lib, comp.part))


def build_indices(nl: _Netlist) -> None:
    """Populate net_of / net_nodes / pins_of from nl.nets (idempotent)."""
    net_of: dict[_Ref, dict[_PinNum, _NetName]] = {}
    net_nodes: dict[_NetName, list[_Node]] = {}
    pins_of: dict[_Ref, set[_PinNum]] = {}
    for net in nl.nets:
        net_nodes[net.name] = sorted(net.nodes, key=lambda n: (natkey(n.ref), natkey(n.pin)))
        for node in net.nodes:
            net_of.setdefault(node.ref, {})[node.pin] = net.name
            pins_of.setdefault(node.ref, set()).add(node.pin)
    nl.net_of = net_of
    nl.net_nodes = net_nodes
    nl.pins_of = pins_of
