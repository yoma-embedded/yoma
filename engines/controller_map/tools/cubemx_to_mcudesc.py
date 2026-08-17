#!/usr/bin/env python3
"""Convert an ST CubeMX / STM32_open_pin_data MCU part XML into the
`stm32kernel describe-mcu` JSON shape consumed by `board_ir --mcu-desc`.

Source files: https://github.com/STMicroelectronics/STM32_open_pin_data
(`mcu/STM32F405RGTx.xml`, ...) — the same `db/mcu/*.xml` files the
stm32-config-kernel importer reads; the field semantics here mirror
`crates/importer/src/mcu.rs` (Type->kind mapping, RefName group expansion,
signals kept in document order including the "GPIO" pseudo-signal).

Usage:
    python tools/cubemx_to_mcudesc.py STM32F405RGTx.xml > STM32F405RGTx.mcudesc.json
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

_KIND = {
    "I/O": "Io",
    "Power": "Power",
    "Reset": "Reset",
    "Boot": "Boot",
    "MonoIO": "MonoIo",
    "NC": "Nc",
}


def expand_ref_name(ref_name: str) -> list[str]:
    """'STM32F103C(8-B)Tx' -> ['STM32F103C8Tx', 'STM32F103CBTx'] (cartesian over
    every '(a-b-c)' group; a name without groups expands to itself)."""
    results = [""]
    rest = ref_name
    while "(" in rest:
        open_i = rest.find("(")
        close_i = rest.find(")", open_i + 1)
        if close_i == -1:
            break
        literal, alts = rest[:open_i], rest[open_i + 1 : close_i].split("-")
        results = [prefix + literal + alt for prefix in results for alt in alts]
        rest = rest[close_i + 1 :]
    return [r + rest for r in results]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def convert(xml_path: Path) -> dict:
    root = ET.parse(xml_path).getroot()
    if _local(root.tag) != "Mcu":
        raise SystemExit(f"error: root element is <{_local(root.tag)}>, expected <Mcu>")

    def texts(name: str) -> list[str]:
        return [
            (el.text or "").strip()
            for el in root
            if _local(el.tag) == name and (el.text or "").strip()
        ]

    def text_int(name: str) -> int | None:
        vals = texts(name)
        return int(vals[0]) if vals else None

    ref_name = root.get("RefName", "")
    voltage = next((el for el in root if _local(el.tag) == "Voltage"), None)
    voltage_mv = None
    if voltage is not None and voltage.get("Min") and voltage.get("Max"):
        try:
            voltage_mv = [
                int(round(float(voltage.get("Min")) * 1000)),
                int(round(float(voltage.get("Max")) * 1000)),
            ]
        except ValueError:
            pass

    part = {
        "refName": ref_name,
        "partNumbers": expand_ref_name(ref_name),
        "family": root.get("Family", ""),
        "line": root.get("Line", ""),
        "package": root.get("Package", ""),
        "core": (texts("Core") or [""])[0],
        "die": (texts("Die") or [""])[0],
        "maxFreqMhz": text_int("Frequency"),
        "flashKb": [int(v) for v in texts("Flash")],
        "ramKb": [int(v) for v in texts("Ram")],
        "ioCount": text_int("IONb"),
        "voltageMv": voltage_mv,
        "clockTree": root.get("ClockTree", ""),
    }

    ip_instances = [
        {
            "instance": el.get("InstanceName", ""),
            "name": el.get("Name", ""),
            "version": el.get("Version", ""),
            "configFile": el.get("ConfigFile"),
        }
        for el in root
        if _local(el.tag) == "IP"
    ]

    pins = []
    for el in root:
        if _local(el.tag) != "Pin":
            continue
        signals = [
            sig.get("Name", "")
            for sig in el
            if _local(sig.tag) == "Signal" and sig.get("Name")
        ]
        pins.append(
            {
                "name": el.get("Name", ""),
                "position": el.get("Position", ""),
                "kind": _KIND.get(el.get("Type", ""), "Other"),
                "signals": signals,
            }
        )

    return {"part": part, "pins": pins, "ipInstances": ip_instances}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__.strip())
    print(json.dumps(convert(Path(sys.argv[1])), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
