//! Deterministic code generation: [`Resolved`] model -> complete compilable
//! HAL project. Codegen makes NO decisions — every value it prints was
//! resolved by the engine; templates only arrange them (design §9).
//!
//! Output conventions replicate CubeMX for interop: `MX_<inst>_<hal>_Init`
//! naming, USER CODE sections, `{0}`-initialized locals, guarded
//! `!= HAL_OK -> Error_Handler()` calls, clock-enable-before-GPIO in MSP.

pub mod emit;
pub mod middleware;
pub mod preserve;
pub mod project;

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::Diagnostic;
use stm32ck_engine::session::Resolved;
use stm32ck_ir::model::IrPack;

/// One generated text file (paths relative to the project root, `/`-separated).
#[derive(Debug, Clone)]
pub struct GeneratedFile {
    pub rel_path: String,
    pub content: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Manifest {
    /// Relative paths of every file written (generated + copied), sorted.
    pub files: Vec<String>,
    pub diags: Vec<Diagnostic>,
}

/// Everything emission needs, in one place.
pub struct GenCtx<'a> {
    pub pack: &'a IrPack,
    pub resolved: &'a Resolved<'a>,
    pub doc: &'a ConfigDoc,
    /// Kernel version string stamped into file headers.
    pub kernel_version: &'a str,
    /// What the landed firmware tree says about this family — read once by
    /// [`project::fw_facts`]. `None` when no tree is available (unit tests
    /// that never touch disk); every accessor then falls back to a
    /// family-derived guess.
    pub fw: Option<FwFacts>,
}

/// Facts only the firmware tree can answer, collected before emission so the
/// emitters stay pure.
#[derive(Debug, Default)]
pub struct FwFacts {
    /// Lowercased device prefix every HAL/CMSIS name is built from:
    /// `stm32f1xx`, but `stm32wb0x` for STM32WB0.
    pub device_prefix: String,
    /// HAL modules this family actually ships (`Inc/<prefix>_hal_<m>.h`),
    /// uppercased. N6 has no `hal_flash`, so enabling `HAL_FLASH_MODULE` and
    /// including its header would not compile.
    pub hal_modules: BTreeSet<String>,
    /// The macros ST's own `<prefix>_hal_conf_template.h` declares, with the
    /// HAL modules that read each one.
    ///
    /// The set is family-specific in ways the db does not spell the same way
    /// (the db calls it `EXTERNALSAI1_CLOCK_VALUE`, the L4 HAL wants
    /// `EXTERNAL_SAI1_CLOCK_VALUE`), so the template is the authority on the
    /// *names* and the fallback for values nothing else sets.
    pub hal_conf_values: BTreeMap<String, HalConfMacro>,
    /// Every identifier appearing in `<prefix>_hal_rcc.h` / `_hal_rcc_ex.h`.
    ///
    /// The db shares one RCC struct shape across a family's dies, so its
    /// field list is a superset: STM32WL's `RCC_ClkInitTypeDef` shape carries
    /// `AHBCLK2Divider`, which exists only on the dual-core WL55 and not in
    /// the single-core WLE5 header. Checking the member name against the
    /// header the project compiles against is what keeps the emitted struct
    /// assignment honest.
    pub rcc_header_idents: BTreeSet<String>,
    /// The HAL driver's own version, e.g. `1.8.3`.
    ///
    /// Read from the `__STM32<F>xx_HAL_VERSION_*` defines in
    /// `Inc/<prefix>_hal.h`, which every ST HAL carries. Without it the
    /// "same input -> byte-identical output" promise is only true within one
    /// firmware package: nothing in the generated tree or the config document
    /// says which one produced it.
    pub hal_version: Option<String>,
}

/// One macro from ST's hal_conf template, and who reads it.
#[derive(Debug, Clone)]
pub struct HalConfMacro {
    /// The value text, comments stripped.
    pub value: String,
    /// HAL modules whose `Src/*.c` reference the name, uppercased. Empty
    /// means "only the always-compiled core sources", i.e. always needed.
    /// F1's 40 Ethernet PHY macros land under `ETH` and are emitted only for
    /// a project that enables it — while `stm32f4xx_hal_eth.c` really does
    /// need `PHY_READ_TO`, which has no `_VALUE` suffix to recognise it by.
    pub modules: BTreeSet<String>,
}

