//! Solver completeness on the U0 clock tree (task #13): 24/32 MHz from an
//! 8 MHz HSE were exactly reachable (PLLM=1, N=12, R=3 or 4) yet the search
//! exhausted its budget without finding them, for two measured reasons:
//! the bound-but-dead SYSCLKSource=LSE branch soaked up the whole
//! PLLSource x PLLM x PLLN x PLLR product, and the U0 VCO window is gated
//! on VOS scale semaphores that only resolve once AHBCLKDivider — a
//! target-irrelevant tail variable — publishes HCLK, so an arithmetically
//! false 32 MHz hit (N=8, R=2, VCO=64 MHz < min 96 MHz) was accepted at the
//! ready depth and the tail product churned forever. The dead-path walk and
//! the defaults-completion check kill both in one state each; 56 MHz (which
//! only ever worked because its first hit happened to be legal) guards the
//! value-order contract.

use std::path::PathBuf;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn load_pack(name: &str) -> Option<IrPack> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../data")
        .join(name);
    if !path.is_file() {
        eprintln!("skip: {} not present", path.display());
        return None;
    }
    let bin = zstd::decode_all(std::fs::read(path).unwrap().as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn u083_doc(clock: &str) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32U083RCTx" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            {clock}
          }},
          "peripherals": {{}},
          "gpio": {{}}
        }}"#
    ))
    .unwrap()
}

fn solve<'a>(pack: &'a IrPack, doc: &'a ConfigDoc) -> stm32ck_engine::session::Resolved<'a> {
    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    resolved
}

#[test]
fn u083_solves_32mhz_from_8mhz_hse() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 32000000 } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags), "must solve, not exhaust the budget");
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(32_000_000)
    );
    // Documents the deterministic first-found solution: VCO = 8/1*12 =
    // 96 MHz sits exactly at the window minimum, divided by 3 for SYSCLK.
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLSourceVirtual").map(String::as_str), Some("RCC_PLLSOURCE_HSE"));
    assert_eq!(a.get("PLLM").map(String::as_str), Some("RCC_PLLM_DIV1"));
    assert_eq!(a.get("PLLN").map(String::as_str), Some("12"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV3"));
}

#[test]
fn u083_solves_24mhz_from_8mhz_hse() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 24000000 } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(24_000_000)
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLN").map(String::as_str), Some("12"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV4"));
}

/// 56 MHz solved BEFORE the completeness fixes (its first arithmetic hit,
/// N=14/R=2, VCO=112 MHz, happens to be legal) — it pins the first-found
/// solution against value-order regressions.
#[test]
fn u083_still_solves_56mhz() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 56000000 } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(56_000_000)
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLM").map(String::as_str), Some("RCC_PLLM_DIV1"));
    assert_eq!(a.get("PLLN").map(String::as_str), Some("14"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV2"));
}

/// Pinning the PLL chain by hand plus a target must stay exact — and the
/// user-pinned HSE source must satisfy the source-preference score so the
/// early exit fires instead of grinding the full budget for a solution that
/// was already in hand.
#[test]
fn u083_pinned_pll_stays_exact() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(
        r#""targets": { "SYSCLK": { "hz": 32000000 } },
           "assignments": {
             "PLLSourceVirtual": "RCC_PLLSOURCE_HSE",
             "PLLM": "RCC_PLLM_DIV1",
             "PLLN": 12,
             "PLLR": "RCC_PLLR_DIV3"
           }"#,
    );
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(32_000_000)
    );
}
