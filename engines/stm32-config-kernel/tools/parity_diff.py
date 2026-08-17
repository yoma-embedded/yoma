#!/usr/bin/env python3
"""ODrive parity diff (plan §P7, driven by crates/codegen/tests/odrive_parity.rs).

Compares every generated `Core/Src/*.c` against the same-named reference
`Src/*.c` as a NORMALIZED PER-FUNCTION ASSIGNMENT/CALL-LINE MULTISET:

  1. strip USER CODE section interiors (both sides),
  2. strip comments and preprocessor conditionals' text is kept verbatim,
  3. expand `<label>_Pin` / `<label>_GPIO_Port` / `<label>_EXTI_IRQn`
     object-like macros from each side's OWN main.h (the reference names
     pads via ioc labels, the kernel names unlabeled pads raw — the
     compiler sees identical tokens, so the diff must too),
  4. split function bodies into `;`/`{`/`}`-terminated statements, collapse
     whitespace, keep only statements containing an assignment or a call,
  5. compare the multiset per same-named function plus the per-file
     function-name sets.

Additionally compares the `#define` NAME->VALUE map of FreeRTOSConfig.h
(generated Core/Inc vs reference Inc).

Every difference must match a row of the whitelist markdown table
(tests/parity/odrive/parity-whitelist.md); unmatched differences fail the
run (exit 1) and are printed. Unused whitelist rows are reported so the
whitelist cannot rot.

Usage: parity_diff.py GEN_DIR REF_DIR WHITELIST_MD
Output: human-readable report on stdout; exit 0 iff everything is matched.
"""

import re
import sys
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

USER_CODE_RE = re.compile(
    r"/\*\s*USER CODE BEGIN ([^*]*?)\s*\*/.*?/\*\s*USER CODE END \1\s*\*/",
    re.DOTALL,
)
COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.DOTALL)


def strip_user_code(text: str) -> str:
    """Remove USER CODE section interiors (anchors included)."""
    return USER_CODE_RE.sub("", text)


def strip_comments(text: str) -> str:
    """Remove /* */ and // comments (no string-literal comment lookalikes
    exist in CubeMX-shaped sources outside of printf examples, which live
    in USER CODE sections already removed)."""
    return COMMENT_RE.sub(" ", text)


PIN_DEFINE_RE = re.compile(
    r"^\s*#define\s+(\w+_(?:Pin|GPIO_Port|EXTI_IRQn))\s+([A-Za-z0-9_]+)\s*$",
    re.MULTILINE,
)


def pin_macro_table(main_h: Path) -> dict:
    if not main_h.is_file():
        return {}
    text = strip_comments(main_h.read_text(encoding="utf-8", errors="replace"))
    return dict(PIN_DEFINE_RE.findall(text))


def expand_macros(line: str, table: dict) -> str:
    """Expand pin-label object macros (single pass is enough: values are
    terminal GPIO_PIN_n / GPIOx / EXTIn_IRQn tokens)."""
    if not table:
        return line
    return re.sub(
        r"\b\w+_(?:Pin|GPIO_Port|EXTI_IRQn)\b",
        lambda m: table.get(m.group(0), m.group(0)),
        line,
    )


SIG_RE = re.compile(
    r"^(?:static\s+)?(?:const\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*\*+\s*|\s+)"
    r"\**\s*([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
KEYWORDS = {"if", "else", "for", "while", "switch", "return", "do", "sizeof", "case"}


def extract_functions(text: str) -> dict:
    """name -> body text. Line-oriented scan: remember the last
    signature-shaped line before an opening `{` at depth 0, then brace-count
    to the matching `}`. Preprocessor alternative signatures (`#if ... static
    void f(...) #else void g(...) #endif {`) resolve to the LAST signature
    seen, which matches the non-registered-callbacks build CubeMX ships."""
    funcs = {}
    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].strip()
        m = SIG_RE.match(line)
        if m and m.group(1) not in KEYWORDS and not line.startswith("#"):
            # A candidate signature: find the opening brace (same line after
            # the closing paren, or a following line). Give up when a `;`
            # ends it first (prototype) or another signature appears.
            name = m.group(1)
            j = i
            depth_paren = 0
            body_start = None
            while j < n:
                s = lines[j]
                if j > i:
                    st = s.strip()
                    if st.startswith("#"):
                        j += 1
                        continue
                    m2 = SIG_RE.match(st)
                    if m2 and m2.group(1) not in KEYWORDS:
                        name = m2.group(1)  # alternative signature wins
                # prototype?
                stripped_j = s.split("//")[0]
                if body_start is None and ";" in stripped_j and "{" not in stripped_j:
                    break
                if "{" in s:
                    body_start = (j, s.index("{"))
                    break
                j += 1
            if body_start is None:
                i += 1
                continue
            # brace-count from body_start
            depth = 0
            body = []
            bj, bcol = body_start
            k = bj
            col = bcol
            done = False
            while k < n and not done:
                s = lines[k]
                start = col if k == bj else 0
                for c in s[start:]:
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                        if depth == 0:
                            done = True
                            break
                body.append(s if k != bj else s[bcol:])
                k += 1
            funcs[name] = "\n".join(body)
            i = k
            continue
        i += 1
    return funcs


