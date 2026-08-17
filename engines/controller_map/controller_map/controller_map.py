"""controller_map — auto-detect a board's main controller and report where each of its
signal pins goes (raw direct net + pass-through-traced endpoints), as JSON.

Reads a KiCad `kicadxml` netlist, a KiCad legacy `EESchema Netlist Version 1.1` `.net`,
or an Altium/OrCAD PCB II `.NET` (format auto-sniffed).
Bypasses any schematic annotation. See docs/specs/2026-06-06-controller-map-design.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .altium_parser import looks_like_altium, parse_altium_net
from .eeschema_parser import looks_like_eeschema, parse_eeschema_net
from .kicad_parser import parse_kicad_xml
from .netlist_model import _NetName, _Netlist, _Node, _PinNum, _Ref, natkey

TOOL_NAME = "controller_map v0.1.0"
MAX_HOP_DEPTH = 4

# Series pass-through component ref prefixes (must have exactly 2 connected pins).
# Capacitors (C) and bridges/jumpers are conditional — see _hop_other_pin.
_HOP_PREFIXES = {"R", "L", "FB", "FL"}
# Solder-bridge / jumper / link prefixes: traced through ONLY when populated/closed
# (footprint says so); an open bridge legitimately separates two nets and stays an endpoint.
_BRIDGE_PREFIXES = {"SB", "JP", "LK"}
_HOP_KIND = {"R": "resistor", "L": "inductor", "FB": "ferrite", "FL": "ferrite",
             "C": "cap_series", "SB": "solderbridge", "JP": "jumper", "LK": "link"}

# Heuristic "this part is an MCU/SoC" signal, matched against value/part/lib. Used as the
# top-priority controller-detection signal (KiCad also exposes an `MCU_*` library).
_MCU_RE = re.compile(
    r"(?i)(?:^|[^A-Za-z])(?:nRF\d|STM32|STM8|RP2040|RP2350|ATmega|ATtiny|ATSAM|SAM[DLES]\d"
    r"|ESP32|ESP8266|MSP430|PIC(?:10|12|16|18|24|32)|dsPIC|GD32|APM32|LPC\d|MK[ELV]\d|MKW\d"
    r"|RA[46]|R7FA|CH32|EFR32|EFM32|MAX32|nRF52|nRF53|nRF91|CC\d{4}|K[LE]\d{2}|XMC\d)"
)

# Unpopulated / do-not-fit markers (case/punct-insensitive) on a component value.
_DNF_TOKENS = {"DNF", "DNP", "DNI", "NC", "NM", "NF", "NP", "NOTFITTED", "NOTPLACED", "NOTUSED"}

_GND_NAMES = {"GND", "GNDA", "GNDD", "AGND", "DGND", "PGND", "SGND", "VSS", "VSSA", "VEE", "EARTH", "GROUND"}
# Rail-name prefixes. A net whose cleaned name starts with one of these is power, UNLESS
# it ends with a signal-ish suffix (handled in is_power_net), which keeps e.g. VBAT_EN,
# VDD_nRF_SENSE, VCOM_* (note: VCOM is not in the list) classified as signals.
_RAIL_PREFIXES = ("VDD", "VCC", "VSS", "VEE", "VBAT", "VBUS", "VIO", "VREG", "VEXT", "VIN",
                  "VSUPPLY", "VSRC", "VBOOST", "VLI", "VDBG", "VPP", "VDRIVE", "VMOTOR",
                  "AVCC", "AVDD", "AVSS", "DVCC", "DVDD", "GVDD", "PVDD")
_SIGNAL_SUFFIX_RE = re.compile(r"(_EN|_ENABLE|_INV|_DETECT|_DET|_SENSE|_SEL|_OFF|_ON|_REF|_FB"
                               r"|_FLAG|_GOOD|_PG|_S|_SNS|_MON|_MEAS|_DIV|_ADC)$")
# Exact-match rail names that no prefix rule catches (motor-drive DC buses etc.).
_RAIL_NAMES = {"DCBUS", "VMOT", "MOTPWR", "HVBUS"}


# ----------------------------------------------------------------------------- model

@dataclass(frozen=True)
class NodeRef:
    ref: str
    pin: str
    pin_name: str
    value: str


@dataclass(frozen=True)
class ViaPart:
    ref: str
    value: str
    pin_in: str
    pin_out: str
    kind: str
    dnf: bool


@dataclass(frozen=True)
class TracedEndpoint:
    via: tuple[ViaPart, ...]
    endpoint: NodeRef | None  # None iff terminated on a rail
    rail: str | None
    dnf: bool


@dataclass(frozen=True)
class ControllerPin:
    pin: str
    pin_name: str
    net: str
    direct_nodes: tuple[NodeRef, ...]
    traced: tuple[TracedEndpoint, ...]


@dataclass(frozen=True)
class ControllerInfo:
    ref: str
    part: str
    lib: str
    pin_count: int
    detected_by: str  # "auto" | "override"


@dataclass(frozen=True)
class RunnerUp:
    ref: str
    part: str
    lib: str
    pin_count: int


@dataclass(frozen=True)
class ControllerMap:
    tool: str
    source: str
    format: str  # "kicad" | "eeschema" | "altium"
    controller: ControllerInfo
    runner_up: RunnerUp | None
    low_confidence: bool
    signal_pins: tuple[ControllerPin, ...]


# ------------------------------------------------------------------- small helpers

def _warn(msg: str) -> None:
    print(f"Warning: {msg}", file=sys.stderr)


def _leading_alpha(ref: str) -> str:
    m = re.match(r"[A-Za-z]+", ref)
    return m.group(0) if m else ""


def _is_dnf(value: str) -> bool:
    norm = re.sub(r"[.\s/_-]", "", value).upper()
    return norm in _DNF_TOKENS


def _clean_net(name: str) -> str:
    return name.lstrip("/").rstrip("'").replace("\\", "")


def is_power_net(name: str) -> bool:
    """Classify a net as power/ground by name only (the only signal available on Altium,
    and a supplement to pin type on KiCad). Conservative: errs toward 'signal' so real
    signals are not dropped from the report."""
    if not name:
        return False
    u = _clean_net(name).upper()
    # KiCad hierarchical net names carry the sheet path ("/MCU_Controller/D+3V3");
    # classify on the local label, not the path.
    u = u.rsplit("/", 1)[-1]
    # Altium hierarchical exports append a sheet-instance ordinal ("VBUS_S_1");
    # classify on the base name so signal suffixes like _S / _SENSE stay visible.
    base = re.sub(r"_\d+$", "", u)
    u = base or u
    if u in _GND_NAMES:
        return True
    if u in _RAIL_NAMES:
        return True
    if _SIGNAL_SUFFIX_RE.search(u):
        return False
    if u.startswith(_RAIL_PREFIXES):
        return True
    if u.startswith(("+", "-")):
        return True
    # +3V3, 3V3, V5V, 5V0, 1V8; optionally analog/digital-domain prefixed (D+3V3, A5V)
    if re.fullmatch(r"[AD]?[+-]?\d+V\d*", u) or re.fullmatch(r"V\d+V?\d*", u):
        return True
    return False


# ------------------------------------------------------------------ pin naming

def _strip_pinfunction_suffix(pinfunction: str, pin: str) -> str:
    """Remove only a trailing `_<thisPin>` (the KiCad-10 suffix), anchored to this node's
    own pin number — never the greedy `_.+$` that over-strips multi-underscore names."""
    return re.sub(r"_" + re.escape(pin) + r"$", "", pinfunction)


def _resolve_pin_name(nl: _Netlist, node: _Node) -> str:
    lp = nl.libpart_for(node.ref)
    if lp is not None:
        lpin = lp.pins.get(node.pin)
        if lpin is not None and lpin.name:
            return lpin.name  # taken as-is (may be generic like "Pin_4" or "1")
    if node.pinfunction:
        return _strip_pinfunction_suffix(node.pinfunction, node.pin)
    return node.pin


def _node_ref(nl: _Netlist, node: _Node) -> NodeRef:
    return NodeRef(node.ref, node.pin, _resolve_pin_name(nl, node), nl.comps[node.ref].value)


# --------------------------------------------------------------- controller detection

def _pin_count(nl: _Netlist, ref: _Ref) -> int:
    lp = nl.libpart_for(ref)
    if lp is not None and lp.pins:
        return len(lp.pins)
    return len(nl.pins_of.get(ref, set()))


# Ref prefixes that can never be an MCU (passives/mechanical/connectors); their values
# are vendor part numbers that can coincidentally match an MCU family pattern (e.g. the
# Murata capacitor "GRM21BR61H475KE51L" contains "KE51", which looks like a Kinetis KE).
_NEVER_MCU_PREFIXES = {"C", "R", "L", "FB", "FL", "TP", "FID", "H", "MH", "SB", "JP",
                       "LK", "NT", "D", "LED", "F", "J", "P", "SW", "S", "BT", "XT", "Y"}


def _mcu_signal(nl: _Netlist, ref: _Ref) -> bool:
    if _leading_alpha(ref).upper() in _NEVER_MCU_PREFIXES:
        return False
    comp = nl.comps[ref]
    if comp.lib.startswith("MCU_"):
        return True
    return bool(_MCU_RE.search(f"{comp.value} {comp.part} {comp.lib}"))


def _ref_is_ic(ref: str) -> bool:
    return _leading_alpha(ref) in {"U", "IC", "A"} and not ref.startswith("#")


def _detect_controller(nl: _Netlist) -> tuple[_Ref, RunnerUp | None, bool]:
    candidates = [ref for ref in nl.comps if _pin_count(nl, ref) >= 1 and not ref.startswith("#")]
    if not candidates:
        raise SystemExit("error: no components with pins found in netlist")

    def sort_key(ref: _Ref) -> tuple[object, ...]:
        # higher score first (negated); ref ascending as the final deterministic tie-break
        return (-int(_mcu_signal(nl, ref)), -int(_ref_is_ic(ref)), -_pin_count(nl, ref), natkey(ref))

    ranked = sorted(candidates, key=sort_key)
    winner = ranked[0]
    runner = ranked[1] if len(ranked) > 1 else None

    runner_up = None
    if runner is not None:
        rc = nl.comps[runner]
        runner_up = RunnerUp(runner, rc.part or rc.value, rc.lib, _pin_count(nl, runner))

    low_conf = False
    if not _mcu_signal(nl, winner):
        low_conf = True
    elif runner is not None and _mcu_signal(nl, winner) == _mcu_signal(nl, runner):
        if _pin_count(nl, winner) < 1.5 * _pin_count(nl, runner):
            low_conf = True
    return winner, runner_up, low_conf


# --------------------------------------------------------------------- tracing

def _hop_other_pin(nl: _Netlist, ref: _Ref, entered_pin: _PinNum) -> _PinNum | None:
    """If `ref` (entered on `entered_pin`) is a 2-pin series pass-through, return its other
    pin; else None. Resistors/inductors/ferrites always pass through (a pull to a rail is
    handled by rail-termination at the destination). A capacitor passes through only if its
    other terminal is on a signal net (series/AC-coupling); a cap to a rail is a stub."""
    pins = nl.pins_of.get(ref, set())
    if len(pins) != 2:
        return None
    others = [p for p in pins if p != entered_pin]
    if len(others) != 1:
        return None
    other_pin = others[0]
    prefix = _leading_alpha(ref).upper()
    if prefix in _HOP_PREFIXES:
        return other_pin
    if prefix == "C":
        other_net = nl.net_of[ref].get(other_pin)
        if other_net is not None and not is_power_net(other_net):
            return other_pin
    if prefix in _BRIDGE_PREFIXES:
        # Trace through only a populated/closed bridge; an open one separates the nets.
        fp = nl.comps[ref].footprint.lower()
        if "short" in fp or "closed" in fp or "_sh" in fp:
            return other_pin
    return None


def _is_stub_cap(nl: _Netlist, ref: _Ref, entered_pin: _PinNum) -> bool:
    """A 2-pin capacitor whose other terminal is on a rail (decoupling/load/bypass). Such a
    cap is neither traced through nor emitted as an endpoint — it is pure noise on a signal
    net (it still appears in `direct_nodes`)."""
    if _leading_alpha(ref).upper() != "C":
        return False
    pins = nl.pins_of.get(ref, set())
    if len(pins) != 2:
        return False
    other = next(p for p in pins if p != entered_pin)
    other_net = nl.net_of[ref].get(other)
    return other_net is not None and is_power_net(other_net)


def _trace_pin(nl: _Netlist, ctrl_ref: _Ref, start_net: _NetName) -> list[TracedEndpoint]:
    results: list[TracedEndpoint] = []

    def walk(net_name: _NetName, via: tuple[ViaPart, ...], came_from: _Ref,
             depth: int, visited: frozenset[_NetName]) -> None:
        if net_name in visited:
            return
        visited = visited | {net_name}
        for node in nl.net_nodes.get(net_name, []):
            if node.ref == ctrl_ref:  # never treat the controller itself as a sink
                continue
            if node.ref == came_from:  # don't bounce back through the part just crossed
                continue
            other_pin = _hop_other_pin(nl, node.ref, node.pin)
            if other_pin is not None:
                comp = nl.comps[node.ref]
                vp = ViaPart(node.ref, comp.value, node.pin, other_pin,
                             _HOP_KIND.get(_leading_alpha(node.ref).upper(), "resistor"),
                             _is_dnf(comp.value))
                new_via = (*via, vp)
                path_dnf = any(v.dnf for v in new_via)
                if depth + 1 > MAX_HOP_DEPTH:
                    _warn(f"max hop depth exceeded tracing {ctrl_ref} via "
                          f"{'->'.join(v.ref for v in new_via)}; stopping branch.")
                    continue
                next_net = nl.net_of[node.ref][other_pin]
                if is_power_net(next_net):
                    results.append(TracedEndpoint(new_via, None, _clean_net(next_net), path_dnf))
                else:
                    walk(next_net, new_via, node.ref, depth + 1, visited)
            elif not _is_stub_cap(nl, node.ref, node.pin):
                results.append(TracedEndpoint(via, _node_ref(nl, node), None,
                                              any(v.dnf for v in via)))

    walk(start_net, (), ctrl_ref, 0, frozenset())
    return _dedupe_traced(results)


def _dedupe_traced(items: list[TracedEndpoint]) -> list[TracedEndpoint]:
    seen: set[tuple[object, ...]] = set()
    out: list[TracedEndpoint] = []
    for t in items:
        key = (
            tuple(v.ref for v in t.via),
            (t.endpoint.ref, t.endpoint.pin) if t.endpoint else None,
            t.rail,
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    out.sort(key=lambda t: (
        len(t.via),
        natkey(t.endpoint.ref) if t.endpoint else (),
        natkey(t.endpoint.pin) if t.endpoint else (),
        t.rail or "",
    ))
    return tuple(out)


# ---------------------------------------------------------- power/ground pin split

def _is_power_pin(nl: _Netlist, ref: _Ref, pin: _PinNum, net: _NetName | None) -> bool:
    lp = nl.libpart_for(ref)
    typ = ""
    if lp is not None:
        lpin = lp.pins.get(pin)
        if lpin is not None:
            typ = lpin.type
    by_type = typ in ("power_in", "power_out")
    by_net = is_power_net(net) if net else False
    if typ:  # type known (KiCad): union, warn on disagreement
        if by_type != by_net:
            _warn(f"pin {ref}.{pin} (net {net}) power-type/{typ} disagrees with net-name "
                  f"classification; excluding as power.")
        return by_type or by_net
    return by_net  # Altium: net-name only


# --------------------------------------------------------------------- orchestrator

def _load_netlist(path: Path) -> tuple[_Netlist, str]:
    with open(path, "rb") as f:
        head = f.read(4096).decode("latin-1", errors="replace")
    if "<export" in head or "<?xml" in head or "<netlist" in head:
        return parse_kicad_xml(path), "kicad"
    if looks_like_eeschema(head):
        return parse_eeschema_net(path), "eeschema"
    if looks_like_altium(head):
        return parse_altium_net(path), "altium"
    # fall back to extension
    if path.suffix.lower() in (".net",):
        return parse_altium_net(path), "altium"
    return parse_kicad_xml(path), "kicad"


def create_controller_map(
    netlist_path: Path,
    output_path: Path | None = None,
    main_controller: str | None = None,
) -> ControllerMap:
    nl, fmt = _load_netlist(netlist_path)

    if main_controller is not None:
        ctrl = _Ref(main_controller)
        if ctrl not in nl.comps:
            raise SystemExit(f"error: --main-controller {main_controller!r} not found in netlist")
        runner_up, low_conf, detected_by = None, False, "override"
    else:
        ctrl, runner_up, low_conf, detected_by = (*_detect_controller(nl), "auto")

    cc = nl.comps[ctrl]
    info = ControllerInfo(ctrl, cc.part or cc.value, cc.lib, _pin_count(nl, ctrl), detected_by)

    print(f"Detected main controller ({detected_by}): {ctrl} "
          f"{cc.value or cc.part} ({cc.lib or cc.footprint or 'unknown lib'}, "
          f"{info.pin_count} pins).", file=sys.stderr)
    if runner_up is not None:
        print(f"  Runner-up: {runner_up.ref} {runner_up.part} "
              f"({runner_up.lib or 'unknown lib'}, {runner_up.pin_count} pins).", file=sys.stderr)
    if low_conf:
        _warn("low-confidence controller detection — verify, and override with "
              "--main-controller <ref> if wrong.")

    signal_pins: list[ControllerPin] = []
    for pin in sorted(nl.pins_of.get(ctrl, set()), key=natkey):
        net = nl.net_of[ctrl].get(pin)
        if _is_power_pin(nl, ctrl, pin, net):
            continue
        pin_name = _resolve_pin_name(nl, _Node(ctrl, pin, _pinfunction_of(nl, ctrl, pin)))
        if net is None:
            signal_pins.append(ControllerPin(pin, pin_name, "", (), ()))
            continue
        direct = tuple(
            _node_ref(nl, n) for n in nl.net_nodes.get(net, []) if n.ref != ctrl
        )
        traced = tuple(_trace_pin(nl, ctrl, net))
        signal_pins.append(ControllerPin(pin, pin_name, net, direct, traced))

    cmap = ControllerMap(TOOL_NAME, nl.source, fmt, info, runner_up, low_conf, tuple(signal_pins))

    text = json.dumps(dataclasses.asdict(cmap), indent=2, ensure_ascii=False)
    if output_path is not None:
        print(f"Printing output to: {output_path}", file=sys.stderr)
        output_path.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return cmap


def _pinfunction_of(nl: _Netlist, ref: _Ref, pin: _PinNum) -> str | None:
    net = nl.net_of[ref].get(pin)
    if net is None:
        return None
    for n in nl.net_nodes.get(net, []):
        if n.ref == ref and n.pin == pin:
            return n.pinfunction
    return None


# ----------------------------------------------------------------------------- CLI

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="controller_map",
        description="Auto-detect a board's main controller and report where each signal "
        "pin goes (direct net + pass-through-traced endpoints) as JSON. Accepts a KiCad "
        "kicadxml netlist or an Altium/OrCAD PCB II .NET. JSON to stdout (or --output); "
        "all diagnostics to stderr.",
    )
    parser.add_argument("netlist_file", help="KiCad kicadxml netlist or Altium .NET file")
    parser.add_argument("--output", help="write JSON here (stdout if omitted)")
    parser.add_argument("--main-controller", help="override auto-detection by exact component ref")
    parser.add_argument("--version", action="version", version=TOOL_NAME)
    args = parser.parse_args()

    create_controller_map(
        Path(args.netlist_file),
        None if args.output is None else Path(args.output),
        args.main_controller,
    )


if __name__ == "__main__":
    main()
