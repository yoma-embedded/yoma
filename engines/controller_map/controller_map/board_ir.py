"""board_ir — serialize the complete netlist (every component, every net) as the
"Board IR" JSON, plus — when an MCU pin table (`describe-mcu` JSON) is supplied —
the package-position→pad join, per-pad roles and traced connections.

This is the factual layer the AI (and, later, a schematic-view frontend) consumes;
`stm32_map.py` distills it into stm32kernel-config-vocabulary suggestions.
See docs/specs/2026-07-06-board-ir-design.md.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
from pathlib import Path

from .controller_map import (
    RunnerUp,
    _detect_controller,
    _is_dnf,
    _leading_alpha,
    _load_netlist,
    _pin_count,
    _trace_pin,
    is_power_net,
    _GND_NAMES,
    _clean_net,
)
from .mcu_desc import (
    McuDesc,
    McuPin,
    base_pad,
    describe_mcu_via_kernel,
    load_mcu_desc,
    normalize_part,
    verify_part,
)
from .netlist_model import _Netlist, _Ref, natkey

TOOL_NAME = "board_ir v0.1.0"

# Component class by FULL leading-alpha ref token — extends connections.py's endpoint
# taxonomy with schematic-level kinds (crystals as XT, net-ties, mechanical-only refs).
_COMP_CLASS = {
    "P": "connector", "J": "connector", "CON": "connector", "CN": "connector",
    "U": "ic", "IC": "ic", "A": "ic",
    "LED": "led",
    "TP": "testpoint",
    "Y": "crystal", "X": "crystal", "XT": "crystal", "XTAL": "crystal", "OSC": "crystal",
    "SW": "switch", "S": "switch",
    "D": "diode", "Q": "transistor", "K": "relay",
    "FB": "passive", "FL": "passive", "R": "passive", "L": "passive", "C": "passive",
    "SB": "bridge", "JP": "bridge", "LK": "bridge", "NT": "nettie",
    "TH": "thermistor", "NTC": "thermistor",
    "BT": "battery", "BAT": "battery",
    "FID": "mechanical", "H": "mechanical", "MH": "mechanical", "MP": "mechanical",
    "F": "fuse", "M": "motor", "ANT": "antenna",
}

_CRYSTAL_CLASSES = {"crystal"}
_FREQ_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(G|M|K)?\s*(?:HZ)?\s*$", re.IGNORECASE)
_MULT = {"G": 1_000_000_000, "M": 1_000_000, "K": 1_000, None: 1}


def comp_class(ref: str) -> str:
    return _COMP_CLASS.get(_leading_alpha(ref).upper(), "other")


def net_kind(name: str) -> str:
    u = _clean_net(name).upper()
    base = re.sub(r"_\d+$", "", u) or u  # mirror is_power_net's ordinal stripping
    if base in _GND_NAMES:
        return "ground"
    if is_power_net(name):
        return "power"
    return "signal"


def parse_freq_hz(value: str) -> int | None:
    """'8 MHz' / '8MHz' / '32.768kHz' / '8000000' -> Hz; None if not a frequency."""
    m = _FREQ_RE.match(value or "")
    if m is None:
        return None
    num = float(m.group(1).replace(",", "."))
    unit = m.group(2).upper() if m.group(2) else None
    hz = int(round(num * _MULT[unit]))
    return hz if hz > 0 else None


# --------------------------------------------------------------------- MCU roles

def _crystal_neighbor(nl: _Netlist, net: str | None, ctrl: _Ref) -> tuple[str, int | None] | None:
    """A crystal-class component on this net (directly — crystals sit next to the MCU).
    Returns (ref, parsed frequency in Hz) or None."""
    if net is None:
        return None
    for node in nl.net_nodes.get(net, []):
        if node.ref == ctrl:
            continue
        if comp_class(node.ref) in _CRYSTAL_CLASSES:
            comp = nl.comps[node.ref]
            for candidate in (comp.value, *comp.values):
                hz = parse_freq_hz(candidate)
                if hz is not None:
                    return node.ref, hz
            return node.ref, None
    return None


def _pin_role(nl: _Netlist, ctrl: _Ref, pin: McuPin, net: str | None) -> str:
    if pin.kind == "Power":
        return "ground" if pin.name.startswith("VSS") else "power"
    if pin.kind == "Reset":
        return "reset"
    if pin.kind == "Boot":
        return "boot"
    if pin.kind == "Nc":
        return "nc"
    if net is None or len(nl.net_nodes.get(net, [])) <= 1:
        return "nc"
    kind = net_kind(net)
    if kind in ("power", "ground"):
        return kind
    if "OSC" in pin.name and _crystal_neighbor(nl, net, ctrl) is not None:
        return "crystal"
    if any(s in ("SYS_JTMS-SWDIO", "SYS_JTCK-SWCLK") for s in pin.signals):
        return "swd"
    return "signal"


_TRACED_ROLES = {"signal", "swd", "crystal", "boot", "reset"}


# --------------------------------------------------------------------- document

def _components_doc(nl: _Netlist) -> list[dict]:
    out = []
    for ref in sorted(nl.comps, key=natkey):
        comp = nl.comps[ref]
        pins = []
        for pin in sorted(nl.pins_of.get(ref, set()), key=natkey):
            entry: dict = {"num": pin}
            lp = nl.libpart_for(ref)
            if lp is not None and pin in lp.pins:
                if lp.pins[pin].name:
                    entry["name"] = lp.pins[pin].name
                if lp.pins[pin].type:
                    entry["type"] = lp.pins[pin].type
            entry["net"] = nl.net_of.get(ref, {}).get(pin)
            pins.append(entry)
        doc = {
            "id": f"C:{ref}",
            "ref": ref,
            "class": comp_class(ref),
            "value": comp.value,
            "footprint": comp.footprint,
            "dnf": _is_dnf(comp.value),
            "pinCount": len(pins),
            "pins": pins,
        }
        if comp.values:
            doc["values"] = list(comp.values)
        if comp.lib or comp.part:
            doc["lib"] = comp.lib
            doc["part"] = comp.part
        if comp.sheetpath:
            doc["sheetpath"] = comp.sheetpath
        out.append(doc)
    return out


def _nets_doc(nl: _Netlist) -> list[dict]:
    out = []
    for net in sorted(nl.net_nodes, key=natkey):
        nodes = [
            {"ref": n.ref, "pin": n.pin}
            for n in nl.net_nodes[net]  # already deterministically sorted
        ]
        out.append({"id": f"N:{net}", "name": net, "kind": net_kind(net), "nodes": nodes})
    return out


def _mcu_doc(
    nl: _Netlist,
    ctrl: _Ref,
    desc: McuDesc,
    requested: str | None,
    resolved_by: str,
) -> dict:
    net_of_ctrl = nl.net_of.get(ctrl, {})
    net_by_position: dict[str, str | None] = {}
    matched_ids: set[str] = set()
    for pos in desc.by_position:
        net = net_of_ctrl.get(pos)
        net_by_position[pos] = net
        if net is not None:
            matched_ids.add(pos)
    # Module symbols (Blue Pill / core-board style) number their pins by pad
    # name ("PA0", "NRST"), not by package position. When the position join
    # comes up completely empty, re-join by pad name so the peripheral map
    # still works for boards that socket a module instead of the bare chip.
    if not matched_ids:
        by_pad = {base_pad(p.name).upper(): pos for pos, p in desc.by_position.items()}
        # Module headers also name debug pins by function, not pad ("SWCLK"
        # for PA14); alias them via the pad's signal list.
        aliases: dict[str, str] = {}
        for alias, sig_frag in (("SWDIO", "SWDIO"), ("SWCLK", "SWCLK"), ("SWO", "TRACESWO")):
            if alias not in by_pad:
                pos = next(
                    (
                        pos
                        for pos, p in sorted(desc.by_position.items(), key=lambda kv: natkey(kv[0]))
                        if any(sig_frag in s for s in p.signals)
                    ),
                    None,
                )
                if pos is not None:
                    aliases[alias] = pos
        for pin_id, net in net_of_ctrl.items():
            pos = by_pad.get(pin_id.upper())
            if pos is not None:
                net_by_position[pos] = net
                matched_ids.add(pin_id)
        # Aliases join second, and only into positions the real pad names left
        # empty: a module can expose the same package pin twice ("PB3" carrying
        # the board's net and a debug stub "SWO"); the alias must never
        # overwrite a position already joined by its actual pad name.
        for pin_id, net in net_of_ctrl.items():
            pos = aliases.get(pin_id.upper())
            if pos is not None and net_by_position.get(pos) is None:
                net_by_position[pos] = net
                matched_ids.add(pin_id)
        if matched_ids:
            print(
                f"note: joined {len(matched_ids)} controller pins by pad name "
                "(module-style symbol numbering, not package positions)",
                file=sys.stderr,
            )
    extra = sorted(
        set(nl.pins_of.get(ctrl, set())) - set(desc.by_position) - matched_ids, key=natkey
    )
    for pos in extra:
        net_by_position[pos] = net_of_ctrl[pos]

    verification = verify_part(desc, net_by_position, is_power_net)

    pins_doc = []
    for pos in sorted(desc.by_position, key=natkey):
        pin = desc.by_position[pos]
        net = net_by_position.get(pos)
        role = _pin_role(nl, ctrl, pin, net)
        entry: dict = {
            "position": pos,
            "pad": base_pad(pin.name),
            "padFull": pin.name,
            "kind": pin.kind,
            "net": net,
            "netKind": net_kind(net) if net else None,
            "role": role,
            "signals": list(pin.signals),
        }
        if role == "crystal":
            xt = _crystal_neighbor(nl, net, ctrl)
            if xt is not None:
                entry["crystal"] = {"ref": xt[0], "freqHz": xt[1]}
        if role in _TRACED_ROLES and net is not None:
            entry["connections"] = [
                dataclasses.asdict(t) for t in _trace_pin(nl, ctrl, net)
            ]
        pins_doc.append(entry)

    # Prefer the concrete sales part number over the db RefName group when the
    # requested marking expands into this group ("STM32F103C8Tx" over "STM32F103C(8-B)Tx");
    # the kernel accepts either, but the concrete one pins flash size.
    resolved = desc.ref_name
    if requested:
        norm = normalize_part(requested)
        if norm in desc.part.get("partNumbers", []):
            resolved = norm

    return {
        "componentId": f"C:{ctrl}",
        "part": {
            "requested": requested,
            "resolved": resolved,
            "resolvedBy": resolved_by,
            **{
                k: desc.part.get(k)
                for k in ("package", "family", "line", "core", "maxFreqMhz", "flashKb", "ramKb", "ioCount")
            },
        },
        "verification": verification,
        "pins": pins_doc,
    }


def build_board_ir(
    netlist_path: Path,
    mcu_desc: McuDesc | None = None,
    part_requested: str | None = None,
    part_resolved_by: str = "user",
    main_controller: str | None = None,
) -> tuple[dict, _Netlist, _Ref | None]:
    nl, fmt = _load_netlist(netlist_path)

    if main_controller is not None:
        ctrl = _Ref(main_controller)
        if ctrl not in nl.comps:
            raise SystemExit(f"error: --main-controller {main_controller!r} not found in netlist")
        runner_up: RunnerUp | None = None
        low_conf, detected_by = False, "override"
    else:
        ctrl, runner_up, low_conf = _detect_controller(nl)
        detected_by = "auto"

    cc = nl.comps[ctrl]
    doc: dict = {
        "schemaVersion": 1,
        "tool": TOOL_NAME,
        "source": {"file": netlist_path.name, "format": fmt, "board": nl.source},
        "components": _components_doc(nl),
        "nets": _nets_doc(nl),
        "controller": {
            "ref": ctrl,
            "part": cc.part or cc.value,
            "lib": cc.lib,
            "footprint": cc.footprint,
            "pinCount": _pin_count(nl, ctrl),
            "detectedBy": detected_by,
            "lowConfidence": low_conf,
            "runnerUp": dataclasses.asdict(runner_up) if runner_up else None,
        },
    }
    if mcu_desc is not None:
        doc["mcu"] = _mcu_doc(nl, ctrl, mcu_desc, part_requested, part_resolved_by)
    return doc, nl, ctrl


# ----------------------------------------------------------------------- CLI

def _sanitize(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_")
    return s or "board"


def _resolve_part(
    arg_part: str | None, nl: _Netlist, ctrl: _Ref
) -> tuple[str | None, str | None, str]:
    """-> (requested raw, normalized, resolvedBy)."""
    comp = nl.comps[ctrl]
    for raw, how in ((arg_part, "user"), (comp.part, "netlist-libpart"), (comp.value, "netlist-value")):
        if raw:
            norm = normalize_part(raw)
            if norm.upper().startswith("STM32"):
                return raw, norm, how
    return None, None, "unresolved"


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="board_ir",
        description="Serialize a netlist (KiCad kicadxml or Altium/OrCAD .NET) as Board IR "
        "JSON; with an MCU pin table (--mcu-desc or --stm32kernel) also emit the "
        "position→pad join and, unless --no-map, the stm32_map suggestions + cfg seed.",
    )
    parser.add_argument("netlist_file")
    parser.add_argument("--mcu-desc", help="describe-mcu-shaped JSON file (offline pin table)")
    parser.add_argument("--stm32kernel", help="stm32kernel binary; runs `describe-mcu <part>`")
    parser.add_argument("--data-dir", help="--data-dir for the stm32kernel subprocess")
    parser.add_argument("--part", help="MCU marking/ordering code, e.g. STM32F405RGT6 "
                        "(required with --stm32kernel when the netlist has no part string)")
    parser.add_argument("--main-controller", help="override controller auto-detection (ref)")
    parser.add_argument("--out-dir", help="write <stem>_board_ir.json (+ map/seed) here; "
                        "stdout if omitted")
    parser.add_argument("--stem", help="output file stem (default: netlist stem, sanitized)")
    parser.add_argument("--no-map", action="store_true", help="skip stm32_map/cfg_seed emission")
    parser.add_argument("--version", action="version", version=TOOL_NAME)
    args = parser.parse_args()

    netlist_path = Path(args.netlist_file)

    # A first parse to resolve the part string (cheap; files are small).
    nl0, _ = _load_netlist(netlist_path)
    if args.main_controller and _Ref(args.main_controller) in nl0.comps:
        ctrl0 = _Ref(args.main_controller)
    else:
        ctrl0, _, _ = _detect_controller(nl0)
    requested, part, resolved_by = _resolve_part(args.part, nl0, ctrl0)

    desc: McuDesc | None = None
    if args.mcu_desc:
        desc = load_mcu_desc(Path(args.mcu_desc))
        if part is None:
            requested, part, resolved_by = desc.ref_name, desc.ref_name, "mcu-desc"
        elif part not in desc.part.get("partNumbers", [desc.ref_name]) and part != desc.ref_name:
            print(
                f"Warning: --part {part} does not match --mcu-desc {desc.ref_name}; "
                "using the pin table from --mcu-desc.",
                file=sys.stderr,
            )
    elif args.stm32kernel:
        if part is None:
            raise SystemExit("error: --stm32kernel needs a part number; pass --part")
        desc = describe_mcu_via_kernel(args.stm32kernel, part, args.data_dir)

    doc, nl, ctrl = build_board_ir(
        netlist_path, desc, requested, resolved_by, args.main_controller
    )

    stem = args.stem or _sanitize(netlist_path.stem)
    if args.out_dir is None:
        print(json.dumps(doc, indent=2, ensure_ascii=False))
    else:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        ir_path = out_dir / f"{stem}_board_ir.json"
        ir_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {ir_path}", file=sys.stderr)

    if desc is not None and not args.no_map:
        from .stm32_map import build_stm32_map

        map_doc = build_stm32_map(doc, desc)
        if args.out_dir is None:
            print(json.dumps(map_doc, indent=2, ensure_ascii=False))
        else:
            out_dir = Path(args.out_dir)
            map_path = out_dir / f"{stem}_stm32_map.json"
            seed_path = out_dir / f"{stem}_cfg_seed.json"
            map_path.write_text(
                json.dumps(map_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            seed_path.write_text(
                json.dumps(map_doc["cfgSeed"], indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print(f"wrote {map_path}\nwrote {seed_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
