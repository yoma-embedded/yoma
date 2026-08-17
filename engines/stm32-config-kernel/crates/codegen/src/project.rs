//! Project shell assembly (design §9): CMake build description, toolchain
//! file, linker script, and the HAL/CMSIS firmware subset copy.
//!
//! Everything emitted here derives from the resolved model, the IR pack and
//! the config document — no timestamps, no host paths, no invented values.
//! Identical input produces byte-identical output.

use crate::{GenCtx, GeneratedFile};
use anyhow::{anyhow, bail, ensure, Context};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use stm32ck_ir::model::{MemoryKind, MemoryRegion, Part};

// ---------------------------------------------------------------------------
// Device macro / startup file resolution
// ---------------------------------------------------------------------------

/// The device stems a firmware tree actually ships, read out of
/// `CMSIS_Device/Source/Templates/gcc/startup_<stem>.s` (the `Include/<stem>.h`
/// device headers use the same stems). Three shapes exist:
///
/// * flash-bucketed: `stm32f103xb` (suffix `x` + flash size code letter),
/// * catch-all:      `stm32f405xx` / `stm32h743xx`,
/// * pin-keyed:      `stm32f410cx` (suffix pin-count code letter + `x`).
///
/// Discovered rather than tabulated: a family the kernel has never seen needs
/// no code change, and [`device_macro`] fails loudly on a line the tree has
/// no stem for instead of naming a file that isn't there.
pub fn device_stems(dev_gcc: &Path) -> anyhow::Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(dev_gcc)
        .with_context(|| format!("reading {}", dev_gcc.display()))?
    {
        let path = entry?.path();
        if !path.is_file() || path.extension().is_none_or(|x| x != "s") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Some(dev) = stem.strip_prefix("startup_") {
            out.push(dev.to_ascii_lowercase());
        }
    }
    out.sort();
    out.dedup();
    ensure!(
        !out.is_empty(),
        "no startup_*.s files under {}",
        dev_gcc.display()
    );
    Ok(out)
}

/// Flash size in KB encoded by the 11th character of an STM32 sales number
/// (STM32F103C**8**Tx -> 64K).
fn flash_kb_for_size_code(c: char) -> Option<u32> {
    Some(match c.to_ascii_uppercase() {
        '4' => 16,
        '6' => 32,
        '8' => 64,
        'B' => 128,
        'C' => 256,
        'D' => 384,
        'E' => 512,
        'F' => 768,
        'G' => 1024,
        'H' => 1536,
        'I' => 2048,
        _ => return None,
    })
}

/// Map a sales part number to its CMSIS device-selection macro and startup
/// file stem: `("STM32F103C8Tx", .., stems) -> ("STM32F103xB", "startup_stm32f103xb")`.
///
/// Pure and deterministic: buckets the part's flash size (from the size code
/// letter, falling back to the largest `part.flash_kb` variant) into the
/// `stems` available for the product line (see [`device_stems`]). Pin-keyed
/// lines (F410/F412) use the pin-count code letter instead.
pub fn device_macro(
    part: &Part,
    sales_part: &str,
    stems: &[String],
) -> anyhow::Result<(String, String)> {
    let up = sales_part.trim().to_ascii_uppercase();
    ensure!(
        up.starts_with("STM32") && up.len() >= 11,
        "`{sales_part}` is not a recognizable STM32 sales part number"
    );
    let line = &up[..9]; // e.g. "STM32F103"
    let pin_code = up.as_bytes()[9] as char; // pin-count letter, e.g. 'C'
    let size_code = up.as_bytes()[10] as char; // flash-size letter, e.g. '8'
    let flash_kb = flash_kb_for_size_code(size_code)
        .or_else(|| part.flash_kb.iter().copied().max())
        .ok_or_else(|| {
            anyhow!("cannot determine flash size for `{sales_part}` (no size code, no part data)")
        })?;

    // Startup files (unlike the device headers) are tagged with the core they
    // boot on for multi-core lines: STM32WB55 ships one `stm32wb55xx.h` but
    // `startup_stm32wb55xx_cm4.s`. Match on the untagged base, keep the tag
    // for the file name, and when a line ships several cores take the one
    // this part's IR says it has.
    let core = core_token(&part.core);
    let bases: Vec<(&str, &str)> = stems
        .iter()
        .map(|s| (split_core_suffix(s), s.as_str()))
        .filter(|((_, tag), _)| tag.is_none_or(|t| core_token(t) == core))
        .map(|((base, _), full)| (base, full))
        .collect();
    let full_of = |base: &str| -> String {
        bases
            .iter()
            .find(|(b, _)| *b == base)
            .map(|(_, full)| (*full).to_string())
            .unwrap_or_else(|| base.to_string())
    };

    let line_lower = line.to_ascii_lowercase();
    let variants: Vec<&str> = bases
        .iter()
        .map(|(b, _)| *b)
        .filter(|s| s.len() == line_lower.len() + 2 && s.starts_with(line_lower.as_str()))
        .collect();
    if variants.is_empty() {
        // No `<line>??` stem. Newer families key their device headers on a
        // shorter or wider slice of the part number than the 9-character
        // product line: STM32WB05KZVx -> `stm32wb05`, STM32WL33C8Vx ->
        // `stm32wl3xx` (with `x` standing in for the two digits). Match the
        // part against the stems literally, `x` as a wildcard, most-specific
        // (fewest wildcards) first.
        let bare: Vec<String> = bases.iter().map(|(b, _)| b.to_string()).collect();
        let matched = wildcard_stem(&up, &bare).ok_or_else(|| {
            anyhow!(
                "the firmware tree ships no CMSIS device variant for `{sales_part}` \
                 (stems: {})",
                stems.join(", ")
            )
        })?;
        return Ok((
            matched.to_ascii_uppercase(),
            format!("startup_{}", full_of(matched)),
        ));
    }

    let (suffix, macro_suffix) = if variants.iter().any(|s| s.ends_with("xx")) {
        // Catch-all header covers the whole line (STM32F405xx, ...).
        ("xx".to_string(), "xx".to_string())
    } else if variants
        .iter()
        .all(|s| s.as_bytes()[line_lower.len()] == b'x')
    {
        // Flash-bucketed: smallest bucket that holds this part's flash,
        // otherwise the largest available bucket.
        let mut buckets: Vec<(u32, char)> = variants
            .iter()
            .map(|s| {
                let letter = s.as_bytes()[line_lower.len() + 1] as char;
                (flash_kb_for_size_code(letter).unwrap_or(u32::MAX), letter)
            })
            .collect();
        buckets.sort_unstable();
        let (_, letter) = buckets
            .iter()
            .copied()
            .find(|(cap, _)| *cap >= flash_kb)
            .unwrap_or(*buckets.last().expect("non-empty variants"));
        (
            format!("x{letter}"),
            format!("x{}", letter.to_ascii_uppercase()),
        )
    } else {
        // Pin-keyed (F410/F412): suffix is the pin-count code letter + 'x'.
        let want = format!("{}x", pin_code.to_ascii_lowercase());
        ensure!(
            variants.iter().any(|s| s.ends_with(want.as_str())),
            "line {line} has no device variant for pin-count code `{pin_code}` \
             (known: {})",
            variants.join(", ")
        );
        (want, format!("{}x", pin_code.to_ascii_uppercase()))
    };

    Ok((
        format!("{line}{macro_suffix}"),
        format!("startup_{}", full_of(&format!("{line_lower}{suffix}"))),
    ))
}

