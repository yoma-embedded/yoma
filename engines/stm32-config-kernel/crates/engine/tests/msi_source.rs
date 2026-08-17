//! The `distinctValsSource` oscillator: an MSI whose frequency comes from the
//! selected range rather than from a constant or the user.
//!
//! It is the default system clock of 20 families (L0/L1/L4/L5/U0/U3/U5/WB/WL
//! and friends). While the node kind was unmodelled the importer dropped the
//! element *and its output edges*, so those parts booted from nothing: a
//! configuration with no external crystal — the common case — had no path to
//! SYSCLK at all.

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

fn doc(part: &str, targets: &str) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "{part}" }},
          "clock": {{ "targets": {{ {targets} }} }},
          "peripherals": {{}},
          "gpio": {{}}
        }}"#
    ))
    .unwrap()
}

/// With nothing configured, an L4 runs off MSI range 6 — 4 MHz, read from the
/// `PossibleValue` comment (`4000`) scaled by the parameter's `Unit="KHz"`.
#[test]
fn l4_defaults_to_msi_at_4mhz() {
    let Some(pack) = load_pack("stm32l4.irpack") else { return };
    let doc = doc("STM32L476RGTx", "");
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags));

    let freqs = &resolved.clock.freqs;
    assert_eq!(
        freqs.get("MSIRC").map(|f| *f.numer()),
        Some(4_000_000),
        "MSI range 6 is 4 MHz; got {:?}",
        freqs.get("MSIRC")
    );
    assert_eq!(
        freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(4_000_000),
        "MSI must reach SYSCLK — the node's output edges are what the \
         unmodelled kind used to drop"
    );
}

/// And the solver can drive the PLL from it: 4 MHz / 1 * 40 / 2 = 80 MHz,
/// with no external crystal anywhere in the document.
#[test]
fn l4_reaches_80mhz_from_msi_without_a_crystal() {
    let Some(pack) = load_pack("stm32l4.irpack") else { return };
    let doc = doc("STM32L476RGTx", r#""SYSCLK": { "hz": 80000000 }"#);
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags));
    assert_eq!(
        resolved.clock.freqs.get("SysCLKOutput").map(|f| *f.numer()),
        Some(80_000_000)
    );
    assert_eq!(
        resolved.clock.assignments.get("PLLSourceVirtual").map(String::as_str),
        Some("RCC_PLLSOURCE_MSI"),
        "the only available source is MSI"
    );
}