impl<'a> GenCtx<'a> {
    /// Family prefix for config lookup: "STM32F1" -> config defs named
    /// "UART-STM32F1xx".
    pub fn family(&self) -> &str {
        &self.pack.family
    }

    /// The device prefix in ST's lowercase spelling: `stm32f1xx`,
    /// `stm32wb0x`. Everything the generated project names after the device
    /// — `#include "<p>_hal.h"`, `Core/Src/<p>_it.c`, `<p>_hal_uart.c` — is
    /// built from this one token, so it must be the firmware tree's own
    /// spelling rather than a guess: STM32WB0 ships `stm32wb0x_hal.c`, not
    /// `stm32wb0xx_hal.c`.
    pub fn device_prefix(&self) -> String {
        self.fw
            .as_ref()
            .map(|f| f.device_prefix.clone())
            .unwrap_or_else(|| format!("{}xx", self.family()).to_ascii_lowercase())
    }

    /// Whether the RCC headers this project compiles against know `ident`.
    /// True when no firmware tree is available, so unit tests keep working.
    pub fn rcc_knows(&self, ident: &str) -> bool {
        self.fw
            .as_ref()
            .is_none_or(|f| f.rcc_header_idents.is_empty() || f.rcc_header_idents.contains(ident))
    }

    /// The same token as ST spells its directories and device macros:
    /// `STM32F1xx`, `STM32WB0x` — uppercase except the trailing `x` run.
    pub fn device_prefix_dir(&self) -> String {
        let p = self.device_prefix();
        let tail = p.len() - p.chars().rev().take_while(|c| *c == 'x').count();
        format!("{}{}", p[..tail].to_ascii_uppercase(), &p[tail..])
    }

    /// Resolve the codegen ConfigDef for a peripheral: explicit ConfigFile
    /// first, then `{HalMode}-{family}xx`, then `{IpName}-{family}xx`.
    pub fn config_for(
        &self,
        p: &stm32ck_engine::session::ResolvedPeriph<'_>,
    ) -> Option<&'a stm32ck_ir::model::ConfigDef> {
        let fam = format!("{}xx", self.family());
        let mut keys: Vec<String> = Vec::new();
        if let Some(hm) = &p.hal_mode {
            keys.push(format!("{hm}-{fam}"));
        }
        keys.push(format!("{}-{fam}", p.ip.name));
        if let Some(inst) = self
            .resolved
            .part
            .ip_instances
            .iter()
            .find(|i| i.instance == p.instance)
        {
            if let Some(cf) = &inst.config_file {
                keys.insert(0, cf.clone());
            }
        }
        keys.iter().find_map(|k| self.pack.configs.get(k))
    }
}

/// Canonical HAL module (uppercase, e.g. "SPI", "UART", "TIM") for one
/// resolved peripheral. Drives the four wired-together module surfaces:
/// hal_conf `HAL_<M>_MODULE_ENABLED` + include block, HAL `Src/*.c` copy,
/// and the CMake source list — they MUST agree or the project won't build
/// (audit §二-1: SPI's RefModes carry no HalMode and fell through all four).
///
/// hal_mode's head segment when present ("TIM_OC" -> "TIM"); otherwise a
/// fallback from the IP name for the known HAL-backed peripherals
/// ("TIM1_8" -> "TIM"). Unknown module-less IPs get None (no HAL module).
pub fn hal_module(p: &stm32ck_engine::session::ResolvedPeriph<'_>) -> Option<String> {
    if let Some(hm) = &p.hal_mode {
        return Some(hal_header_name(
            hm.split('_').next().unwrap_or(hm).to_ascii_uppercase(),
        ));
    }
    let name = p.ip.name.to_ascii_uppercase();
    let stem = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '_');
    // The db's HalMode is the primary source; this list covers the IPs that
    // carry HAL drivers but declare no HalMode. On F1/F4 that set is exactly
    // ADC, CAN, CRC, DAC, I2S, RNG (SYS/GPIO/DMA/RCC are always-on modules
    // handled separately) — CRC and RNG were missing, so their module macro
    // never fired and their driver never entered the CMake source list,
    // leaving `HAL_CRC_Init` undefined at link time.
    ["SPI", "I2C", "I2S", "CAN", "ADC", "DAC", "TIM", "USART", "UART", "CRC", "RNG"]
        .iter()
        .find(|m| stem == **m)
        .map(|m| hal_header_name((*m).to_string()))
}