/// Re-case a device macro to the spelling the family header tests.
///
/// The stem gives the letters, not the case, and ST is not consistent about
/// it: `stm32f103xb` is tested as `STM32F103xB`, `stm32wba52xx` as
/// `STM32WBA52xx`, `stm32wl3xx` as `STM32WL3XX`. Since `#if defined(...)` is
/// case-sensitive, guessing wrong means the header's `#error "Please select
/// first the target device"` fires. The header itself lists every macro it
/// accepts, so ask it; fall back to the caller's spelling when the tree ships
/// no family header (or it names none).
fn recase_device_macro(dev_inc: &Path, prefix: &str, candidate: &str) -> String {
    let Ok(text) = std::fs::read_to_string(dev_inc.join(format!("{prefix}.h"))) else {
        return candidate.to_string();
    };
    let mut rest = text.as_str();
    while let Some(i) = rest.find("defined") {
        rest = &rest[i + "defined".len()..];
        let body = rest.trim_start();
        let Some(body) = body.strip_prefix('(') else {
            continue;
        };
        let Some(end) = body.find(')') else { continue };
        let name = body[..end].trim();
        if name.eq_ignore_ascii_case(candidate) {
            return name.to_string();
        }
    }
    candidate.to_string()
}

/// Whether the selected device has a hardware FPU, from the `__FPU_PRESENT`
/// the CMSIS device header declares.
///
/// The core name alone does not answer this: STM32WLE5 is a Cortex-M4 with
/// `__FPU_PRESENT 0`, and compiling it `-mfloat-abi=hard` makes `core_cm4.h`
/// stop the build with "Compiler generates FPU instructions for a device
/// without an FPU".
fn device_has_fpu(dev_inc: &Path, device_macro: &str) -> Option<bool> {
    let header = dev_inc.join(format!("{}.h", device_macro.to_ascii_lowercase()));
    let text = std::fs::read_to_string(header).ok()?;
    let i = text.find("__FPU_PRESENT")?;
    let value = text[i + "__FPU_PRESENT".len()..]
        .lines()
        .next()?
        .split("/*")
        .next()?
        .trim()
        .trim_end_matches('U')
        .trim();
    Some(value != "0")
}

/// Split a device stem into (base, core tag): `stm32wb55xx_cm4` ->
/// `("stm32wb55xx", Some("cm4"))`, `stm32mp211axx_m33` ->
/// `("stm32mp211axx", Some("m33"))`. Non-core tails are left alone —
/// `stm32n657xx_fsbl` is a boot-stage variant of one device, not a core.
fn split_core_suffix(stem: &str) -> (&str, Option<&str>) {
    let Some(i) = stem.rfind('_') else {
        return (stem, None);
    };
    let tail = &stem[i + 1..];
    let t = tail.strip_prefix('c').unwrap_or(tail);
    let is_core = t
        .strip_prefix('m')
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    if is_core {
        (&stem[..i], Some(tail))
    } else {
        (stem, None)
    }
}

/// Comparable core token from either spelling: `"ARM Cortex-M0+"` and
/// `"cm0plus"` both become `"m0plus"`.
fn core_token(core: &str) -> String {
    let c = core.to_ascii_lowercase().replace(['-', ' ', '+'], "");
    let tail = c.rsplit("cortex").next().unwrap_or(&c);
    let tail = tail.strip_prefix('c').unwrap_or(tail);
    match tail.strip_prefix('m') {
        Some(rest) => {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let plus = core.contains('+') || rest.contains("plus");
            format!("m{digits}{}", if plus { "plus" } else { "" })
        }
        None => tail.to_string(),
    }
}

/// The device stem that matches `sales_part` when `x` is read as a wildcard,
/// preferring the one with the fewest wildcards (so `stm32wl3rx` wins over
/// `stm32wl3xx` for an STM32WL3R part). Ties are impossible: two stems with
/// the same wildcard count that both match would differ in some literal
/// position, and only one of those can equal the part's character there.
fn wildcard_stem<'s>(sales_part_upper: &str, stems: &'s [String]) -> Option<&'s str> {
    let part = sales_part_upper.to_ascii_lowercase();
    let mut best: Option<(usize, &str)> = None;
    for stem in stems {
        if stem.len() > part.len() {
            continue;
        }
        let matches = stem
            .bytes()
            .zip(part.bytes())
            .all(|(s, p)| s == b'x' || s == p);
        if !matches {
            continue;
        }
        let wildcards = stem.bytes().filter(|b| *b == b'x').count();
        if best.is_none_or(|(w, _)| wildcards < w) {
            best = Some((wildcards, stem.as_str()));
        }
    }
    best.map(|(_, s)| s)
}

// ---------------------------------------------------------------------------
// Firmware component layout
// ---------------------------------------------------------------------------

struct FwPaths {
    hal_inc: PathBuf,
    hal_src: PathBuf,
    dev_inc: PathBuf,
    dev_gcc: PathBuf,
    dev_templates: PathBuf,
    core_inc: PathBuf,
}

impl FwPaths {
    fn locate(ctx: &GenCtx<'_>, fw_dir: &Path) -> anyhow::Result<FwPaths> {
        let fam = ctx.pack.family.as_str();
        let root = fw_dir.join(fam);
        ensure!(
            root.is_dir(),
            "firmware components for {fam} not found under {} (expected {fam}/HAL_Driver, \
             {fam}/CMSIS_Device); run tools/fetch-fw.ps1 -Families {fam}",
            fw_dir.display()
        );
        let hal = root.join("HAL_Driver");
        let dev = root.join("CMSIS_Device");
        // CMSIS core is core-generic and identical for every family, so it is
        // shared at the fw root; a per-family copy still wins when present.
        // Its own internal layout differs across snapshots.
        let core_inc = ["CMSIS_Core/Include", "CMSIS_Core/CMSIS/Core/Include"]
            .iter()
            .flat_map(|p| [root.join(p), fw_dir.join(p)])
            .find(|p| p.is_dir())
            .ok_or_else(|| {
                anyhow!(
                    "CMSIS core Include dir not found under {} or {}",
                    root.join("CMSIS_Core").display(),
                    fw_dir.join("CMSIS_Core").display()
                )
            })?;
        let paths = FwPaths {
            hal_inc: hal.join("Inc"),
            hal_src: hal.join("Src"),
            dev_inc: dev.join("Include"),
            dev_gcc: dev.join("Source").join("Templates").join("gcc"),
            dev_templates: dev.join("Source").join("Templates"),
            core_inc,
        };
        for p in [&paths.hal_inc, &paths.hal_src, &paths.dev_inc, &paths.dev_gcc] {
            ensure!(p.is_dir(), "firmware dir missing: {}", p.display());
        }
        Ok(paths)
    }
}

/// The device prefix the landed firmware actually uses, read off the one
/// `<prefix>_hal.c` every ST HAL tree ships (`stm32wb0x_hal.c` -> `stm32wb0x`).
///
/// `<family>xx` holds for 25 of the 27 families but not for STM32WB0
/// (`stm32wb0x`) or STM32WL3 (`stm32wl3x`), and a wrong prefix is not a
/// cosmetic problem: it is the include name, the HAL source names and the
/// `Core/Src/<prefix>_it.c` stem all at once. `None` when the tree is absent
/// (unit tests that never touch disk) — the caller then falls back to the
/// family-derived spelling.
pub fn discover_device_prefix(fw_dir: &Path, family: &str) -> Option<String> {
    let src = fw_dir.join(family).join("HAL_Driver").join("Src");
    let mut found: Vec<String> = std::fs::read_dir(src)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_ascii_lowercase();
            let stem = name.strip_suffix("_hal.c")?;
            stem.starts_with("stm32").then(|| stem.to_string())
        })
        .collect();
    found.sort();
    // Exactly one is expected; more than one means the tree holds two HALs
    // and guessing would be worse than falling back.
    (found.len() == 1).then(|| found.remove(0))
}

