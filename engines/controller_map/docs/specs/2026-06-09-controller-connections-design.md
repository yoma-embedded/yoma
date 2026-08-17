# DESIGN SPEC: `connections` — re-express a controller map as two lossless views

> Status: design, approved (L1 scope), awaiting implementation. A post-processor that
> consumes the JSON emitted by `controller_map` and re-expresses each controller pin's
> connections as two complementary views — **去向 (destinations)** and **途经电路 (paths)** —
> without losing any circuit information. Standalone module in the existing
> `controller_map` package.

## 1. Purpose & scope

### Purpose
The `controller_map` JSON nests every connection of a pin inside one `traced` array, mixing
two questions a reader actually asks separately:

1. **去向 / destinations** — *where does this pin ultimately go, and to what kind of device?*
   (a connector, another IC, an LED, a test point, a power rail …)
2. **途经电路 / paths** — *what circuit does each of those connections pass through?*
   (a 150 Ω series resistor, a 100 kΩ pull-up, a closed solder bridge, nothing …)

`connections` reads a `controller_map` JSON and re-projects it into these two views so each
question can be answered directly, while **preserving every component value and the full
local topology** — nothing the original capture knew is dropped.

### Scope: **L1 only** — preserve, do not interpret
This spec is **L1**: lossless reorganization plus *factual* device classification
(`endpoint_class`, derived from the reference-designator prefix — the same kind of
prefix logic the core tool already uses). It deliberately does **not** compute or label any
*electrical* meaning:

- **No** `pull_up`/`pull_down`/`series`/`voltage_divider`/`rc_filter` labels.
- **No** divider ratio, no RC cutoff, no current-sense interpretation.

Those are **L2**, explicitly deferred (§8). The L1 guarantee is only that the raw
`value`s and topology survive intact, so any such number is *recoverable by the reader* even
though L1 does not *compute* it.

### Relationship to `controller_map`
`connections` is a **pure post-processor**. It reads the `controller_map` **JSON** (file or
stdin) — never the original netlist — so it stays decoupled from the KiCad/Altium parsers and
composes as a pipe: `controller_map board.NET --main-controller U1 | connections`.

## 2. Input

A `controller_map` JSON object (schema in the core tool's
`docs/specs/2026-06-06-controller-map-design.md` §8): top-level `source`, `controller`,
`format`, `signal_pins[]`, each pin carrying `pin`, `pin_name`, `net`, `direct_nodes[]`,
`traced[]`. **Only `signal_pins[].traced[]` is consumed** (plus the header fields, copied
through). `direct_nodes` is intentionally **not** used — it is the raw, noisy net-membership
view (it includes the far legs of series passives and stub caps); `traced` is the cleaned set
of meaningful endpoints the core tool already resolved.

Read order: positional path argument; if omitted, read stdin. Validate the object has a
`signal_pins` array; otherwise error to stderr and exit non-zero.

## 3. Canonical connection record (the lossless master)

Every `traced` entry of every signal pin becomes exactly one flat **connection** record. This
record carries **both** the destination and the path, so it loses nothing; the two views (§4)
are pure projections of it.

```jsonc
{
  "controller_pin": "AC9",          // controller pin number / ball
  "pin_name": "P0.14",              // resolved name from the core tool
  "net": "P0.14",
  "endpoint": {                      // the sink; null iff this path terminates on a rail
    "ref": "LED2", "pin": "1", "pin_name": "1", "value": "L0603G"
  },
  "rail": null,                      // set (e.g. "+3V3") iff endpoint is null
  "endpoint_class": "led",           // factual class by ref prefix (§5); "rail" when rail set
  "via": [                           // circuit crossed; FULL raw values preserved, no interpretation
    { "ref": "SB6", "value": "Solderbridge", "kind": "solderbridge",
      "pin_in": "1", "pin_out": "2", "dnf": false }
  ],
  "hops": 1,                         // len(via); 0 == direct wire. Convenience for sort/filter.
  "dnf": false                       // path open (an unpopulated via, or a DNF endpoint)
}
```

`via` entries are copied through **verbatim** from the source `traced[].via[]` — every
`value` (`"150R"`, `"100k"`, `"2R2"`, `"10µH"`, `"DNF"`, `"Solderbridge"`) is retained exactly.
This is the L1 no-loss guarantee.

## 4. The two views (projections of §3) + CLI

The tool emits the canonical list by default and can project to either view via a flag.

### Default — canonical (`*_connections.json`)
```jsonc
{
  "tool": "connections v0.1.0",
  "source": "pca10056",
  "controller": { "ref": "U1", "part": "nRF52840-QIAA", "lib": "...", "pin_count": 74 },
  "connections": [ /* §3 records, sorted (§6) */ ]
}
```

