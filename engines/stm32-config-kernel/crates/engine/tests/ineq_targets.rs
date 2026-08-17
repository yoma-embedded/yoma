//! atMost/atLeast clock targets (task #9): "at most 250 MHz" used to accept
//! the first feasible leaf — CSI at 4 MHz — because any frequency under the
//! bound satisfied the miss check and the HSE early exit fired. The score
//! now carries a bound-distance column, the early exit demands distance 0,
//! and once every target frequency is determined the remaining cone
//! variables switch to first-legal completion (a determined frequency is
//! final for its branch) with a dominance prune over the best distance in
//! hand. Exact-only configs are untouched by construction (has_ineq gate).

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

fn h563_doc(clock: &str) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32H563IGTx" }},
          "clock": {{ {clock} }},
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
fn u083_atmost_48_prefers_fastest() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 48000000, "kind": "atMost" } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(48_000_000),
        "the bound is exactly reachable, so atMost must land ON it"
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLSourceVirtual").map(String::as_str), Some("RCC_PLLSOURCE_HSE"));
    assert_eq!(a.get("PLLM").map(String::as_str), Some("RCC_PLLM_DIV1"));
    assert_eq!(a.get("PLLN").map(String::as_str), Some("12"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV2"));
}

#[test]
fn u083_atmost_40_prefers_fastest() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 40000000, "kind": "atMost" } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(40_000_000)
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLN").map(String::as_str), Some("15"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV3"));
}

/// Mixed kinds: the Exact target keeps its untouched first-found solution,
/// the atMost rides on top (HCLK exactly at its 16 MHz bound via DIV2).
#[test]
fn u083_exact_plus_atmost_hclk() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(
        r#""targets": {
             "SYSCLK": { "hz": 32000000 },
             "HCLKOutput": { "hz": 16000000, "kind": "atMost" }
           }"#,
    );
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(32_000_000)
    );
    assert_eq!(
        r.clock.freqs.get("HCLKOutput").map(|f| *f.numer()),
        Some(16_000_000)
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLN").map(String::as_str), Some("12"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV3"));
    assert_eq!(a.get("AHBCLKDivider").map(String::as_str), Some("RCC_SYSCLK_DIV2"));
}

/// The reported bug shape: H563 atMost 250 MHz used to return CSI at 4 MHz
/// (or HSE at 8 MHz). Solver-heavy — run in the release lane.
#[test]
#[ignore = "solver-heavy: run with --release -- --ignored"]
fn h563_atmost_250_prefers_fastest() {
    let Some(pack) = load_pack("stm32h5.irpack") else { return };
    let doc = h563_doc(
        r#""sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
           "targets": { "SYSCLK": { "hz": 250000000, "kind": "atMost" } }"#,
    );
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(250_000_000)
    );
    let a = &r.clock.assignments;
    assert_eq!(
        a.get("PLLSourceVirtual").map(String::as_str),
        Some("RCC_PLL1_SOURCE_HSE")
    );
}

#[test]
#[ignore = "solver-heavy: run with --release -- --ignored"]
fn h563_atmost_250_no_hse() {
    let Some(pack) = load_pack("stm32h5.irpack") else { return };
    let doc = h563_doc(r#""targets": { "SYSCLK": { "hz": 250000000, "kind": "atMost" } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    assert_eq!(
        r.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(250_000_000)
    );
}

/// A bound that is NOT exactly reachable returns the closest solution found
/// within budget — deterministic, never over the bound. The winner is a
/// NON-INTEGER frequency (8 MHz * 125 / 3 / 7 = 10^9/21 Hz ~ 47.619 MHz,
/// 381 kHz under the bound): frequencies are exact rationals, and reading
/// them through `.numer()` alone is how this test first lied to itself.
#[test]
#[ignore = "solver-heavy: run with --release -- --ignored"]
fn u083_atmost_unreachable_returns_closest() {
    let Some(pack) = load_pack("stm32u0.irpack") else { return };
    let doc = u083_doc(r#""targets": { "SYSCLK": { "hz": 47999999, "kind": "atMost" } }"#);
    let r = solve(&pack, &doc);
    assert!(!has_errors(&r.diags));
    let f = *r.clock.freqs.get("SysCLKOutput").unwrap();
    let bound = stm32ck_ir::expr::Num::from_integer(47_999_999);
    assert!(f <= bound, "must stay under the bound, got {f}");
    assert!(
        f > stm32ck_ir::expr::Num::from_integer(46_000_000),
        "must be a near-bound solution, got {f}"
    );
    assert_eq!(
        f,
        stm32ck_ir::expr::Num::new(1_000_000_000, 21),
        "deterministic first-found closest (PLLM=3, PLLN=125, PLLR=7)"
    );
    let a = &r.clock.assignments;
    assert_eq!(a.get("PLLM").map(String::as_str), Some("RCC_PLLM_DIV3"));
    assert_eq!(a.get("PLLN").map(String::as_str), Some("125"));
    assert_eq!(a.get("PLLR").map(String::as_str), Some("RCC_PLLR_DIV7"));
}