/// Read the [`crate::FwFacts`] for one family out of its landed tree.
///
/// `part` / `sales_part` select the device header, which decides which
/// `#if defined(...)` blocks of the RCC headers are live.
pub fn fw_facts(
    fw_dir: &Path,
    family: &str,
    part: &Part,
    sales_part: &str,
) -> Option<crate::FwFacts> {
    let prefix = discover_device_prefix(fw_dir, family)?;
    let inc = fw_dir.join(family).join("HAL_Driver").join("Inc");
    let mut hal_modules: BTreeSet<String> = BTreeSet::new();
    for entry in std::fs::read_dir(&inc).ok()?.filter_map(|e| e.ok()) {
        let Some(name) = entry.file_name().to_str().map(str::to_ascii_lowercase) else {
            continue;
        };
        // `<prefix>_hal_uart.h` -> UART. `_ex` siblings are not modules of
        // their own, and neither are the ll_/legacy headers.
        let Some(rest) = name
            .strip_prefix(&format!("{prefix}_hal_"))
            .and_then(|r| r.strip_suffix(".h"))
        else {
            continue;
        };
        if rest.ends_with("_ex") || rest.contains("template") {
            continue;
        }
        hal_modules.insert(rest.to_ascii_uppercase());
    }
    let src = fw_dir.join(family).join("HAL_Driver").join("Src");
    let dev_inc = fw_dir.join(family).join("CMSIS_Device").join("Include");
    let device_defines = device_header_defines(&dev_inc, &prefix, part, sales_part);
    let mut rcc_header_idents: BTreeSet<String> = BTreeSet::new();
    for h in ["_hal_rcc.h", "_hal_rcc_ex.h"] {
        let Ok(text) = std::fs::read_to_string(inc.join(format!("{prefix}{h}"))) else {
            continue;
        };
        rcc_header_idents.extend(live_identifiers(&text, &device_defines));
    }
    Some(crate::FwFacts {
        hal_conf_values: hal_conf_template_values(&inc, &src, &prefix),
        hal_version: hal_version(&src, &prefix),
        device_prefix: prefix,
        hal_modules,
        rcc_header_idents,
    })
}

/// The HAL driver version from its own `__STM32<F>xx_HAL_VERSION_*` defines.
///
/// `MAIN.SUB1.SUB2`, with `.RC` appended when non-zero — the same shape ST
/// prints. They live in `Src/<prefix>_hal.c` (not the header), as hex
/// literals with a `U`/`UL` suffix.
fn hal_version(src: &Path, prefix: &str) -> Option<String> {
    let text = std::fs::read_to_string(src.join(format!("{prefix}_hal.c"))).ok()?;
    let field = |suffix: &str| -> Option<u32> {
        let key = format!("_HAL_VERSION_{suffix}");
        let i = text.find(&key)? + key.len();
        let rest = text[i..].lines().next()?;
        let tok: String = rest
            .chars()
            .skip_while(|c| !c.is_ascii_alphanumeric())
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        // `(0x0AUL)` / `(0x01U)` / `(1)`
        let tok = tok.trim_end_matches(['U', 'u', 'L', 'l']);
        match tok.strip_prefix("0x").or_else(|| tok.strip_prefix("0X")) {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => tok.parse().ok(),
        }
    };
    let (main, sub1, sub2) = (field("MAIN")?, field("SUB1")?, field("SUB2")?);
    let rc = field("RC").unwrap_or(0);
    Some(if rc == 0 {
        format!("{main}.{sub1}.{sub2}")
    } else {
        format!("{main}.{sub1}.{sub2}.{rc}")
    })
}

/// Everything `#define`d by the CMSIS device header this part selects, plus
/// the device macro itself. Used to decide which `#if defined(...)` blocks of
/// the HAL headers are live.
fn device_header_defines(
    dev_inc: &Path,
    prefix: &str,
    part: &Part,
    sales_part: &str,
) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    let gcc = dev_inc
        .parent()
        .map(|p| p.join("Source").join("Templates").join("gcc"));
    let Some(stems) = gcc.and_then(|g| device_stems(&g).ok()) else {
        return out;
    };
    let Ok((device_macro, _)) = device_macro(part, sales_part, &stems) else {
        return out;
    };
    let device_macro = recase_device_macro(dev_inc, prefix, &device_macro);
    out.insert(device_macro.clone());
    let Ok(text) = std::fs::read_to_string(dev_inc.join(format!(
        "{}.h",
        device_macro.to_ascii_lowercase()
    ))) else {
        return out;
    };
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("#define") {
            if let Some(name) = rest.trim().split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).next() {
                if !name.is_empty() {
                    out.insert(name.to_string());
                }
            }
        }
    }
    out
}

/// Identifiers of `text` that survive its `#if defined(...)` structure given
/// `defines`.
///
/// One level of fidelity is enough for the question asked of it: does this
/// device's HAL declare this struct member? STM32WL ships one
/// `RCC_ClkInitTypeDef` whose `AHBCLK2Divider` sits inside
/// `#if defined(DUAL_CORE)`, so a plain text search would answer yes for the
/// single-core WLE5 and the generated assignment would not compile.
/// Conditions this does not understand are treated as live, which keeps the
/// filter conservative.
fn live_identifiers(text: &str, defines: &BTreeSet<String>) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut stack: Vec<bool> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let directive = |kw: &str| t.strip_prefix(kw).map(str::trim);
        if let Some(rest) = directive("#ifdef") {
            stack.push(defines.contains(first_ident(rest)));
            continue;
        }
        if let Some(rest) = directive("#ifndef") {
            stack.push(!defines.contains(first_ident(rest)));
            continue;
        }
        if let Some(rest) = directive("#if") {
            // Only the two shapes that actually gate ST's struct members.
            let live = match rest.strip_prefix("!defined") {
                Some(arg) => !defines.contains(first_ident(arg)),
                None => match rest.strip_prefix("defined") {
                    Some(arg) => defines.contains(first_ident(arg)),
                    None => true,
                },
            };
            stack.push(live);
            continue;
        }
        if t.starts_with("#elif") {
            if let Some(top) = stack.last_mut() {
                *top = true; // unmodelled alternative: stay conservative
            }
            continue;
        }
        if t.starts_with("#else") {
            if let Some(top) = stack.last_mut() {
                *top = !*top;
            }
            continue;
        }
        if t.starts_with("#endif") {
            stack.pop();
            continue;
        }
        if stack.iter().all(|live| *live) {
            for ident in t.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                if !ident.is_empty() {
                    out.insert(ident.to_string());
                }
            }
        }
    }
    out
}

/// First identifier in `s`, skipping `(`/whitespace.
fn first_ident(s: &str) -> &str {
    let s = s.trim_start_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_'));
    let end = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(s.len());
    &s[..end]
}