/// IP name -> HAL module name. Two IPs are filed under a different name in
/// the HAL than in the db, and the module macro, the `#include` and the
/// driver's file name all follow the HAL's spelling (CubeMX does the same
/// rewrite inline in its hal_conf template).
fn hal_header_name(module: String) -> String {
    match module.as_str() {
        "QUADSPI" => "QSPI".to_string(),
        "AES" => "CRYP".to_string(),
        _ => module,
    }
}

/// Per-peripheral file stem for the CubeMX-style file split (plan §P4):
/// the lowercased HAL family group exactly like CubeMX names its coupled
/// files — `adc`/`can`/`spi`/`tim`; UART and USART instances share one
/// `usart` file (reference: usart.c holds UART4). Module-less IPs fall
/// back to the lowercased instance name.
pub fn file_stem(p: &stm32ck_engine::session::ResolvedPeriph<'_>) -> String {
    match hal_module(p).as_deref() {
        Some("UART") | Some("USART") => "usart".to_string(),
        Some(m) => m.to_ascii_lowercase(),
        None => p.instance.to_ascii_lowercase(),
    }
}

/// Generate the full project under `out_dir`. `fw_dir` points at the local
/// firmware components: `<fw_dir>/<family>/HAL_Driver`, `CMSIS_Device`,
/// `CMSIS_Core` (see tools/fetch-fw notes in the README).
pub fn generate_project(
    pack: &IrPack,
    resolved: &Resolved<'_>,
    doc: &ConfigDoc,
    fw_dir: &Path,
    out_dir: &Path,
    kernel_version: &str,
) -> anyhow::Result<Manifest> {
    let ctx = GenCtx {
        pack,
        resolved,
        doc,
        kernel_version,
        fw: project::fw_facts(fw_dir, &pack.family, resolved.part, &doc.mcu.part),
    };

    let mut files: BTreeMap<String, String> = BTreeMap::new();
    for f in emit::emit_all(&ctx)? {
        files.insert(f.rel_path.clone(), f.content);
    }
    for f in project::assemble(&ctx, fw_dir)? {
        files.insert(f.rel_path.clone(), f.content);
    }
    // Middleware seam (plan §P4): extra generated files from the registry
    // (empty today; P5/P6 plug in here). They go through the same
    // USER-CODE-preserving write path as core files.
    for mw in middleware::active(&ctx) {
        for f in mw.files(&ctx)? {
            files.insert(f.rel_path.clone(), f.content);
        }
    }

    // Deterministic write: sorted paths, LF endings, atomic-ish (write all
    // to a temp mirror is overkill for v1; ordering is what matters).
    // Regeneration: when a generated file already exists on disk, USER CODE
    // sections of the existing file are preserved (preserve::merge_user_code)
    // and merge diagnostics land in the manifest. Copied firmware (Drivers/,
    // Core/Startup/, system_*.c) stays overwrite-always.
    let mut manifest = Manifest::default();
    // Middleware coupling diagnostics (trait `diagnostics`, plan §P5):
    // warnings for engine-side couplings a generator cannot enforce itself
    // (missing TIM timebase, non-GROUP_4 NVIC grouping, ...).
    manifest.diags.extend(middleware::diagnostics(&ctx));
    for (rel, content) in &files {
        let dest = out_dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let fresh = content.replace("\r\n", "\n");
        let output = if dest.is_file() {
            merge_existing(&fresh, &dest, rel, &mut manifest.diags)?
        } else {
            fresh
        };
        std::fs::write(&dest, output)?;
        manifest.files.push(rel.clone());
    }
    // Copies (HAL sources, CMSIS headers, startup) are performed by
    // project::copy_firmware and appended to the manifest.
    let copied = project::copy_firmware(&ctx, fw_dir, out_dir)?;
    manifest.files.extend(copied);
    // Middleware library payload copies (Middlewares/... trees).
    for mw in middleware::active(&ctx) {
        manifest.files.extend(mw.copy_sources(&ctx, fw_dir, out_dir)?);
    }
    manifest.files.sort();
    report_stale(out_dir, &manifest.files, &mut manifest.diags);
    Ok(manifest)
}

