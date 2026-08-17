"""Parse KiCad's legacy `EESchema Netlist Version 1.1` (.net) into the format-agnostic
`_Netlist`.

This is the third supported netlist flavor, emitted by kicad-cli's legacy exporter and
old eeschema's "Pcbnew" netlist plugin (component-centric parens like OrCAD, but with a
uuid sheetpath where OrCAD has a numeric serial):

    ( { EESchema Netlist Version 1.1 created  2026-08-05T16:22:01 }
     ( /f5de9976-.../fa5be8ea-... Resistor_SMD:R_0603_1608Metric  R35 43k
      (    1 /Sensors/EHE )
      (    2 Net-(C52-Pad1) )
     )
    )
    *

Component header: `( <sheetpath/uuid> <footprint>  <ref> <value...>`. The first token is
a slash-led uuid path (one uuid per sheet level for hierarchical designs, the component's
own uuid last). Footprint is `$noname` when unset and never contains spaces (KiCad lib
ids forbid them); the reference follows; the value is everything after it (may be empty,
may contain spaces). Pin lines are `( <num> <net> )` exactly like OrCAD; net names may
contain parens (`Net-(D11-K)`) and per-pin `unconnected-(...)` placeholders.

Like Altium — and unlike kicadxml — the format carries no libparts, pin names or pin
types, so pin naming falls back to bare pin numbers and power classification to net
names only (see netlist_model.py).
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from .altium_parser import _PIN_RE, _read_text
from .netlist_model import (
    _Comp,
    _Net,
    _NetName,
    _Netlist,
    _Node,
    _PinNum,
    _Ref,
    build_indices,
)

# Component header: `( <slash-led uuid path> <rest...>` (no trailing ')': the block spans
# multiple lines). The leading '/' is what distinguishes it from OrCAD's numeric serial.
_HEADER_RE = re.compile(r"^\s*\(\s+(/\S*)\s+(.*\S)\s*$")


def looks_like_eeschema(head: str) -> bool:
    """Content sniff used by the format dispatcher."""
    return "EESchema Netlist" in head


def parse_eeschema_net(path: Path) -> _Netlist:
    footprints: dict[_Ref, str] = {}
    sheetpaths: dict[_Ref, str] = {}
    values_seen: dict[_Ref, list[str]] = defaultdict(list)
    net_nodes: dict[_NetName, set[_Node]] = defaultdict(set)
    cur_ref: _Ref | None = None

    for line in _read_text(path).splitlines():
        # The format header opens its paren block with a brace:
        # "( { EESchema Netlist Version 1.1 created ... }".
        if re.match(r"^\s*\(?\s*\{", line):
            continue
        mp = _PIN_RE.match(line)
        if mp is not None and cur_ref is not None:
            pin = _PinNum(mp.group(1))
            net = _NetName(mp.group(2).strip())
            net_nodes[net].add(_Node(cur_ref, pin, None))
            continue
        mh = _HEADER_RE.match(line)
        if mh is not None:
            toks = mh.group(2).split()
            if len(toks) < 2:  # need at least footprint + ref
                cur_ref = None
                continue
            ref = _Ref(toks[1])
            footprints[ref] = "" if toks[0] == "$noname" else toks[0]
            # keep the sheet part of the uuid path; the last segment is the component
            sheetpaths[ref] = mh.group(1).rsplit("/", 1)[0] or "/"
            value = " ".join(toks[2:])
            if value and value not in values_seen[ref]:
                values_seen[ref].append(value)
            cur_ref = ref
            continue
        # a bare ')' closes the current component; the trailing '*' ends the file.

    comps: dict[_Ref, _Comp] = {}
    for ref, footprint in footprints.items():
        vals = values_seen.get(ref, [])
        comps[ref] = _Comp(
            ref,
            vals[0] if vals else "",
            "",
            "",
            footprint,
            sheetpaths.get(ref, ""),
            tuple(vals) if len(vals) > 1 else (),
        )

    nets = [_Net(name, frozenset(nodes)) for name, nodes in net_nodes.items()]
    nl = _Netlist(path.stem, comps, {}, nets)
    build_indices(nl)
    return nl