/// The `#define`s in ST's `<prefix>_hal_conf_template.h` that some HAL source
/// actually reads, tagged with the module that reads them.
///
/// The template is the full menu, including blocks that only matter with a
/// module enabled (every F1/F4 template carries 40 Ethernet PHY defines).
/// Tagging by referencing module keeps the generated header to what the build
/// needs *and* covers modules beyond the always-compiled core: WB0's
/// `CFG_HW_RCC_HSE_CAPACITOR_TUNE` comes from `hal_rcc.c`, F4's `PHY_READ_TO`
/// from `hal_eth.c` — the latter has no `_VALUE` suffix and no core reader, so
/// any narrower rule drops it and an F4+ETH project does not compile.
fn hal_conf_template_values(
    inc: &Path,
    src: &Path,
    prefix: &str,
) -> BTreeMap<String, crate::HalConfMacro> {
    let Ok(text) = std::fs::read_to_string(inc.join(format!("{prefix}_hal_conf_template.h"))) else {
        return BTreeMap::new();
    };
    // Same always-on set project::hal_sources copies; anything referenced
    // only by these is always needed and carries no module tag.
    const BASE_MODULES: [&str; 12] = [
        "hal", "hal_cortex", "hal_dma", "hal_exti", "hal_flash", "hal_flash_ex",
        "hal_gpio", "hal_gpio_ex", "hal_pwr", "hal_pwr_ex", "hal_rcc", "hal_rcc_ex",
    ];
    // (module tag, source text) for every HAL source this family ships.
    let mut sources: Vec<(Option<String>, String)> = Vec::new();
    for entry in std::fs::read_dir(src).into_iter().flatten().flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_ascii_lowercase) else {
            continue;
        };
        let Some(stem) = name
            .strip_prefix(&format!("{prefix}_"))
            .and_then(|r| r.strip_suffix(".c"))
        else {
            continue;
        };
        let Ok(body) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let tag = if BASE_MODULES.contains(&stem) {
            None
        } else {
            // `hal_eth_ex` -> ETH: the `_ex` sibling rides with its module.
            Some(
                stem.trim_start_matches("hal_")
                    .trim_end_matches("_ex")
                    .to_ascii_uppercase(),
            )
        };
        sources.push((tag, body));
    }

    let mut out: BTreeMap<String, crate::HalConfMacro> = BTreeMap::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("#define") else {
            continue;
        };
        let mut it = rest.trim().splitn(2, char::is_whitespace);
        let (Some(name), Some(value)) = (it.next(), it.next()) else {
            continue;
        };
        // Module switches and assert plumbing are emitted from the resolved
        // model, not copied.
        if name.starts_with("HAL_") || name.starts_with("USE_") || name.starts_with("__")
            || name.contains('(')
        {
            continue;
        }
        let mut modules: BTreeSet<String> = BTreeSet::new();
        let mut needed_by_core = false;
        for (tag, body) in &sources {
            if !body.contains(name) {
                continue;
            }
            match tag {
                None => needed_by_core = true,
                Some(m) => {
                    modules.insert(m.clone());
                }
            }
        }
        if !needed_by_core && modules.is_empty() {
            continue;
        }
        if needed_by_core {
            modules.clear(); // unconditional
        }
        // Keep the value token only. ST's trailing doc comments are often
        // multi-line (L4's HSI48_VALUE), and re-emitting an unterminated
        // `/*` would comment out the rest of the generated header.
        let value = value
            .split("/*")
            .next()
            .and_then(|v| v.split("//").next())
            .unwrap_or(value)
            .trim();
        if value.is_empty() {
            continue;
        }
        // The template guards each define with `#if !defined(X)` and often
        // offers two alternatives (F1 lists a 25 MHz and an 8 MHz HSE); the
        // first is ST's own default.
        out.entry(name.to_string())
            .or_insert_with(|| crate::HalConfMacro {
                value: value.to_string(),
                modules,
            });
    }
    out
}

/// Lowercased device header prefix: "stm32f1xx", "stm32wb0x".
fn family_lower(ctx: &GenCtx<'_>) -> String {
    ctx.device_prefix()
}

/// HAL driver directory name under Drivers/: "STM32F1xx_HAL_Driver".
fn hal_dir_name(ctx: &GenCtx<'_>) -> String {
    format!("{}_HAL_Driver", ctx.device_prefix_dir())
}

/// The subset of HAL `Src/*.c` this project needs: the always-on core set
/// plus one module per enabled peripheral (via [`crate::hal_module`] — the
/// same derivation hal_conf.h uses, so enable macros, includes, copied
/// sources and CMake sources always agree; `_ex` sibling included when
/// present). Sorted, deduplicated, existence-filtered against the firmware
/// tree.
fn hal_sources(ctx: &GenCtx<'_>, hal_src: &Path) -> anyhow::Result<Vec<String>> {
    let fam = family_lower(ctx);
    let mut picked: BTreeSet<String> = BTreeSet::new();
    let pick = |name: String, picked: &mut BTreeSet<String>| {
        if hal_src.join(&name).is_file() {
            picked.insert(name);
        }
    };
    const BASE_MODULES: [&str; 12] = [
        "hal", "hal_cortex", "hal_dma", "hal_exti", "hal_flash", "hal_flash_ex",
        "hal_gpio", "hal_gpio_ex", "hal_pwr", "hal_pwr_ex", "hal_rcc", "hal_rcc_ex",
    ];
    for m in BASE_MODULES {
        pick(format!("{fam}_{m}.c"), &mut picked);
    }
    ensure!(
        picked.contains(&format!("{fam}_hal.c")),
        "HAL core source {fam}_hal.c missing under {}",
        hal_src.display()
    );
    // The TIM timebase needs the TIM HAL sources even with no user TIM.
    if ctx.resolved.timebase.is_some() {
        pick(format!("{fam}_hal_tim.c"), &mut picked);
        pick(format!("{fam}_hal_tim_ex.c"), &mut picked);
    }
    for p in &ctx.resolved.periphs {
        let Some(m) = crate::hal_module(p) else { continue };
        let module = m.to_ascii_lowercase();
        pick(format!("{fam}_hal_{module}.c"), &mut picked);
        pick(format!("{fam}_hal_{module}_ex.c"), &mut picked);
        // Companion low-layer sources some HAL modules link against
        // (CubeMX copies these alongside): PCD/HCD call USB_* from ll_usb,
        // SD/MMC call SDMMC_* from ll_sdmmc, FMC/FSMC memories likewise.
        let lls: &[&str] = match module.as_str() {
            "pcd" | "hcd" => &["ll_usb"],
            "sd" | "mmc" => &["ll_sdmmc"],
            "nand" | "nor" | "sram" | "sdram" | "pccard" => &["ll_fmc", "ll_fsmc"],
            _ => &[],
        };
        for ll in lls {
            pick(format!("{fam}_{ll}.c"), &mut picked);
        }
    }
    Ok(picked.into_iter().collect())
}

/// Per-core compiler/linker machine flags. Not HAL data — fixed GCC target
/// options selected by the part's core string from the IR. Matched
/// longest-token-first: "m33" has to be tested before "m3", "m0+" before
/// "m0". Cortex-A cores (MP1/MP2 application processors) are rejected — this
/// project shell targets bare-metal Cortex-M only.
/// `has_fpu` overrides the core's usual answer when the device header says
/// otherwise (see [`device_has_fpu`]); `None` keeps the core default.
fn core_flags(core: &str, has_fpu: Option<bool>) -> anyhow::Result<String> {
    let c = core.to_ascii_lowercase();
    const TABLE: &[(&[&str], &str, &str)] = &[
        (&["m0+", "m0plus"], "cortex-m0plus", ""),
        (&["m33"], "cortex-m33", "fpv5-sp-d16"),
        (&["m55"], "cortex-m55", "fpv5-d16"),
        (&["m0"], "cortex-m0", ""),
        (&["m3"], "cortex-m3", ""),
        (&["m4"], "cortex-m4", "fpv4-sp-d16"),
        (&["m7"], "cortex-m7", "fpv5-d16"),
    ];
    for (tokens, cpu, fpu) in TABLE {
        if !tokens.iter().any(|t| c.contains(t)) {
            continue;
        }
        let use_fpu = has_fpu.unwrap_or(!fpu.is_empty()) && !fpu.is_empty();
        return Ok(if use_fpu {
            format!("-mcpu={cpu} -mfpu={fpu} -mfloat-abi=hard")
        } else {
            format!("-mcpu={cpu} -mfloat-abi=soft")
        });
    }
    bail!("unknown core `{core}`: cannot derive target compiler flags")
}

/// Provenance line for the project-shell files.
///
/// Carries the HAL driver version as well: the generated tree is a function
/// of the firmware package too, so without it "same input -> byte-identical
/// output" cannot be checked across a firmware upgrade. (The C sources use
/// `emit::header`, which stays byte-comparable with CubeMX's own header.)
fn banner(ctx: &GenCtx<'_>) -> String {
    let hal = ctx
        .fw
        .as_ref()
        .and_then(|f| f.hal_version.as_deref())
        .map(|v| format!(", HAL {v}"))
        .unwrap_or_default();
    format!(
        "Generated by stm32kernel {} — IR pack {} (CubeMX db {}{hal})",
        ctx.kernel_version, ctx.pack.family, ctx.pack.db_version
    )
}

// ---------------------------------------------------------------------------
// assemble(): CMakeLists.txt + toolchain file + linker script
// ---------------------------------------------------------------------------