STMT_KEEP_RE = re.compile(r"=|[A-Za-z_]\w*\s*\(")
ASSIGN_OR_CALL_RE = re.compile(r"(?<![=!<>])=(?!=)|[A-Za-z_]\w*\s*\(")


GPIO_OR_CHAIN_RE = re.compile(r"GPIO_PIN_\d+(?:\|GPIO_PIN_\d+)+")


def canon_or_chains(stmt: str) -> str:
    """`x|y` is commutative: sort GPIO_PIN OR-chains numerically so the
    reference's ioc-ordered chains compare equal to the kernel's
    bit-ordered ones."""
    return GPIO_OR_CHAIN_RE.sub(
        lambda m: "|".join(
            sorted(m.group(0).split("|"), key=lambda t: int(t.rsplit("_", 1)[1]))
        ),
        stmt,
    )


def body_statements(body: str, table: dict) -> Counter:
    """Split a function body into statements terminated by `;`, `{` or `}`,
    collapse whitespace (incl. around `|`), expand pin macros, and keep
    assignment/call statements (declarations with initializers count; bare
    declarations, labels and control keywords without calls do not)."""
    out = Counter()
    for chunk in re.split(r"[;{}]", body):
        stmt = " ".join(chunk.split())
        stmt = re.sub(r"\s*\|\s*", "|", stmt)
        if not stmt or stmt.startswith("#"):
            continue
        if not ASSIGN_OR_CALL_RE.search(stmt):
            continue
        # pure control-flow with no call inside is irrelevant
        head = stmt.split("(")[0].strip()
        if head in ("for", "while", "switch") and "=" not in stmt:
            continue
        out[canon_or_chains(expand_macros(stmt, table))] += 1
    return out


def normalize_file(path: Path, main_h: Path) -> dict:
    """name -> Counter of normalized statements."""
    text = path.read_text(encoding="utf-8", errors="replace")
    text = strip_comments(strip_user_code(text))
    table = pin_macro_table(main_h)
    return {
        name: body_statements(body, table)
        for name, body in extract_functions(text).items()
    }


DEFINE_RE = re.compile(r"^\s*#define\s+(\w+)\s+(.+?)\s*$", re.MULTILINE)


def define_map(path: Path) -> dict:
    text = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
    out = {}
    for name, val in DEFINE_RE.findall(text):
        out[name] = " ".join(val.split())
    return out


# ---------------------------------------------------------------------------
# Whitelist
# ---------------------------------------------------------------------------


class Rule:
    def __init__(self, file_pat, func_pat, line_pat, reason, lineno):
        self.file_re = re.compile(file_pat)
        self.func_re = re.compile(func_pat)
        self.line_re = re.compile(line_pat)
        self.reason = reason
        self.lineno = lineno
        self.used = False

    def matches(self, file, func, line):
        return (
            self.file_re.fullmatch(file)
            and self.func_re.fullmatch(func)
            and self.line_re.search(line)
        )


