"""Fixture-free checks for the Smart PDF outline parser."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from pypdf import PdfWriter

from controller_map.smart_pdf import _popup_properties, parse_altium_smart_pdf, parse_outline_records


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}", file=sys.stderr)
        raise SystemExit(1)
    print(f"  ok: {message}")


schematic = 'Schematic("All Documents",Physical)'
records = [
    ((schematic, "Sheet A", "Components"), 1),
    ((schematic, "Sheet A", "Components", "U1"), 1),
    ((schematic, "Sheet A", "Components", "U1", "U1-01"), 1),
    ((schematic, "Sheet A", "Components", "R1"), 1),
    ((schematic, "Sheet A", "Components", "R1", "R1-2"), 1),
    ((schematic, "Sheet A", "Nets", "MOTOR_A", "Pins", "U1-01"), 1),
    ((schematic, "Sheet A", "Nets", "MOTOR_A", "Pins", "R1-2"), 1),
    ((schematic, "Sheet A", "Nets", "MOTOR_A", "NetLabels", "MOTOR_A"), 1),
    (("Assembly Drawings", "Board.PcbDoc", "Components", "CART-8L-1"), 7),
]
components, nets = parse_outline_records(records)
check(components == [("U1", 1, ("01",)), ("R1", 1, ("2",))], "finds Components below arbitrary root/sheet paths")
check(nets == {"MOTOR_A": {("U1", "01"), ("R1", "2")}}, "reads only Nets/<net>/Pins members")
check(all(ref != "CART-8L-1" for ref, _page, _pins in components), "ignores Assembly Drawings branches")
check(
    _popup_properties(
        r'var x=app.popUpMenu("Comment: 10k", "Footprint: R_0603", '
        r'"Library Name: RES.SchLib", "Library Reference: ignored", "Value: ignored")'
    )
    == {
        "Comment": "10k",
        "Footprint": "R_0603",
        "Library Name": "RES.SchLib",
    },
    "reads inert menu labels safely",
)
check(_popup_properties('app.alert("never execute")') == {}, "does not treat arbitrary JavaScript as properties")

with tempfile.TemporaryDirectory() as directory:
    ordinary = Path(directory) / "ordinary.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with ordinary.open("wb") as stream:
        writer.write(stream)
    try:
        parse_altium_smart_pdf(ordinary)
    except ValueError as exc:
        check("not an Altium Smart PDF" in str(exc), "rejects ordinary PDFs explicitly")
    else:
        check(False, "ordinary PDF should be rejected")

print("ALL SMART PDF CHECKS PASSED")
