"""Reproducible verification for board_ir / mcu_desc / the Altium header+encoding fixes.

Run:  uv run python tests/check_board_ir.py
Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from controller_map.altium_parser import parse_altium_net
from controller_map.board_ir import build_board_ir, net_kind, parse_freq_hz
from controller_map.mcu_desc import base_pad, load_mcu_desc, normalize_part, split_signal

FIX = Path(__file__).parent / "fixtures"
_checks = 0


def check(cond: bool, msg: str) -> None:
    global _checks
    _checks += 1
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  ok: {msg}")


print("== Altium header disambiguation + GBK + variants (synthetic) ==")
# Exercises: multi-word footprint with EMPTY value (trailing space!), multi-word value,
# GBK-encoded µ, variant-duplicated refdes, zero-pin component.
synthetic = (
    "( {OrCAD PCB II Netlist Format}\r\n"
    " ( 00000001 M3 Spade Hole J7 \r\n"
    " )\r\n"
    " ( 00000002 DFN220P320X110-4N XT1 8 MHz\r\n"
    "  ( 1 OSC1 )\r\n"
    "  ( 3 OSC2 )\r\n"
    " )\r\n"
    " ( 00000003 CAPC1608X09L C1 2.2μF\r\n"
    "  ( 1 GND )\r\n"
    "  ( 2 OSC1 )\r\n"
    " )\r\n"
    " ( 00000004 CAP_ELEC C11 120uF\r\n"
    "  ( 1 DCBUS )\r\n"
    "  ( 2 PGND )\r\n"
    " )\r\n"
    " ( 00000005 CAP_ELEC C11 470uF\r\n"
    "  ( 1 DCBUS )\r\n"
    "  ( 2 PGND )\r\n"
    " )\r\n"
    ")\r\n"
)
with tempfile.NamedTemporaryFile(suffix=".NET", delete=False) as f:
    f.write(synthetic.encode("gbk"))
    tmp = Path(f.name)
nl = parse_altium_net(tmp)
tmp.unlink()

check(set(nl.comps) == {"J7", "XT1", "C1", "C11"}, "refs parsed: J7/XT1/C1/C11 (no 'Spade'/'Hole' ghosts)")
check(nl.comps["J7"].footprint == "M3 Spade Hole" and nl.comps["J7"].value == "",
      "multi-word footprint + empty value ('M3 Spade Hole J7 ')")
check(nl.comps["XT1"].value == "8 MHz", "multi-word value ('8 MHz')")
check(nl.comps["C1"].value == "2.2μF", "GBK 'µ' decoded (2.2µF)")
check(nl.comps["C11"].value == "120uF" and nl.comps["C11"].values == ("120uF", "470uF"),
      "variant-duplicated C11 merged: value=first, values=both")
check(nl.pins_of.get("J7", set()) == set(), "zero-pin component survives")
check(nl.net_of["XT1"]["1"] == "OSC1", "pin->net kept through variants")

print("== parse_freq_hz ==")
for text, hz in [("8 MHz", 8_000_000), ("8MHz", 8_000_000), ("32.768kHz", 32_768),
                 ("25M", 25_000_000), ("16.000MHz", 16_000_000), ("8000000", 8_000_000),
                 ("120uF", None), ("4.7uF", None), ("GRM21BR61H475KE51L", None), ("", None)]:
    check(parse_freq_hz(text) == hz, f"parse_freq_hz({text!r}) == {hz}")

print("== normalize_part / base_pad / split_signal ==")
check(normalize_part("STM32F405RGT6") == "STM32F405RGTx", "STM32F405RGT6 -> STM32F405RGTx")
check(normalize_part("STM32F103C8T6") == "STM32F103C8Tx", "STM32F103C8T6 -> STM32F103C8Tx")
check(normalize_part("STM32F405RGT6TR") == "STM32F405RGTx", "tape-and-reel TR suffix stripped")
check(normalize_part("STM32F405RGTx") == "STM32F405RGTx", "already-normalized unchanged")
check(normalize_part("STM32F103C(8-B)Tx") == "STM32F103C(8-B)Tx", "RefName group unchanged")
check(base_pad("PA0-WKUP") == "PA0", "base_pad strips -WKUP")
check(base_pad("PC13-ANTI_TAMP") == "PC13", "base_pad strips -ANTI_TAMP")
check(base_pad("BOOT0") == "BOOT0", "base_pad keeps non-port names")
insts = ["USART1", "UART4", "USB_OTG_FS", "TIM1", "ADC1", "SYS"]
check(split_signal("USART1_TX", insts) == ("USART1", "TX"), "USART1_TX split")
check(split_signal("USB_OTG_FS_DM", insts) == ("USB_OTG_FS", "DM"), "USB_OTG_FS_DM longest-prefix split")
check(split_signal("SYS_JTMS-SWDIO", insts) == ("SYS", "JTMS-SWDIO"), "SYS signal split")
check(split_signal("GPIO", insts) is None, "GPIO pseudo-signal -> None")

print("== F405 mcu-desc fixture ==")
desc = load_mcu_desc(FIX / "STM32F405RGTx.mcudesc.json")
check(desc.ref_name == "STM32F405RGTx" and desc.part.get("package") == "LQFP64", "fixture identity")
check(len(desc.pins) == 64, "64 pins")
pa0 = desc.by_position["14"]
check(pa0.name == "PA0-WKUP" and "UART4_TX" in pa0.signals and "GPIO" in pa0.signals,
      "PA0-WKUP at position 14 with UART4_TX + GPIO pseudo-signal")
check(desc.by_position["1"].kind == "Power" and desc.by_position["60"].kind == "Boot",
      "VBAT Power / BOOT0 Boot kinds")

print("== ODrive Board IR ==")
ir, nl2, ctrl = build_board_ir(FIX / "odrive_two_ax.NET", desc, "STM32F405RGT6", "user")
check(ctrl == "U2", "controller detected: U2 (not the Murata cap with the Kinetis-looking MPN)")
check(ir["mcu"]["verification"]["score"] == 1.0, "part verification score 1.0")
check(ir["mcu"]["verification"]["mismatches"] == [], "no supply-pad mismatches")
check(ir["mcu"]["verification"]["ioConnected"] >= 45, "most I/O pads carry nets")

pins = {p["position"]: p for p in ir["mcu"]["pins"]}
check(pins["46"]["role"] == "swd" and pins["49"]["role"] == "swd", "PA13/PA14 role swd")
check(pins["5"]["role"] == "crystal" and pins["5"]["crystal"]["freqHz"] == 8_000_000,
      "PH0 role crystal, XT1 8 MHz parsed")
check(pins["60"]["role"] == "boot" and pins["7"]["role"] == "reset", "BOOT0 boot / NRST reset")
check(pins["41"]["pad"] == "PA8" and pins["41"]["net"] == "M0_AH_1", "position 41 -> PA8 -> M0_AH_1")
check(pins["22"]["role"] == "signal" and pins["22"]["net"] == "VBUS_S_1",
      "PA6/VBUS_S_1 is a signal (sense divider), not a rail")
check(pins["31"]["role"] == "power", "VCAP1 stays a power-role pin")

comps = {c["ref"]: c for c in ir["components"]}
check(comps["U2"]["class"] == "ic" and comps["U2"]["footprint"] == "STM-LQFP64_N", "U2 census")
check(comps["C11"].get("values") == ["120uF", "470uF"], "C11 variant values in IR")
check(comps["XT1"]["class"] == "crystal", "XT1 classified crystal")
check(comps["NT1"]["class"] == "nettie", "NT1 classified nettie")

nets = {n["name"]: n for n in ir["nets"]}
check(nets["VCC"]["kind"] == "power" and nets["AGND"]["kind"] == "ground", "VCC power / AGND ground")
check(nets["DCBUS"]["kind"] == "power", "DCBUS classified power")
check(nets["VBUS_S_1"]["kind"] == "signal", "VBUS_S_1 classified signal")
check(net_kind("AVCC") == "power", "AVCC classified power")
check(net_kind("GND_1") == "ground", "sheet-suffixed GND_1 classified ground (not power)")

ir2, _, _ = build_board_ir(FIX / "odrive_two_ax.NET", desc, "STM32F405RGT6", "user")
check(json.dumps(ir, sort_keys=True) == json.dumps(ir2, sort_keys=True), "deterministic output")

print("== SumoBot Board IR (module-style pad-name join; aliases must not clobber) ==")
desc103 = load_mcu_desc(FIX / "STM32F103C8Tx.mcudesc.json")
ir3, _, ctrl3 = build_board_ir(FIX / "sumobot_eeschema.net", desc103, "STM32F103C8Tx", "user")
check(ctrl3 == "U3", "controller detected: U3 blue-pill module")
spins = {p["pad"]: p for p in ir3["mcu"]["pins"]}
check(spins["PB3"]["net"] == "/LED103" and spins["PB3"]["role"] == "signal",
      "PB3 keeps /LED103 (the unconnected SWO alias no longer overwrites the pad-name join)")
check(spins["PB3"]["connections"][0]["endpoint"]["ref"] == "D13"
      and spins["PB3"]["connections"][0]["via"][0]["ref"] == "R03",
      "PB3 traces to LED D13 via R03")
check(spins["PA14"]["net"] == "unconnected-(U3-PadSWCLK)",
      "SWCLK alias still joins PA14 (no pad-name competitor)")
check(spins["PA2"]["net"] == "/M101" and spins["PA2"]["role"] == "signal",
      "PA2 joined to /M101 by pad name")

print(f"\nALL {_checks} CHECKS PASSED")