def load_whitelist(path: Path):
    """Parse `| file | function | line-pattern | reason |` markdown table
    rows (regex columns; header/separator rows skipped)."""
    rules = []
    if not path.is_file():
        return rules
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 4:
            continue
        if cells[0].lower() in ("file", ":--", "---") or set(cells[0]) <= {"-", ":", " "}:
            continue
        # unescape the markdown-safe pipe spelling used inside regexes
        unesc = lambda s: s.replace("\\|", "|").replace("&#124;", "|")
        file_pat, func_pat, line_pat = (unesc(c) for c in cells[:3])
        rules.append(Rule(file_pat, func_pat, line_pat, cells[3], lineno))
    return rules


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    gen_dir, ref_dir, wl_path = (Path(a) for a in sys.argv[1:4])
    rules = load_whitelist(wl_path)

    gen_src = gen_dir / "Core" / "Src"
    # CubeMX emits Src/+Inc/ at the root for the standalone-Makefile flavour
    # and Core/Src+Core/Inc for the CubeIDE/CMake flavour; accept both so the
    # gate does not go dark when the reference project is regenerated.
    ref_root = ref_dir / "Core" if (ref_dir / "Core" / "Src").is_dir() else ref_dir
    ref_src = ref_root / "Src"
    gen_main_h = gen_dir / "Core" / "Inc" / "main.h"
    ref_main_h = ref_root / "Inc" / "main.h"

    deltas = []  # (file, function, description-line)
    whitelisted = 0

    def check(file, func, line):
        nonlocal whitelisted
        for r in rules:
            if r.matches(file, func, line):
                r.used = True
                whitelisted += 1
                return
        deltas.append((file, func, line))

    compared_files = 0
    compared_funcs = 0
    # The USB Device app files sit next to the rest in the generated tree but
    # under USB_DEVICE/{App,Target} in a CubeIDE-flavour reference; look there
    # too so those four files are diffed rather than silently skipped.
    ref_extra = [ref_dir / "USB_DEVICE" / "App", ref_dir / "USB_DEVICE" / "Target"]

    def find_ref(name):
        for d in [ref_src, *ref_extra]:
            p = d / name
            if p.is_file():
                return p
        return None

    for gen_file in sorted(gen_src.glob("*.c")):
        ref_file = find_ref(gen_file.name)
        if ref_file is None:
            continue  # file-set equality is asserted by the Rust test
        compared_files += 1
        gm = normalize_file(gen_file, gen_main_h)
        rm = normalize_file(ref_file, ref_main_h)
        for name in sorted(set(gm) - set(rm)):
            check(gen_file.name, name, f"FUNCTION_ONLY_IN_GENERATED {name}")
        for name in sorted(set(rm) - set(gm)):
            check(gen_file.name, name, f"FUNCTION_ONLY_IN_REFERENCE {name}")
        for name in sorted(set(gm) & set(rm)):
            compared_funcs += 1
            gc, rc = gm[name], rm[name]
            for stmt, cnt in (gc - rc).items():
                check(gen_file.name, name, f"GEN_ONLY x{cnt}: {stmt}")
            for stmt, cnt in (rc - gc).items():
                check(gen_file.name, name, f"REF_ONLY x{cnt}: {stmt}")

    # FreeRTOSConfig.h macro map
    gen_frc = gen_dir / "Core" / "Inc" / "FreeRTOSConfig.h"
    ref_frc = ref_root / "Inc" / "FreeRTOSConfig.h"
    if gen_frc.is_file() and ref_frc.is_file():
        gd, rd = define_map(gen_frc), define_map(ref_frc)
        for k in sorted(set(gd) - set(rd)):
            check("FreeRTOSConfig.h", "-", f"DEFINE_ONLY_IN_GENERATED {k} = {gd[k]}")
        for k in sorted(set(rd) - set(gd)):
            check("FreeRTOSConfig.h", "-", f"DEFINE_ONLY_IN_REFERENCE {k} = {rd[k]}")
        for k in sorted(set(gd) & set(rd)):
            if gd[k] != rd[k]:
                check("FreeRTOSConfig.h", "-", f"DEFINE_VALUE {k}: GEN {gd[k]} != REF {rd[k]}")

    print(f"compared {compared_files} files / {compared_funcs} common functions")
    print(f"whitelisted deltas: {whitelisted} (rules: {len(rules)})")
    unused = [r for r in rules if not r.used]
    for r in unused:
        print(f"UNUSED WHITELIST ROW (line {r.lineno}): {r.reason}")
    if deltas:
        print(f"\nUNWHITELISTED DELTAS ({len(deltas)}):")
        for file, func, line in deltas:
            print(f"  {file} :: {func} :: {line}")
    ok = not deltas and not unused
    print("\nRESULT:", "OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