/// `(device macro, startup stem)` for this part against a landed firmware
/// tree: [`device_macro`] picks the variant, [`recase_device_macro`] adopts
/// the family header's own spelling of it.
fn resolve_device(ctx: &GenCtx<'_>, fw: &FwPaths) -> anyhow::Result<(String, String)> {
    let (dev_macro, startup_stem) = device_macro(
        ctx.resolved.part,
        &ctx.doc.mcu.part,
        &device_stems(&fw.dev_gcc)?,
    )?;
    Ok((
        recase_device_macro(&fw.dev_inc, &ctx.device_prefix(), &dev_macro),
        startup_stem,
    ))
}

/// Generate the project shell text files. The source lists and copy layout
/// reference exactly what [`copy_firmware`] places on disk plus the C files
/// emitted by `emit::emit_all` (design §9 contract: `Core/Src/{main,gpio,
/// <fam>_hal_msp,<fam>_it}.c`).
pub fn assemble(ctx: &GenCtx<'_>, fw_dir: &Path) -> anyhow::Result<Vec<GeneratedFile>> {
    let fw = FwPaths::locate(ctx, fw_dir)?;
    let (dev_macro, startup_stem) = resolve_device(ctx, &fw)?;
    let startup_src = fw.dev_gcc.join(format!("{startup_stem}.s"));
    ensure!(
        startup_src.is_file(),
        "startup file {startup_stem}.s not present under {}",
        fw.dev_gcc.display()
    );
    let startup = std::fs::read_to_string(&startup_src)
        .with_context(|| format!("reading {}", startup_src.display()))?;
    let hal_srcs = hal_sources(ctx, &fw.hal_src)?;
    let ld_name = format!("{}_FLASH.ld", ctx.doc.mcu.part.trim());
    let legacy_inc = fw.hal_inc.join("Legacy").is_dir();
    let system_src = system_source(&fw.dev_templates, &family_lower(ctx))?;

    Ok(vec![
        GeneratedFile {
            rel_path: "CMakeLists.txt".to_string(),
            content: cmakelists(
                ctx,
                &dev_macro,
                &startup_stem,
                &hal_srcs,
                &ld_name,
                legacy_inc,
                &system_src,
                device_has_fpu(&fw.dev_inc, &dev_macro),
            )?,
        },
        GeneratedFile {
            rel_path: "cmake/gcc-arm-none-eabi.cmake".to_string(),
            content: toolchain_cmake(ctx),
        },
        GeneratedFile {
            rel_path: "CMakePresets.json".to_string(),
            content: CMAKE_PRESETS.to_string(),
        },
        GeneratedFile {
            rel_path: ld_name,
            // The script must define exactly the symbols this startup file
            // imports. ST's newer startups (H5, U5, WBA) add `_sstack` and
            // WB's adds a `.MB_MEM2` trio; the F1/F4-era ones do neither, so
            // asking the file is both correct and keeps their output
            // unchanged.
            content: linker_script(ctx, &startup)?,
        },
    ])
}

/// Static CMakePresets.json (middleware-gen-spec §5): project-independent,
/// Ninja generator, Debug/Release configure+build presets over the
/// arm-none-eabi toolchain file.
const CMAKE_PRESETS: &str = r#"{
    "version": 3,
    "configurePresets": [
        {
            "name": "default",
            "hidden": true,
            "generator": "Ninja",
            "binaryDir": "${sourceDir}/build/${presetName}",
            "toolchainFile": "${sourceDir}/cmake/gcc-arm-none-eabi.cmake",
            "cacheVariables": {
            }
        },
        {
            "name": "Debug",
            "inherits": "default",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "Debug"
            }
        },
        {
            "name": "Release",
            "inherits": "default",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "Release"
            }
        }
    ],
    "buildPresets": [
        {
            "name": "Debug",
            "configurePreset": "Debug"
        },
        {
            "name": "Release",
            "configurePreset": "Release"
        }
    ]
}
"#;

