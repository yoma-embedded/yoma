"""MCU pin-table adapter: load a `stm32kernel describe-mcu`-shaped JSON and join it
against netlist pin numbers.

The describe-mcu document is the contract (see stm32-config-kernel
`crates/cli/src/cmds.rs::describe_mcu`):

    {
      "part": { "refName": "STM32F405RGTx", "package": "LQFP64", "family": "STM32F4", ... },
      "pins": [ { "name": "PA0-WKUP", "position": "14", "kind": "Io",
                  "signals": ["ADC1_IN0", ..., "UART4_TX", "GPIO"] }, ... ],
      "ipInstances": [ { "instance": "USART1", "name": "USART", ... }, ... ]
    }

`position` is the package pin position as a string — numeric on LQFP ("14"),
alphanumeric on BGA ("A1") — and is exactly what a netlist calls the pin number.
Signal names are FULL `{INSTANCE}_{FUNCTION}` strings; the kernel's config document
wants the SHORT form (`TX`, not `USART1_TX`) in `peripherals.*.pins`, and BARE pad
names (`PA0`, not `PA0-WKUP`) everywhere.

Sources: `--mcu-desc file.json` (offline, canonical) or a live
`stm32kernel describe-mcu <part>` subprocess. `tools/cubemx_to_mcudesc.py` produces
the same shape from an ST `STM32_open_pin_data` / CubeMX `db/mcu/STM32*.xml` file.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

_PAD_RE = re.compile(r"^(P[A-Z]\d+)")
# Ordering codes end in a temperature-grade digit (3/6/7); the db replaces it with
# 'x' ("STM32F405RGT6" -> "STM32F405RGTx"). Packing suffixes ("TR" tape-and-reel)
# are stripped first; anything else unrecognized is passed through untouched.
_MARKING_RE = re.compile(r"^(STM32[A-Z0-9]+?)([367])$", re.IGNORECASE)


@dataclass(frozen=True)
class McuPin:
    name: str  # db pad name, may carry a suffix: "PA0-WKUP", "PC13-ANTI_TAMP"
    position: str
    kind: str  # "Io" | "Power" | "Reset" | "Boot" | "MonoIo" | "Nc" | "Other"
    signals: tuple[str, ...]  # full signal names + "GPIO" pseudo-signal


@dataclass
class McuDesc:
    part: dict  # describe-mcu "part" object (refName, package, family, ...)
    pins: list[McuPin]
    ip_instances: list[dict]
    by_position: dict[str, McuPin] = field(default_factory=dict)

    @property
    def ref_name(self) -> str:
        return self.part.get("refName", "")

    def instances(self) -> list[str]:
        return [i.get("instance", "") for i in self.ip_instances if i.get("instance")]


def base_pad(name: str) -> str:
    """'PA0-WKUP' -> 'PA0'; non-port names ('VBAT', 'BOOT0', 'NRST') pass through
    unchanged. The kernel resolves user-written pads base-first, so config documents
    should always use the base name."""
    m = _PAD_RE.match(name)
    return m.group(1) if m else name


def normalize_part(marking: str) -> str:
    """Chip marking / ordering code -> db part-number form.
    'STM32F405RGT6' -> 'STM32F405RGTx'; an already-normalized name ('...Tx') or a
    RefName group ('STM32F103C(8-B)Tx') is returned unchanged."""
    s = marking.strip()
    if not s.upper().startswith("STM32"):
        return s
    if s.endswith("x") or "(" in s:
        return s
    if s.upper().endswith("TR"):  # tape-and-reel packing suffix
        s = s[:-2]
    m = _MARKING_RE.match(s)
    if m is None:
        return s
    return m.group(1).upper() + "x"


def _parse_desc(doc: dict) -> McuDesc:
    pins = [
        McuPin(
            p.get("name", ""),
            str(p.get("position", "")),
            p.get("kind", "Other"),
            tuple(p.get("signals", [])),
        )
        for p in doc.get("pins", [])
    ]
    desc = McuDesc(doc.get("part", {}), pins, doc.get("ipInstances", []))
    desc.by_position = {p.position: p for p in pins}
    return desc


def load_mcu_desc(path: Path) -> McuDesc:
    return _parse_desc(json.loads(path.read_text(encoding="utf-8")))


def describe_mcu_via_kernel(binary: str, part: str, data_dir: str | None) -> McuDesc:
    cmd = [binary, "describe-mcu", part]
    if data_dir:
        cmd += ["--data-dir", data_dir]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(
            f"error: `{' '.join(cmd)}` exited {proc.returncode}: {proc.stderr.strip()}"
        )
    return _parse_desc(json.loads(proc.stdout))


# --------------------------------------------------------------- signal splitting

def split_signal(signal: str, instances: list[str]) -> tuple[str, str] | None:
    """'USART1_TX' -> ('USART1', 'TX'); 'USB_OTG_FS_DM' -> ('USB_OTG_FS', 'DM')
    (longest ipInstances prefix wins); 'GPIO' -> None. Falls back to splitting at
    the first underscore when no instance matches."""
    if "_" not in signal:
        return None
    for inst in sorted(instances, key=len, reverse=True):
        if signal.startswith(inst + "_"):
            return inst, signal[len(inst) + 1 :]
    head, _, tail = signal.partition("_")
    return (head, tail) if tail else None


# ----------------------------------------------------------------- verification

def verify_part(
    desc: McuDesc,
    net_by_position: dict[str, str | None],
    is_power_net,
) -> dict:
    """Cross-check the netlist's MCU footprint against the part's pin table.
    The netlist cannot prove a part number; this catches a *wrong* one: package pin
    count must match, and every V*-named supply pad (kind Power, excluding VCAP*)
    must sit on a power/ground-classified net. Returns a JSON-ready report."""
    positions = set(desc.by_position)
    netlist_positions = set(net_by_position)
    unknown = sorted(netlist_positions - positions)

    _GROUND_RE = re.compile(r"(?i)^A?GND|^GND|^[APDS]?GND|^VSS|^GROUND$|^EARTH$")

    checked = 0
    matched = 0
    mismatches: list[dict] = []
    for pin in desc.pins:
        if pin.kind != "Power" or not pin.name.startswith("V"):
            continue
        if pin.name.startswith("VCAP"):  # legitimately on an auto-named cap net
            continue
        net = net_by_position.get(pin.position)
        if net is None:
            continue  # unconnected supply pad is a layout question, not an ID question
        checked += 1
        wants_ground = pin.name.startswith("VSS")
        clean = net.lstrip("/").lstrip("+")
        is_ground = bool(_GROUND_RE.match(clean))
        ok = (is_ground == wants_ground) and is_power_net(net)
        if ok:
            matched += 1
        else:
            mismatches.append({"position": pin.position, "pad": pin.name, "net": net})

    # Io coverage: a wrong controller ref / wrong package leaves most positions netless.
    io_positions = [p.position for p in desc.pins if p.kind == "Io"]
    io_connected = sum(1 for pos in io_positions if net_by_position.get(pos))

    score = (matched / checked) if checked else 0.0
    report = {
        "package": desc.part.get("package"),
        "packagePins": len(desc.pins),
        "netlistPins": len(netlist_positions),
        "positionsNotInPackage": unknown,
        "powerChecked": checked,
        "powerMatched": matched,
        "ioPads": len(io_positions),
        "ioConnected": io_connected,
        "score": round(score, 3),
        "mismatches": mismatches,
    }
    if unknown:
        print(
            f"Warning: netlist pins {unknown} not present in {desc.ref_name} "
            f"({desc.part.get('package')}) — wrong part or package?",
            file=sys.stderr,
        )
    if checked and score < 0.8:
        print(
            f"Warning: only {matched}/{checked} supply pads of {desc.ref_name} sit on "
            "correctly-classified power/ground nets — the part number is probably wrong "
            "for this netlist.",
            file=sys.stderr,
        )
    if checked < 2 or io_connected < max(4, len(io_positions) // 4):
        print(
            f"Warning: weak join — {checked} supply pads checked, {io_connected}/"
            f"{len(io_positions)} I/O pads carry nets. Wrong controller ref "
            "(--main-controller) or wrong part?",
            file=sys.stderr,
        )
    return report