### View 1 — destinations (`--view destinations`): *去向*
Pin-grouped; "where does each pin go, to what kind of device." Distinct destinations per pin
(dedupe identical `ref`+`pin`). Rail terminations are **included**, classed `"rail"`, so
pull-ups/strapping are not silently lost — the reader can filter them out if undesired.
```jsonc
{ "controller_pin": "AC9", "pin_name": "P0.14", "net": "P0.14",
  "destinations": [
    { "ref": "P24",  "pin": "4", "value": "Socket 2x9", "class": "connector", "dnf": false },
    { "ref": "LED2", "pin": "1", "value": "L0603G",     "class": "led",       "dnf": false }
  ] }
```

### View 2 — paths (`--view paths`): *途经电路*
Each connection with the circuit it crosses, full values intact. Keyed by `controller_pin` +
destination so it correlates back to View 1. Direct connections (`via: []`) are included for
completeness; the interesting rows are the ones that cross components. For a **rail
termination** `to` is `null` and `rail` carries the rail name (e.g. a pull-up: `to: null`,
`rail: "VDD_IMCU"`, `via: [{R8 100k}]`).
```jsonc
{ "controller_pin": "AC9", "to": { "ref": "LED2", "pin": "1" }, "rail": null,
  "via": [ { "ref": "SB6", "value": "Solderbridge", "kind": "solderbridge", "dnf": false } ],
  "hops": 1, "dnf": false }
```

### CLI
```
connections [INPUT_JSON] [--view canonical|destinations|paths] [--output PATH]
```
- positional `INPUT_JSON` — a `controller_map` JSON; **stdin** if omitted.
- `--view` — `canonical` (default) | `destinations` | `paths`.
- `--output PATH` — write here; **stdout** if omitted.
- `--split` — write all three to `<stem>_connections.json`, `<stem>_destinations.json`,
  `<stem>_paths.json` next to `--output`'s stem (or the input's stem). Convenience for the
  "two files" workflow.
- `--version`.
- **JSON to stdout, all diagnostics to stderr** — matches the core tool so it pipes into `jq`.

## 5. `endpoint_class` — factual classification by ref prefix

A pure lookup on the endpoint's leading-alpha ref token (`re.match(r"[A-Za-z]+", ref)`),
mirroring the prefix reasoning already in `controller_map`. When the connection terminates on
a rail (`rail` set, `endpoint` null), the class is `"rail"` regardless of prefix.

| prefix(es) | class | examples on these boards |
|---|---|---|
| `P`, `J` | `connector` | `P24` Socket 2x9, `J5` FPC, `J4` TC2050 debug |
| `U` | `ic` | `U7` FSA2466UMX analog switch, flash, debugger |
| `LED` | `led` | `LED2`/`LED4` L0603G |
| `TP` | `testpoint` | `TP47`, `TP18` |
| `Y`, `X` | `crystal` | `Y1` ABM8 |
| `SW`, `S` | `switch` | tactile / slide |
| `D` | `diode` | — |
| `Q` | `transistor` | — |
| `K` | `relay` | — |
| `FB`, `FL`, `R`, `L`, `C` | `passive` | rare as a terminal endpoint |
| `SB`, `JP`, `LK` | `bridge` | an **open** bridge that stayed an endpoint |
| (rail termination) | `rail` | `VDD_nRF`, `+3V3`, `GND` |
| anything else | `other` | honest fallback — never guess |

The mapping keys on the **full** leading-alpha token, so `LED2`→`LED`→`led` and `L4`→`L`→
`passive` never collide. The table is a single editable dict; unknown prefixes fall to
`other` (matching the core tool's "non-hop ⇒ endpoint, even if prefix unknown" honesty).

## 6. Determinism

Stable, diffable output. `connections` sorted by `(natkey(controller_pin),
natkey(endpoint.ref or ""), natkey(endpoint.pin or ""), rail or "")`. Within a pin, View 1
`destinations` sorted by `(natkey(ref), natkey(pin))`. `via` order is preserved from the
source (already source-ordered). Reuse the package's existing `natkey` (from
`netlist_model`) so numeric and BGA-grid pins (`2` vs `A1`) never compare int-vs-str. JSON
`ensure_ascii=False`, `indent=2`, trailing newline — same as the core tool.

## 7. Project changes

- **New module** `controller_map/connections.py` — model (plain dataclasses or dicts), the
  projection functions, and `main()`. ~150–200 lines, stdlib only.
- **New console script** in `pyproject.toml`:
  `connections = "controller_map.connections:main"`.
- **New test** `tests/check_connections.py` — a plain runnable script (project has no pytest
  convention), asserting against the committed fixtures' maps regenerated in `out/` (or by
  running the core tool in-process and piping the dict through).