#[allow(clippy::too_many_arguments)]
fn cmakelists(
    ctx: &GenCtx<'_>,
    dev_macro: &str,
    startup_stem: &str,
    hal_srcs: &[String],
    ld_name: &str,
    legacy_inc: bool,
    system_src: &str,
    has_fpu: Option<bool>,
) -> anyhow::Result<String> {
    let fam_lower = family_lower(ctx);
    let hal_dir = hal_dir_name(ctx);
    let flags = core_flags(&ctx.resolved.part.core, has_fpu)?;

    let mw = crate::middleware::cmake_additions(ctx);
    let mut sources: Vec<String> = vec![
        "Core/Src/main.c".to_string(),
        "Core/Src/gpio.c".to_string(),
    ];
    // Per-peripheral family files (same stems the emitter produces);
    // middleware-owned instances (P7: USB_OTG_FS) have no family file.
    let owned = crate::middleware::owned_instances(ctx);
    let stems: BTreeSet<String> = ctx
        .resolved
        .periphs
        .iter()
        .filter(|p| !owned.contains(&p.instance))
        .map(|p| crate::file_stem(p))
        .collect();
    for stem in &stems {
        sources.push(format!("Core/Src/{stem}.c"));
    }
    if !ctx.resolved.dma.is_empty() {
        sources.push("Core/Src/dma.c".to_string());
    }
    sources.push(format!("Core/Src/{fam_lower}_hal_msp.c"));
    sources.push(format!("Core/Src/{fam_lower}_it.c"));
    if ctx.resolved.timebase.is_some() {
        sources.push(format!("Core/Src/{fam_lower}_hal_timebase_tim.c"));
    }
    sources.push("Core/Src/sysmem.c".to_string());
    sources.push("Core/Src/syscalls.c".to_string());
    sources.push(format!("Core/Src/{system_src}"));
    sources.push(format!("Core/Startup/{startup_stem}.s"));
    sources.extend(mw.sources.iter().cloned());
    sources.extend(hal_srcs.iter().map(|f| format!("Drivers/{hal_dir}/Src/{f}")));
    let sources_block = sources
        .iter()
        .map(|s| format!("    {s}"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut includes: Vec<String> = vec![
        "Core/Inc".to_string(),
        format!("Drivers/{hal_dir}/Inc"),
    ];
    if legacy_inc {
        includes.push(format!("Drivers/{hal_dir}/Inc/Legacy"));
    }
    includes.push(format!(
        "Drivers/CMSIS/Device/ST/{}/Include",
        ctx.device_prefix_dir()
    ));
    includes.push("Drivers/CMSIS/Include".to_string());
    includes.extend(mw.includes.iter().cloned());
    let includes_block = includes
        .iter()
        .map(|s| format!("    {s}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut defines_block = String::new();
    for d in &mw.defines {
        defines_block.push_str(&format!("    {d}\n"));
    }

    const TEMPLATE: &str = r#"cmake_minimum_required(VERSION 3.22)

# @BANNER@
# MCU: @PART@  device: @DEVICE@  core: @CORE@

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Debug")
endif()

if(NOT DEFINED CMAKE_TOOLCHAIN_FILE)
    set(CMAKE_TOOLCHAIN_FILE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/gcc-arm-none-eabi.cmake")
endif()

project(@PROJECT@ C ASM)

# Target machine flags for the @CORE@ core.
set(TARGET_FLAGS "@TARGET_FLAGS@")

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${TARGET_FLAGS} -Wall -ffunction-sections -fdata-sections --specs=nano.specs")
set(CMAKE_ASM_FLAGS "${CMAKE_C_FLAGS} -x assembler-with-cpp -MMD -MP")
set(CMAKE_C_FLAGS_DEBUG "-O0 -g3")
set(CMAKE_C_FLAGS_RELEASE "-Os -g0")

set(LINKER_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/@LD@")
# nano.specs is already in CMAKE_C_FLAGS (which CMake also passes to the link
# line); repeating it here makes GCC >= 15 abort the link with "attempt to
# rename spec 'link' to already defined spec 'nano_link'".
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ${TARGET_FLAGS} -T \"${LINKER_SCRIPT}\" --specs=nosys.specs -Wl,--gc-sections -Wl,-Map=${CMAKE_PROJECT_NAME}.map,--cref")

add_executable(${CMAKE_PROJECT_NAME}
@SOURCES@
)

set_target_properties(${CMAKE_PROJECT_NAME} PROPERTIES LINK_DEPENDS "${LINKER_SCRIPT}")

target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    USE_HAL_DRIVER
    @DEVICE@
@MW_DEFINES@)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
@INCLUDES@
)

# Convert the ELF into flashable images.
add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:${CMAKE_PROJECT_NAME}> ${CMAKE_PROJECT_NAME}.hex
    COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${CMAKE_PROJECT_NAME}> ${CMAKE_PROJECT_NAME}.bin
)
"#;

    Ok(TEMPLATE
        .replace("@BANNER@", &banner(ctx))
        .replace("@PART@", ctx.doc.mcu.part.trim())
        .replace("@DEVICE@", dev_macro)
        .replace("@CORE@", &ctx.resolved.part.core)
        .replace("@PROJECT@", &ctx.doc.project.name)
        .replace("@TARGET_FLAGS@", &flags)
        .replace("@LD@", ld_name)
        .replace("@SOURCES@", &sources_block)
        .replace("@INCLUDES@", &includes_block)
        .replace("@MW_DEFINES@", &defines_block))
}

fn toolchain_cmake(ctx: &GenCtx<'_>) -> String {
    const TEMPLATE: &str = r#"# @BANNER@
# arm-none-eabi cross toolchain description.

set(CMAKE_SYSTEM_NAME               Generic)
set(CMAKE_SYSTEM_PROCESSOR          arm)

set(CMAKE_C_COMPILER                arm-none-eabi-gcc)
set(CMAKE_ASM_COMPILER              arm-none-eabi-gcc)
set(CMAKE_CXX_COMPILER              arm-none-eabi-g++)
set(CMAKE_OBJCOPY                   arm-none-eabi-objcopy)
set(CMAKE_SIZE                      arm-none-eabi-size)

set(CMAKE_EXECUTABLE_SUFFIX_ASM     ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_C       ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_CXX     ".elf")

set(CMAKE_TRY_COMPILE_TARGET_TYPE   STATIC_LIBRARY)

# Never pick up host libraries/headers.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
"#;
    TEMPLATE.replace("@BANNER@", &banner(ctx))
}

/// Addresses at which a region counts as general-purpose system RAM: the
/// SRAM aperture. Excludes the TCMs aliased at 0x00000000 (a stack there
/// would work but no CubeMX layout does it) and everything from the
/// peripheral aperture up, which is where backup SRAM lives.
const SYSTEM_RAM_RANGE: std::ops::Range<u64> = 0x2000_0000..0x4000_0000;

/// GNU ld size literal: `65536` -> `64K`, `1024*1024` -> `1024K`, anything
/// not a whole number of KB stays in bytes.
fn ld_size(bytes: u64) -> String {
    if bytes.is_multiple_of(1024) {
        format!("{}K", bytes / 1024)
    } else {
        format!("{bytes}")
    }
}

/// The `MEMORY { ... }` body for a part, plus what the header comment should
/// say about it.
struct MemoryBlock {
    lines: String,
    /// Size of the region the SECTIONS body calls `RAM`, in KB.
    primary_ram_kb: u64,
    /// Size of the region the SECTIONS body calls `FLASH`, in KB.
    flash_kb: u64,
    note: String,
}

/// Build the MEMORY block from the db's address map for this part.
///
/// `None` means the db ships no map (every F1/F4-era part), and the caller
/// falls back to the historical single `RAM @ 0x20000000` layout.
///
/// The region the SECTIONS body links against is named `RAM` regardless of
/// what the datasheet calls it, so the rest of the script is family-agnostic;
/// the remaining banks are declared under their db names, available for user
/// placement. Primary RAM = the largest bank inside [`SYSTEM_RAM_RANGE`],
/// lowest address winning a tie. On an H743 that is the 512K AXI SRAM at
/// 0x24000000 — the same bank CubeMX links to as `RAM_D1`, and emphatically
/// not the 128K of DTCM that shares 0x20000000 with nothing else.
/// The `CCMRAM` MEMORY line for parts whose address map the db does not ship.
///
/// `<CCMRam>` is the only place the pre-rzone families declare their
/// core-coupled RAM, and it is counted outside `<Ram>` — without this an
/// STM32F407 project simply cannot reach its 64K of zero-wait-state memory.
///
/// The size is device data; the *address* is architectural and the db has it
/// nowhere, so it comes from the core: Cortex-M4's CCM sits at 0x10000000.
/// Cortex-M7 parts label their DTCM `<CCMRam>` too, but that lives at
/// 0x20000000 — the same base this fallback already gives `RAM` — so
/// declaring it would need the primary region moved as well; those families
/// are left to the rzone path, and F7 (which has neither) gets nothing.
fn ccm_region(ctx: &GenCtx<'_>) -> String {
    let Some(kb) = ctx.resolved.part.ccm_ram_kb.filter(|kb| *kb > 0) else {
        return String::new();
    };
    if core_token(&ctx.resolved.part.core) != "m4" {
        return String::new();
    }
    format!("  CCMRAM (xrw) : ORIGIN = 0x10000000, LENGTH = {kb}K\n")
}

fn memory_block(ctx: &GenCtx<'_>, flash_kb_declared: u32) -> Option<MemoryBlock> {
    let id = ctx.resolved.part.memory_maps.get(&flash_kb_declared)?;
    let regions = ctx.pack.memory_maps.get(id)?;

    let flash = regions
        .iter()
        .find(|r| r.kind == MemoryKind::Rom && r.start == 0x0800_0000)?;
    let rams: Vec<&MemoryRegion> =
        regions.iter().filter(|r| r.kind == MemoryKind::Ram).collect();
    let primary = *rams
        .iter()
        .filter(|r| SYSTEM_RAM_RANGE.contains(&r.start))
        .max_by_key(|r| (r.size_bytes, std::cmp::Reverse(r.start)))?;

    // Remaining banks, low address first, so a user can place sections in
    // them without hand-editing the MEMORY command.
    let extra: Vec<&&MemoryRegion> =
        rams.iter().filter(|r| r.start != primary.start).collect();
    let width = extra
        .iter()
        .map(|r| r.name.len())
        .chain(["FLASH".len()])
        .max()
        .unwrap_or(5);
    let mut lines = String::new();
    lines.push_str(&format!(
        "  {:<width$} (xrw) : ORIGIN = {:#010x}, LENGTH = {}   /* {} */\n",
        "RAM",
        primary.start,
        ld_size(primary.size_bytes),
        primary.name,
    ));
    lines.push_str(&format!(
        "  {:<width$} (rx)  : ORIGIN = {:#010x}, LENGTH = {}\n",
        "FLASH",
        flash.start,
        ld_size(flash.size_bytes),
    ));
    for r in extra {
        lines.push_str(&format!(
            "  {:<width$} (xrw) : ORIGIN = {:#010x}, LENGTH = {}\n",
            r.name,
            r.start,
            ld_size(r.size_bytes),
        ));
    }

    let mut note = format!("\n** Address map: db/mcu/memory/{id}.xml");
    if flash.size_bytes != u64::from(flash_kb_declared) * 1024 {
        note.push_str(&format!(
            "\n** NOTE: the address map gives {} of flash at {:#010x}, the part data \
             {flash_kb_declared}K; using the address map.",
            ld_size(flash.size_bytes),
            flash.start,
        ));
    }
    Some(MemoryBlock {
        lines,
        primary_ram_kb: primary.size_bytes / 1024,
        flash_kb: flash.size_bytes / 1024,
        note,
    })
}

/// Output sections for the `_s<N>` / `_e<N>` / `_si<N>` symbol trios a
/// startup file initializes beyond `.data` and `.bss`.
///
/// STM32WB's Cortex-M4 startup unconditionally initializes `.MB_MEM2`, the
/// IPCC mailbox the radio co-processor shares; without a matching section the
/// link fails on `undefined reference to '_sMB_MEM2'`. Emitting the section
/// keeps the "define exactly what the startup imports" contract. The section
/// is empty in a project with no WPAN middleware, so plain RAM placement is
/// correct for it — a project that adds the BLE stack needs ST's shared-SRAM
/// layout instead (README, known gaps).
fn startup_extra_sections(startup: &str) -> String {
    // `_s<N>` occurrences whose `_e<N>` partner also appears. `data`, `bss`
    // and `stack` are the template's own and are already defined.
    let mut names: Vec<&str> = Vec::new();
    let mut rest = startup;
    while let Some(i) = rest.find("_s") {
        rest = &rest[i + 2..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let name = &rest[..end];
        if matches!(name, "" | "data" | "bss" | "stack" | "idata") || names.contains(&name) {
            continue;
        }
        if startup.contains(&format!("_e{name}")) {
            names.push(name);
        }
    }
    names.sort_unstable();
    let mut out = String::new();
    for name in names {
        // A `_si<N>` load address means the startup copies the section out of
        // flash; without one it just zeroes it in place.
        if startup.contains(&format!("_si{name}")) {
            out.push_str(&format!(
                "\n  /* Initialized section the startup file copies out of FLASH */\n\
                 \x20 .{name} :\n\
                 \x20 {{\n\
                 \x20   . = ALIGN(4);\n\
                 \x20   _s{name} = .;\n\
                 \x20   *({name})\n\
                 \x20   *(.{name})\n\
                 \x20   . = ALIGN(4);\n\
                 \x20   _e{name} = .;\n\
                 \x20 }} >RAM AT> FLASH\n\
                 \x20 _si{name} = LOADADDR(.{name});\n"
            ));
        } else {
            out.push_str(&format!(
                "\n  /* Zero-initialized section the startup file clears */\n\
                 \x20 .{name} (NOLOAD) :\n\
                 \x20 {{\n\
                 \x20   . = ALIGN(4);\n\
                 \x20   _s{name} = .;\n\
                 \x20   *({name})\n\
                 \x20   *(.{name})\n\
                 \x20   . = ALIGN(4);\n\
                 \x20   _e{name} = .;\n\
                 \x20 }} >RAM\n"
            ));
        }
    }
    out
}

fn linker_script(ctx: &GenCtx<'_>, startup: &str) -> anyhow::Result<String> {
    let needs_sstack = startup.contains("_sstack");
    let extra_sections = startup_extra_sections(startup);
    let part = ctx.resolved.part;
    let sales = ctx.doc.mcu.part.trim().to_string();
    let first = *part
        .flash_kb
        .first()
        .ok_or_else(|| anyhow!("part {} has no flash size data", part.ref_name))?;
    let wanted = sales
        .to_ascii_uppercase()
        .as_bytes()
        .get(10)
        .and_then(|b| flash_kb_for_size_code(*b as char));
    let (flash_kb, note) = match wanted {
        Some(kb) if part.flash_kb.contains(&kb) => (kb, String::new()),
        Some(kb) => (
            first,
            format!(
                "\n** NOTE: size code of {sales} implies {kb}K flash, absent from part \
                 data {:?}; using first variant ({first}K).",
                part.flash_kb
            ),
        ),
        None => (
            first,
            format!("\n** NOTE: no flash size code parsed from `{sales}`; using first variant ({first}K)."),
        ),
    };
    let ram_kb = *part
        .ram_kb
        .first()
        .ok_or_else(|| anyhow!("part {} has no RAM size data", part.ref_name))?;

    // Prefer the db's address map. Without it, `ram_kb` is the SUM of every
    // bank, which is only a usable LENGTH when the part has exactly one —
    // true for F1/F4, false for anything with a TCM or a second AHB domain.
    let (memory_lines, ram_kb, flash_kb, note) = match memory_block(ctx, flash_kb) {
        Some(mb) => (mb.lines, mb.primary_ram_kb, mb.flash_kb, note + &mb.note),
        None => (
            {
                // Widen the name column only when there is a third region, so
                // parts without core-coupled RAM keep their existing layout.
                let ccm = ccm_region(ctx);
                let w = if ccm.is_empty() { 5 } else { 6 };
                format!(
                    "  {:<w$} (xrw) : ORIGIN = 0x20000000, LENGTH = {ram_kb}K\n\
                     \x20 {:<w$} (rx)  : ORIGIN = 0x08000000, LENGTH = {flash_kb}K\n{ccm}",
                    "RAM", "FLASH",
                )
            },
            u64::from(ram_kb),
            u64::from(flash_kb),
            note,
        ),
    };

    const TEMPLATE: &str = r#"/*
******************************************************************************
** @BANNER@
**
** Linker script for @PART@ (@FLASH_KB@K flash, @RAM_KB@K RAM).
** Sets memory regions, stack top, and minimum heap/stack sizes.@NOTE@
******************************************************************************
*/

/* Entry Point */
ENTRY(Reset_Handler)

/* Highest address of the user mode stack */
_estack = ORIGIN(RAM) + LENGTH(RAM);
@SSTACK@
_Min_Heap_Size = @HEAP@;  /* required amount of heap */
_Min_Stack_Size = @STACK@; /* required amount of stack */

/* Memories definition */
MEMORY
{
@MEMORY@}

/* Sections */
SECTIONS
{
  /* The startup code into "FLASH" Rom type memory */
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector)) /* Startup code */
    . = ALIGN(4);
  } >FLASH

  /* The program code and other data into "FLASH" Rom type memory */
  .text :
  {
    . = ALIGN(4);
    *(.text)           /* .text sections (code) */
    *(.text*)          /* .text* sections (code) */
    *(.glue_7)         /* glue arm to thumb code */
    *(.glue_7t)        /* glue thumb to arm code */
    *(.eh_frame)

    KEEP (*(.init))
    KEEP (*(.fini))

    . = ALIGN(4);
    _etext = .;        /* define a global symbols at end of code */
  } >FLASH

  /* Constant data into "FLASH" Rom type memory */
  .rodata :
  {
    . = ALIGN(4);
    *(.rodata)         /* .rodata sections (constants, strings, etc.) */
    *(.rodata*)        /* .rodata* sections (constants, strings, etc.) */
    . = ALIGN(4);
  } >FLASH

  /* The READONLY keyword needs GCC 11 or later; drop it for older tools. */
  .ARM.extab (READONLY) :
  {
    . = ALIGN(4);
    *(.ARM.extab* .gnu.linkonce.armextab.*)
    . = ALIGN(4);
  } >FLASH

  .ARM (READONLY) :
  {
    . = ALIGN(4);
    __exidx_start = .;
    *(.ARM.exidx*)
    __exidx_end = .;
    . = ALIGN(4);
  } >FLASH

  .preinit_array (READONLY) :
  {
    . = ALIGN(4);
    PROVIDE_HIDDEN (__preinit_array_start = .);
    KEEP (*(.preinit_array*))
    PROVIDE_HIDDEN (__preinit_array_end = .);
    . = ALIGN(4);
  } >FLASH

  .init_array (READONLY) :
  {
    . = ALIGN(4);
    PROVIDE_HIDDEN (__init_array_start = .);
    KEEP (*(SORT(.init_array.*)))
    KEEP (*(.init_array*))
    PROVIDE_HIDDEN (__init_array_end = .);
    . = ALIGN(4);
  } >FLASH

  .fini_array (READONLY) :
  {
    . = ALIGN(4);
    PROVIDE_HIDDEN (__fini_array_start = .);
    KEEP (*(SORT(.fini_array.*)))
    KEEP (*(.fini_array*))
    PROVIDE_HIDDEN (__fini_array_end = .);
    . = ALIGN(4);
  } >FLASH

  /* Used by the startup to initialize data */
  _sidata = LOADADDR(.data);

  /* Initialized data sections into "RAM" Ram type memory */
  .data :
  {
    . = ALIGN(4);
    _sdata = .;        /* create a global symbol at data start */
    *(.data)           /* .data sections */
    *(.data*)          /* .data* sections */
    *(.RamFunc)        /* .RamFunc sections */
    *(.RamFunc*)       /* .RamFunc* sections */

    . = ALIGN(4);
    _edata = .;        /* define a global symbol at data end */
  } >RAM AT> FLASH

  /* Uninitialized data section into "RAM" Ram type memory */
  . = ALIGN(4);
  .bss :
  {
    /* This is used by the startup in order to initialize the .bss section */
    _sbss = .;         /* define a global symbol at bss start */
    __bss_start__ = _sbss;
    *(.bss)
    *(.bss*)
    *(COMMON)

    . = ALIGN(4);
    _ebss = .;         /* define a global symbol at bss end */
    __bss_end__ = _ebss;
  } >RAM

  /* User_heap_stack section, used to check that there is enough "RAM" left */
  ._user_heap_stack :
  {
    . = ALIGN(8);
    PROVIDE ( end = . );
    PROVIDE ( _end = . );
    . = . + _Min_Heap_Size;
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
  } >RAM

@EXTRA_SECTIONS@
  /* Remove information from the compiler libraries */
  /DISCARD/ :
  {
    libc.a ( * )
    libm.a ( * )
    libgcc.a ( * )
  }

  .ARM.attributes 0 : { *(.ARM.attributes) }
}
"#;

    Ok(TEMPLATE
        .replace("@BANNER@", &banner(ctx))
        .replace("@PART@", &sales)
        .replace("@MEMORY@", &memory_lines)
        .replace(
            "@SSTACK@",
            if needs_sstack {
                "_sstack = _estack - _Min_Stack_Size;\n"
            } else {
                ""
            },
        )
        .replace("@EXTRA_SECTIONS@", &extra_sections)
        .replace("@FLASH_KB@", &flash_kb.to_string())
        .replace("@RAM_KB@", &ram_kb.to_string())
        .replace("@HEAP@", ctx.doc.project.min_heap_size.trim())
        .replace("@STACK@", ctx.doc.project.min_stack_size.trim())
        .replace("@NOTE@", &note))
}

