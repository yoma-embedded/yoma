"""Read Altium Smart PDF bookmarks as an ordinary ``_Netlist``.

The outline is the connectivity source of truth. JavaScript is read only as a
string from the PDF name tree to obtain Comment/Footprint; it is never run.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

from .netlist_model import _Comp, _Net, _NetName, _Netlist, _Node, _PinNum, _Ref, build_indices, natkey

_SHOW = re.compile(r"\b(ShowCompProps_[A-Za-z0-9_]+)\b")
_STRING = re.compile(r'"((?:\\.|[^"\\])*)"')


def _title(item: Any) -> str | None:
    value = item.get("/Title") if hasattr(item, "get") else None
    value = str(value).strip() if value is not None else ""
    return value or None


def _outline_records(
    items: Sequence[Any], reader: Any, prefix: tuple[str, ...] = ()
) -> list[tuple[tuple[str, ...], int | None]]:
    """Flatten pypdf's alternating ``item, [children]`` bookmark representation."""
    result: list[tuple[tuple[str, ...], int | None]] = []
    previous: tuple[str, ...] | None = None
    for item in items:
        if isinstance(item, list):
            if previous:
                result.extend(_outline_records(item, reader, previous))
            continue
        title = _title(item)
        if title is None:
            continue
        previous = prefix + (title,)
        try:
            page = reader.get_destination_page_number(item) + 1
        except Exception:
            page = None
        result.append((previous, page))
    return result


def _after(path: tuple[str, ...], branch: str) -> tuple[str, ...] | None:
    """Return the path below the first Components/Nets branch at any depth."""
    for index, title in enumerate(path):
        if title.casefold() == branch.casefold():
            return path[index + 1 :]
    return None


def _split_pin(label: str, refs: Iterable[str]) -> tuple[str, str] | None:
    for ref in sorted(set(refs), key=lambda value: (-len(value), natkey(value))):
        if label.startswith(ref):
            pin = label[len(ref) :].lstrip("- .:/_")
            if pin:
                return ref, pin
    return None


def parse_outline_records(
    records: Iterable[tuple[tuple[str, ...], int | None]],
) -> tuple[list[tuple[str, int | None, tuple[str, ...]]], dict[str, set[tuple[str, str]]]]:
    """Pure outline parser, kept public enough for fixture-free verification."""
    components: dict[str, tuple[int | None, set[str]]] = {}
    ordered: list[str] = []
    cached = list(records)
    schematic_roots = {
        path[0] for path, _page in cached if path and path[0].casefold().startswith("schematic(")
    }
    if schematic_roots:
        cached = [row for row in cached if row[0] and row[0][0] in schematic_roots]
    for path, page in cached:
        tail = _after(path, "Components")
        if not tail:
            continue
        ref = tail[0]
        if ref not in components:
            components[ref] = (page, set())
            ordered.append(ref)
        old_page, pins = components[ref]
        if old_page is None and page is not None:
            components[ref] = (page, pins)
        if len(tail) > 1:
            pin = tail[1][len(ref) :].lstrip("-") if tail[1].startswith(ref) else tail[1]
            if pin:
                pins.add(pin)

    nets: dict[str, set[tuple[str, str]]] = {}
    for path, _page in cached:
        tail = _after(path, "Nets")
        if not tail or len(tail) < 3 or tail[1].casefold() != "pins":
            continue
        member = _split_pin(tail[2], components)
        if member is not None:
            nets.setdefault(tail[0], set()).add(member)
    return [(ref, components[ref][0], tuple(sorted(components[ref][1], key=natkey))) for ref in ordered], nets


def _popup_properties(script: str) -> dict[str, str]:
    """Extract useful popUpMenu labels without evaluating JavaScript."""
    result: dict[str, str] = {}
    for match in _STRING.finditer(script):
        try:
            label = json.loads('"' + match.group(1) + '"')
        except json.JSONDecodeError:
            continue
        for key in ("Comment", "Footprint", "Library Name"):
            prefix = key + ":"
            if label.startswith(prefix):
                result.setdefault(key, label[len(prefix) :].strip())
    return result


def _name_tree(node: Any) -> dict[str, dict[str, str]]:
    node = node.get_object()
    result: dict[str, dict[str, str]] = {}
    for child in node.get("/Kids", ()):
        result.update(_name_tree(child))
    pairs = node.get("/Names", ())
    for index in range(0, len(pairs), 2):
        name = str(pairs[index])
        action = pairs[index + 1].get_object()
        script = action.get("/JS") if action.get("/S") == "/JavaScript" else None
        if script is not None and name.startswith("ShowCompProps_"):
            result[name] = _popup_properties(str(script))
    return result


def _page_property_ids(page: Any) -> list[str]:
    result: list[str] = []
    for indirect in page.get("/Annots", ()):
        annotation = indirect.get_object()
        action = annotation.get("/A")
        if action is None or action.get("/S") != "/JavaScript":
            continue
        match = _SHOW.search(str(action.get("/JS", "")))
        if match:
            result.append(match.group(1))
    return result


def parse_altium_smart_pdf(path: Path) -> _Netlist:
    """Parse Altium Smart PDF outline connectivity into the common internal model."""
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("parse_altium_smart_pdf requires pypdf") from exc
    reader = PdfReader(path)
    component_rows, net_members = parse_outline_records(_outline_records(reader.outline, reader))
    if not component_rows or not net_members:
        raise ValueError("not an Altium Smart PDF with Components and Nets/Pins outline branches")

    names = reader.trailer["/Root"].get("/Names")
    scripts = _name_tree(names["/JavaScript"]) if names and names.get("/JavaScript") else {}
    properties: dict[str, dict[str, str]] = {}
    for page_number, page in enumerate(reader.pages, start=1):
        refs = [ref for ref, component_page, _pins in component_rows if component_page == page_number]
        ids = _page_property_ids(page)
        if len(refs) != len(ids):
            print(
                f"Warning: Smart PDF page {page_number} has {len(refs)} outline components "
                f"but {len(ids)} ShowCompProps links; leaving that page's properties empty.",
                file=sys.stderr,
            )
            continue
        missing = [name for name in ids if name not in scripts]
        if missing:
            print(
                f"Warning: Smart PDF page {page_number} is missing {len(missing)} "
                "ShowCompProps name-tree entries; leaving that page's properties empty.",
                file=sys.stderr,
            )
            continue
        properties.update(zip(refs, (scripts[name] for name in ids)))

    comps = {
        _Ref(ref): _Comp(
            _Ref(ref),
            properties.get(ref, {}).get("Comment", ""),
            properties.get(ref, {}).get("Library Name", ""),
            "",
            properties.get(ref, {}).get("Footprint", ""),
            "",
        )
        for ref, _page, _pins in component_rows
    }
    nets = [
        _Net(_NetName(name), frozenset(_Node(_Ref(ref), _PinNum(pin), None) for ref, pin in members))
        for name, members in sorted(net_members.items(), key=lambda item: natkey(item[0]))
    ]
    result = _Netlist(path.stem, comps, {}, nets)
    build_indices(result)
    return result
