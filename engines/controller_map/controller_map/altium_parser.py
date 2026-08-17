"""Parse the Altium / OrCAD PCB II netlist (`.NET`) into the format-agnostic `_Netlist`.

Format (component-centric, nested parens, CRLF; encoding varies by exporting
machine's ANSI codepage — UTF-8, GBK (Chinese-locale Windows) and latin-1 all occur):

    ( {OrCAD PCB II Netlist Format}
     ( 00000003 L-KLS5-CR2032-23-B1 Bat1 Bat Holder CR2032
      ( 1 VBAT )
      ( 2 GND )
     )
     ...
    )

Each component block: `( <serial> <footprint> <designator> <comment...>` followed by
one `( <pinNum> <netName> )` line per pin, then a closing `)`. There is NO separate net
section (nets are inverted from the inline pin->net mapping) and NO pin name/type/library
information — only footprint, designator, comment(value), pin number and net name.

Header fields are unquoted, so spaces are ambiguous: footprints can contain spaces
("M3 Spade Hole"), values can contain spaces ("8 MHz"), and an EMPTY value leaves a
trailing space on the line. Disambiguation rules, in order (see the board-ir design
spec; verified against the ODrive v3 export where all three cases co-occur):

  1. Line ends with a space  -> value is empty, designator is the last token,
     footprint is everything in between ("M3 Hole H1 " -> fp="M3 Hole", ref="H1").
     This rule must run FIRST: "M3" itself looks like a designator.
  2. Exactly 3 tokens        -> (footprint, designator, value) one-to-one.
  3. More tokens             -> the first token after the footprint's first word that
     matches the designator shape (letters then digits, e.g. "XT1") is the designator;
     the remainder is the value ("DFN220P320X110-4N XT1 8 MHz").

A designator duplicated across records is Altium board-variant expansion (identical
connectivity, different value per variant): pins are unioned and all distinct
non-empty values are collected into `_Comp.values`.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

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

# Component header: `( <serial(>=6 digits)> <rest...>` (no trailing ')': the block
# spans multiple lines). `rest` is kept raw — including any trailing space, which is
# the only signal that the value field is empty.
_HEADER_RE = re.compile(r"^\s*\(\s+(\d{6,})\s(.*)$")
# Pin line: `( <pinNum> <netName> )` — net captured greedily-minimally so names with
# internal spaces still work; the trailing ` )` anchors it (distinguishes from a header).
_PIN_RE = re.compile(r"^\s*\(\s+(\S+)\s+(.+?)\s+\)\s*$")
# Designator shape: leading letters, trailing digits ("C1", "XT1", "LED2", "FID4").
_REF_RE = re.compile(r"^[A-Za-z]{1,4}\d+$")


def looks_like_altium(head: str) -> bool:
    """Content sniff used by the format dispatcher."""
    if "Netlist Format" in head or "OrCAD" in head:
        return True
    stripped = head.lstrip()
    return stripped.startswith("(") and "<" not in stripped[:20]


def _read_text(path: Path) -> str:
    """Try UTF-8, then GBK/CP936 (Chinese-locale Altium writes 'µ' as A6 CC, which is
    invalid UTF-8), then latin-1 (never fails). GBK is attempted before latin-1 because
    latin-1 turns GBK bytes into mojibake ('¦Ì') while a genuine latin-1 file rarely
    survives a strict GBK decode by accident."""
    data = path.read_bytes()
    for enc in ("utf-8", "gbk"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _split_header(rest: str) -> tuple[str, str, str] | None:
    """Split the raw text after the serial number into (footprint, ref, value).
    `rest` must keep its trailing whitespace (rule 1). Returns None if malformed."""
    if rest != rest.rstrip():  # rule 1: trailing space == empty value
        toks = rest.split()
        if len(toks) < 2:
            return None
        return " ".join(toks[:-1]), toks[-1], ""
    toks = rest.split()
    if len(toks) < 2:
        return None
    if len(toks) == 2:  # defensive: no value, no trailing space
        return toks[0], toks[1], ""
    if len(toks) == 3:  # rule 2
        return toks[0], toks[1], toks[2]
    for i in range(1, len(toks)):  # rule 3: first designator-shaped token after fp start
        if _REF_RE.match(toks[i]):
            return " ".join(toks[:i]), toks[i], " ".join(toks[i + 1 :])
    return toks[0], toks[1], " ".join(toks[2:])  # fallback: positional


def parse_altium_net(path: Path) -> _Netlist:
    footprints: dict[_Ref, str] = {}
    values_seen: dict[_Ref, list[str]] = defaultdict(list)
    net_nodes: dict[_NetName, set[_Node]] = defaultdict(set)
    cur_ref: _Ref | None = None

    for line in _read_text(path).splitlines():
        # Format header / directive lines start their paren block with a brace
        # ("( {OrCAD PCB II Netlist Format}"). A brace elsewhere (e.g. inside a
        # value) must NOT skip the line — that would glue pins onto the previous
        # component.
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
            fields = _split_header(mh.group(2))
            if fields is None:
                cur_ref = None
                continue
            footprint, ref_s, value = fields
            ref = _Ref(ref_s)
            footprints[ref] = footprint
            if value and value not in values_seen[ref]:
                values_seen[ref].append(value)
            cur_ref = ref
            continue
        # a bare ')' closes the current component; the next header resets cur_ref.

    comps: dict[_Ref, _Comp] = {}
    for ref, footprint in footprints.items():
        vals = values_seen.get(ref, [])
        comps[ref] = _Comp(
            ref,
            vals[0] if vals else "",
            "",
            "",
            footprint,
            "",
            tuple(vals) if len(vals) > 1 else (),
        )

    nets = [_Net(name, frozenset(nodes)) for name, nodes in net_nodes.items()]
    nl = _Netlist(path.stem, comps, {}, nets)
    build_indices(nl)
    return nl