// ---------------------------------------------------------------------------
// copy_firmware(): HAL/CMSIS/startup subset into the project tree
// ---------------------------------------------------------------------------

/// Copy the firmware subset into `out_dir` and return the sorted `/`-separated
/// relative paths of every file copied:
///
/// * `Drivers/<fam>xx_HAL_Driver/Inc/**.h` (all headers; simpler + harmless),
/// * `Drivers/<fam>xx_HAL_Driver/Src/<needed>.c` (see [`hal_sources`]),
/// * `Drivers/CMSIS/Device/ST/<fam>xx/Include/*.h`,
/// * `Drivers/CMSIS/Include/*.h` (+ `m-profile/` when the cmsis_core snapshot
///   splits profile headers out),
/// * `Core/Startup/<startup>.s` (exactly one),
/// * `Core/Src/system_<fam>xx.c`.
pub fn copy_firmware(
    ctx: &GenCtx<'_>,
    fw_dir: &Path,
    out_dir: &Path,
) -> anyhow::Result<Vec<String>> {
    let fw = FwPaths::locate(ctx, fw_dir)?;
    let fam_lower = family_lower(ctx);
    let hal_dir = hal_dir_name(ctx);
    let (_, startup_stem) = resolve_device(ctx, &fw)?;

    let mut copied: Vec<String> = Vec::new();

    // HAL headers, recursively (Inc/Legacy/*.h is included by hal_def.h).
    copy_headers(
        &fw.hal_inc,
        out_dir,
        &format!("Drivers/{hal_dir}/Inc"),
        true,
        &mut copied,
    )?;

    // HAL source subset.
    for f in hal_sources(ctx, &fw.hal_src)? {
        copy_file(
            &fw.hal_src.join(&f),
            out_dir,
            &format!("Drivers/{hal_dir}/Src/{f}"),
            &mut copied,
        )?;
    }

    // CMSIS device headers.
    copy_headers(
        &fw.dev_inc,
        out_dir,
        &format!("Drivers/CMSIS/Device/ST/{}/Include", ctx.device_prefix_dir()),
        false,
        &mut copied,
    )?;

    // CMSIS core headers (root + m-profile/ when present; a-/r-profile are
    // irrelevant for Cortex-M targets and deliberately skipped).
    copy_headers(&fw.core_inc, out_dir, "Drivers/CMSIS/Include", false, &mut copied)?;
    let m_profile = fw.core_inc.join("m-profile");
    if m_profile.is_dir() {
        copy_headers(
            &m_profile,
            out_dir,
            "Drivers/CMSIS/Include/m-profile",
            false,
            &mut copied,
        )?;
    }

    // The one startup file.
    let startup_src = fw.dev_gcc.join(format!("{startup_stem}.s"));
    ensure!(
        startup_src.is_file(),
        "startup file {startup_stem}.s not present under {}",
        fw.dev_gcc.display()
    );
    copy_file(
        &startup_src,
        out_dir,
        &format!("Core/Startup/{startup_stem}.s"),
        &mut copied,
    )?;

    // system_<prefix>.c — or, on trees that ship only per-variant copies, the
    // one this project's flavour needs (see [`system_source`]).
    let system_name = system_source(&fw.dev_templates, &fam_lower)?;
    copy_file(
        &fw.dev_templates.join(&system_name),
        out_dir,
        &format!("Core/Src/{system_name}"),
        &mut copied,
    )?;

    copied.sort();
    Ok(copied)
}

