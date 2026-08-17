"""Parse KiCad's `kicadxml` netlist into the format-agnostic `_Netlist`.

Reads only the elements documented in the design spec: design/source, components
(ref, value, libsource, footprint, sheetpath), libparts (pin num/name/type), and
nets (node ref/pin/pinfunction).
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from .netlist_model import (
    _Comp,
    _LibPart,
    _LibPin,
    _Net,
    _NetName,
    _Netlist,
    _Node,
    _PinNum,
    _Ref,
    build_indices,
)


def parse_kicad_xml(path: Path) -> _Netlist:
    root = ET.parse(path).getroot()

    source_text = (root.findtext("./design/source") or "").strip()
    source = Path(source_text).stem if source_text else path.stem

    comps: dict[_Ref, _Comp] = {}
    for comp in root.findall("./components/comp"):
        ref = _Ref(comp.get("ref", ""))
        if not ref:
            continue
        value = (comp.findtext("value") or "").strip()
        ls = comp.find("libsource")
        lib = ls.get("lib", "") if ls is not None else ""
        part = ls.get("part", "") if ls is not None else ""
        footprint = (comp.findtext("footprint") or "").strip()
        sp = comp.find("sheetpath")
        sheetpath = sp.get("names", "") if sp is not None else ""
        comps[ref] = _Comp(ref, value, lib, part, footprint, sheetpath)

    libparts: dict[tuple[str, str], _LibPart] = {}
    for lp in root.findall("./libparts/libpart"):
        lib = lp.get("lib", "")
        part = lp.get("part", "")
        pins: dict[_PinNum, _LibPin] = {}
        for pin in lp.findall("./pins/pin"):
            num = _PinNum(pin.get("num", ""))
            if not num:
                continue
            pins[num] = _LibPin(num, pin.get("name", "") or "", pin.get("type", "") or "")
        libparts[(lib, part)] = _LibPart(lib, part, pins)

    nets: list[_Net] = []
    for net in root.findall("./nets/net"):
        name = _NetName(net.get("name", ""))
        nodes: set[_Node] = set()
        for node in net.findall("node"):
            ref = _Ref(node.get("ref", ""))
            pin = _PinNum(node.get("pin", ""))
            if not ref or not pin:
                continue
            nodes.add(_Node(ref, pin, node.get("pinfunction")))
        nets.append(_Net(name, frozenset(nodes)))

    nl = _Netlist(source, comps, libparts, nets)
    build_indices(nl)
    _warn_missing_libparts(nl)
    return nl


def _warn_missing_libparts(nl: _Netlist) -> None:
    missing = sorted(
        {
            (nl.comps[ref].lib, nl.comps[ref].part)
            for ref in nl.pins_of
            if ref in nl.comps and nl.libpart_for(ref) is None and not ref.startswith("#")
        }
    )
    for lib, part in missing:
        print(
            f"Warning: no libpart for ({lib!r}, {part!r}); pin names/types unavailable "
            "for its components.",
            file=sys.stderr,
        )