/// Report `Core/Src` and `Core/Inc` files this run did not produce.
///
/// Regenerating into an existing tree used to leave the previous run's
/// per-peripheral files behind — remove SPI from the document and `spi.c`
/// stays, keeps being compiled, and keeps calling an `MX_SPI1_Init` that main
/// no longer declares. Reporting rather than deleting: the file may hold user
/// code, and this kernel does not delete a user's work on its own. The paths
/// are listed so a caller can act.
fn report_stale(out_dir: &Path, written: &[String], diags: &mut Vec<Diagnostic>) {
    let produced: std::collections::BTreeSet<&str> =
        written.iter().map(String::as_str).collect();
    let mut stale: Vec<String> = Vec::new();
    for dir in ["Core/Src", "Core/Inc"] {
        let Ok(entries) = std::fs::read_dir(out_dir.join(dir)) else {
            continue;
        };
        for e in entries.filter_map(Result::ok) {
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // `.bak` files are our own regeneration safety net.
            if name.ends_with(".bak") || !e.path().is_file() {
                continue;
            }
            let rel = format!("{dir}/{name}");
            if !produced.contains(rel.as_str()) {
                stale.push(rel);
            }
        }
    }
    stale.sort();
    for rel in stale {
        diags.push(
            Diagnostic::warning(
                preserve::REGEN_STALE,
                rel.clone(),
                format!(
                    "`{rel}` is left over from an earlier generation and is no longer \
                     produced by this configuration"
                ),
            )
            .with_suggestion("delete it, or re-add the peripheral that owned it"),
        );
    }
}

/// Merge freshly generated `fresh` content over the existing file at `dest`,
/// preserving USER CODE sections. On an unmergeable existing file (malformed
/// anchors or non-UTF-8) the fresh content wins and the previous file is kept
/// as `<name>.bak` alongside (deterministic name, overwrites an older .bak).
fn merge_existing(
    fresh: &str,
    dest: &Path,
    rel: &str,
    diags: &mut Vec<Diagnostic>,
) -> anyhow::Result<String> {
    let existing = match std::fs::read(dest) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => Some(s),
            Err(_) => {
                diags.push(Diagnostic::warning(
                    preserve::REGEN_MALFORMED,
                    rel.to_string(),
                    format!(
                        "existing {rel} is not valid UTF-8; the file was regenerated \
                         fresh and the previous version saved next to it as a .bak"
                    ),
                ));
                None
            }
        },
        Err(e) => return Err(e.into()),
    };
    let Some(existing) = existing else {
        back_up(dest)?;
        return Ok(fresh.to_string());
    };

    let (merged, merge_diags) = preserve::merge_user_code(fresh, &existing, rel);
    let unmergeable = merge_diags.iter().any(|d| d.code == preserve::REGEN_MALFORMED);
    diags.extend(merge_diags);
    if unmergeable {
        back_up(dest)?;
    }
    Ok(merged)
}

/// Copy `dest` to `<file name>.bak` in the same directory (no timestamps;
/// a previous .bak is overwritten).
fn back_up(dest: &Path) -> anyhow::Result<()> {
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("non-UTF-8 file name for backup: {}", dest.display()))?;
    std::fs::copy(dest, dest.with_file_name(format!("{name}.bak")))?;
    Ok(())
}