## 8. Non-goals (deferred to L2, not in this spec)

- **No electrical interpretation.** No `pull_up`/`pull_down`/`series`/`voltage_divider`/
  `rc_filter` labels; no divider ratio; no RC cutoff; no shunt/current-sense detection.
- **No value parsing.** L1 keeps `value` strings verbatim; it does not parse `"4k7"`→4700 or
  normalize `µ` mojibake (connectivity-irrelevant, see core spec §12).
- **No re-running the netlist parse.** Input is the `controller_map` JSON only.
- **No CSV/SVG.** JSON only in L1. (A CSV emitter would be a thin downstream add later.)
- **No merging of multiple controller maps.**

These are recorded so L2 can layer cleanly: an L2 `circuit` annotation field would attach to
the §3 record beside `via`, with the raw `via` values remaining authoritative.

## 9. Validated outputs (assert in `tests/check_connections.py`)

From the committed fixtures' maps:

- **`nordic_nRF52840` `P0.14` (AC9):** destinations `= [P24.4 connector, LED2.1 led]`; the
  path to `LED2.1` has `via = [SB6 solderbridge]`; the path to `P24.4` has `via = []`.
- **`nordic_auto` `IMCU_RESET` (AC31):** destinations include `J4.10 connector`,
  `TP50.1 testpoint`, and `rail VDD_IMCU`; the rail path preserves `via[0].value == "100k"`
  (the no-loss guarantee — the 100 kΩ pull-up value survives, even though L1 does not *label*
  it a pull-up).
- **`nordic_auto` `SWD1_CLK` (AK28):** destinations are two `connector`s (`P20`, `P26`); each
  path preserves `via[0].value == "150R"`.
- **`RP2040` `QSPI_SS` (56):** destinations `= [U2.1 ic, J2.1 connector, rail +3V3]`; the
  `+3V3` path has `dnf == true` and preserves `via[0].value == "DNF"`.
- **Round-trip count:** total `connections` == sum over pins of `len(traced)` (every traced
  entry maps to exactly one connection; none dropped, none duplicated).

## 10. Build sequence

1. `connections.py`: input loader (file/stdin + validation) and the canonical record builder
   that flattens `signal_pins[].traced[]` → §3 records, with `endpoint_class` (§5) and `hops`.
   Assert the round-trip count and `QSPI_SS` records on the RP2040 map.
2. `connections.py`: the two projections (§4 destinations, paths) + deterministic sort (§6).
   Assert the `P0.14`, `IMCU_RESET`, `SWD1_CLK` cases (§9).
3. `connections.py`: `argparse` `main()` (`--view`, `--output`, `--split`, stdin, stderr
   diagnostics) and the console-script wiring in `pyproject.toml`. Run end-to-end on all three
   fixtures; confirm it pipes (`controller_map ... | connections --view destinations`).
4. `tests/check_connections.py`: collect the §9 asserts into the runnable script.

## 11. Slimmed schema (as-built — supersedes the field lists in §3–§6)

After the first build the output was trimmed to drop derived/redundant fields. The verbose
records of §3–§4 are replaced by these lean ones; the connectivity content is identical.

**Connection record (canonical):**
```json
{ "pin": "AA24", "net": "SWDCLK",
  "to": "U6.4", "class": "ic", "value": "FSA2466UMX",
  "via": [ { "ref": "SB55", "value": "Solderbridge", "kind": "solderbridge" } ],
  "dnf": false }
```
- `to` is `"REF.PIN"` for a device, or the **rail name** for a power/gnd termination
  (`class == "rail"` disambiguates; `value` is `null` for a rail). This **merges** the old
  separate `endpoint{}` object and `rail` field.
- `class` = the old `endpoint_class`. `value` = the destination part's value.
- `via` keeps only `{ref, value, kind}` per crossed part — the component **value is preserved
  verbatim** (the no-loss guarantee).

**Dropped** (derived or low-value): top-level `pin_name` (== `pin` on Altium), `endpoint.pin_name`,
`via[].pin_in`/`pin_out`, `via[].dnf` (record-level `dnf` covers "path open"), `hops`
(= `len(via)`), `tool`, and `controller.lib`/`pin_count`/`detected_by`.

**Header:** `{source, format, controller:{ref, part}}` only.

**Views:** `destinations` groups by pin into `dests:[{to,class,value,dnf}]`; `paths` is
`[{pin,net,to,via,dnf}]`. `--view canonical` (default) is the flat list above.

**Single known tradeoff:** dropping `via[].dnf` loses *which* part is unpopulated in a
multi-hop path (record `dnf` still flags the whole path open). No in-scope board exceeds one
hop, so this is lossless in practice; restore per-via `dnf` if multi-hop boards appear.
```
