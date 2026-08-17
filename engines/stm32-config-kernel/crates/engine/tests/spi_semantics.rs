//! Fix gate for audit §二-2 (defaults-on-blackboard): parameter defaults of
//! active RefMode chains must reach the scoped env and publish their
//! PossibleValue semaphores during the activation fixpoint. Probed on the
//! real F1 pack with SPI1, whose db data exercises all three failure shapes:
//! overloads guarded on another parameter's *default* (`TIMode =
//! SPI_TIMODE_DISABLE` on FirstBit/CLKPolarity/CLKPhase) and overloads
//! guarded on mode semaphores (`$IpInstance_NSSHARD_Output` on NSS).
//! Skips when `data/stm32f1.irpack` is absent.

use std::path::PathBuf;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn load_pack(name: &str) -> Option<IrPack> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("data")
        .join(name);
    if !path.is_file() {
        eprintln!("skip: {} not present (run the importer first)", path.display());
        return None;
    }
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn spi_doc(modes: &str, params: &str) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32F103C8Tx" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            "targets": {{ "SYSCLK": {{ "hz": 72000000 }} }}
          }},
          "peripherals": {{
            "SPI1": {{
              "mode": {modes},
              "params": {{ {params} }},
              "pins": {{ "SCK": "PA5", "MISO": "PA6", "MOSI": "PA7" }}
            }}
          }}
        }}"#
    ))
    .unwrap()
}

/// Explicit list values whose legality is guarded by ANOTHER parameter's
/// default (`TIMode = SPI_TIMODE_DISABLE`) must validate clean — the audit
/// found them rejected with PARAM_RANGE because the guard saw no TIMode.
#[test]
fn f103_spi_explicit_firstbit_clkpolarity_validate_clean() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc = spi_doc(
        r#""Full_Duplex_Master""#,
        r#""FirstBit": "SPI_FIRSTBIT_MSB", "CLKPolarity": "SPI_POLARITY_LOW", "CLKPhase": "SPI_PHASE_1EDGE""#,
    );
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(
        !has_errors(&resolved.diags),
        "explicit FirstBit/CLKPolarity/CLKPhase must be accepted: {:?}",
        resolved.diags
    );

    let spi = resolved.periphs.iter().find(|p| p.instance == "SPI1").unwrap();
    assert_eq!(spi.params.get("FirstBit").map(String::as_str), Some("SPI_FIRSTBIT_MSB"));
    assert_eq!(spi.params.get("CLKPolarity").map(String::as_str), Some("SPI_POLARITY_LOW"));
    // Defaults of the active chain land in params too (Mode pinned by the
    // RefMode, TIMode/DataSize by RefParameter default).
    assert_eq!(spi.params.get("Mode").map(String::as_str), Some("SPI_MODE_MASTER"));
    assert_eq!(spi.params.get("TIMode").map(String::as_str), Some("SPI_TIMODE_DISABLE"));
    assert_eq!(spi.params.get("DataSize").map(String::as_str), Some("SPI_DATASIZE_8BIT"));
    // ... and onto the scoped blackboard with their PossibleValue semaphores.
    assert_eq!(
        resolved.env.params.get("SPI1:TIMode").map(|v| v.as_str()),
        Some("SPI_TIMODE_DISABLE".to_string())
    );
    assert!(
        resolved.env.semaphores.contains("SPI1_DATASIZE_BYTE"),
        "DataSize default must publish its semaphore"
    );
}

/// Hardware NSS: the NSS overload guarded by the mode-published
/// `$IpInstance_NSSHARD_Output` semaphore must win — the audit found the
/// unconditioned SPI_NSS_SOFT fallback silently emitted instead.
#[test]
fn f103_spi_hardware_nss_resolves_hard_output() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc = spi_doc(r#"["Full_Duplex_Master", "NSS_Signal_Hard_Output"]"#, "");
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "diags: {:?}", resolved.diags);

    let spi = resolved.periphs.iter().find(|p| p.instance == "SPI1").unwrap();
    assert_eq!(
        spi.params.get("NSS").map(String::as_str),
        Some("SPI_NSS_HARD_OUTPUT"),
        "params: {:?}",
        spi.params
    );
    // Software-NSS master for contrast: unconditioned fallback applies.
    let doc = spi_doc(r#""Full_Duplex_Master""#, "");
    let resolved = validate(&pack, &doc).expect("hard failure");
    let spi = resolved.periphs.iter().find(|p| p.instance == "SPI1").unwrap();
    assert_eq!(spi.params.get("NSS").map(String::as_str), Some("SPI_NSS_SOFT"));
}

/// Determinism: the fixpoint with defaults-on-blackboard stays stable.
#[test]
fn f103_spi_fixpoint_deterministic() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc = spi_doc(r#"["Full_Duplex_Master", "NSS_Signal_Hard_Output"]"#, "");
    let a = validate(&pack, &doc).unwrap();
    let b = validate(&pack, &doc).unwrap();
    assert_eq!(format!("{:?}", a.env.semaphores), format!("{:?}", b.env.semaphores));
    let pa = a.periphs.iter().find(|p| p.instance == "SPI1").unwrap();
    let pb = b.periphs.iter().find(|p| p.instance == "SPI1").unwrap();
    assert_eq!(pa.params, pb.params);
}