/// The `system_<prefix>.c` this project compiles.
///
/// Almost every family ships exactly that file. TrustZone-only families ship
/// only per-flavour copies instead — N6 has `system_stm32n6xx_fsbl.c`
/// (first-stage boot loader), `_s.c` and `_ns.c`. This project shell emits a
/// single non-TrustZone image, so the non-secure copy is the closest match;
/// the preference order is fixed rather than "first alphabetically" so the
/// choice is a decision, not an accident.
fn system_source(dev_templates: &Path, prefix: &str) -> anyhow::Result<String> {
    let plain = format!("system_{prefix}.c");
    if dev_templates.join(&plain).is_file() {
        return Ok(plain);
    }
    // `_s` before `_ns`: the non-secure copy calls into a secure counterpart
    // (`SECURE_SystemCoreClockUpdate`) that only a paired secure image
    // provides, so a single-image project has to be the secure one.
    for flavour in ["_s", "_ns", "_fsbl"] {
        let name = format!("system_{prefix}{flavour}.c");
        if dev_templates.join(&name).is_file() {
            return Ok(name);
        }
    }
    bail!(
        "no system_{prefix}*.c under {} (looked for {plain} then _ns/_s/_fsbl)",
        dev_templates.display()
    )
}

/// Copy one file into `out_dir/rel` (parents created), record `rel`.
fn copy_file(
    src: &Path,
    out_dir: &Path,
    rel: &str,
    copied: &mut Vec<String>,
) -> anyhow::Result<()> {
    let dest = out_dir.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &dest)
        .with_context(|| format!("copying {} -> {rel}", src.display()))?;
    copied.push(rel.to_string());
    Ok(())
}

/// Copy every `*.h` under `dir` into `out_dir/rel_base` (optionally
/// recursing into subdirectories), in sorted directory order.
fn copy_headers(
    dir: &Path,
    out_dir: &Path,
    rel_base: &str,
    recursive: bool,
    copied: &mut Vec<String>,
) -> anyhow::Result<()> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<_, _>>()?;
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            if recursive {
                copy_headers(&path, out_dir, &format!("{rel_base}/{name}"), true, copied)?;
            }
        } else if name.ends_with(".h") {
            copy_file(&path, out_dir, &format!("{rel_base}/{name}"), copied)?;
        }
    }
    Ok(())
}
