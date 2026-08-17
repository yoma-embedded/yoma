//! F4 golden tests (BlackPill class: STM32F411CEU6, HSE 25 MHz).
//! Exercises the AF-number GPIO scheme and the large PLLM/PLLN solver
//! domains with VCO-range pruning.

use std::path::PathBuf;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn load_pack() -> Option<IrPack> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/stm32f4.irpack");
    if !path.is_file() {
        eprintln!("skip: stm32f4.irpack not present");
        return None;
    }
    let bin = zstd::decode_all(std::fs::read(path).unwrap().as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn doc(sysclk_hz: u64) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32F411CEUx" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 25000000 }} }},
            "targets": {{ "SYSCLK": {{ "hz": {sysclk_hz} }} }}
          }},
          "peripherals": {{
            "USART1": {{
              "mode": "Asynchronous",
              "params": {{ "BaudRate": 115200 }},
              "pins": {{ "TX": "PA9", "RX": "PA10" }},
              "nvic": {{ "enabled": true }}
            }}
          }},
          "gpio": {{ "PC13": {{ "mode": "output", "label": "LED" }} }}
        }}"#
    ))
    .unwrap()
}

#[test]
fn f411_blackpill_100mhz() {
    let Some(pack) = load_pack() else { return };
    let d = doc(100_000_000);
    let resolved = validate(&pack, &d).expect("hard failure");
    for x in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", x.severity, x.code, x.path, x.message);
    }
    assert!(!has_errors(&resolved.diags));

    let sysclk = resolved
        .clock
        .freqs
        .iter()
        .find(|(id, _)| id.to_uppercase().contains("SYSCLK"))
        .map(|(_, f)| *f)
        .expect("sysclk propagated");
    assert_eq!(sysclk, stm32ck_ir::expr::Num::from_integer(100_000_000));

    // AF-number scheme: TX placement carries a GPIO_AF7 macro.
    let tx = resolved
        .pin_plan
        .placements
        .iter()
        .find(|p| p.signal == "USART1_TX")
        .expect("TX placed");
    assert_eq!(tx.pin, "PA9");
    assert_eq!(tx.af_macro.as_deref(), Some("GPIO_AF7_USART1"));
    assert!(tx.remap_block.is_none());
}

#[test]
fn f411_solver_determinism() {
    let Some(pack) = load_pack() else { return };
    let d = doc(100_000_000);
    let a = validate(&pack, &d).unwrap();
    let b = validate(&pack, &d).unwrap();
    assert_eq!(a.clock.assignments, b.clock.assignments);
}

/// The VCO window is the one constraint family the db hangs on the tree's
/// *signals* rather than its elements, so it is invisible to any check that
/// only walks nodes. Asserting the two VCO frequencies (not merely
/// "no errors") is what makes this test able to fail: with the edge-bound
/// bounds unwired, the solver happily returned PLLM=2 -> 12.5 MHz into the
/// VCO on a part whose db says 0.95..2.1 MHz.
#[test]
fn f411_solution_respects_vco_window() {
    let Some(pack) = load_pack() else { return };
    let resolved = validate(&pack, &doc(100_000_000)).expect("hard failure");
    assert!(!has_errors(&resolved.diags));

    let freq = |id: &str| {
        resolved
            .clock
            .freqs
            .get(id)
            .copied()
            .unwrap_or_else(|| panic!("{id} not propagated"))
    };
    // Node "PLLM" carries the divider's OUTPUT, i.e. the VCO input.
    let vco_in = freq("PLLM");
    let vco_out = freq("PLLN");
    let hz = |n: u64| stm32ck_ir::expr::Num::from_integer(n as i64);
    assert!(
        vco_in >= hz(950_000) && vco_in <= hz(2_100_000),
        "VCO input {vco_in} outside the db's 0.95..2.1 MHz window"
    );
    assert!(
        vco_out >= hz(100_000_000) && vco_out <= hz(432_000_000),
        "VCO output {vco_out} outside the db's 100..432 MHz window"
    );
}

/// A declared crystal must actually drive the PLL. The old predicate matched
/// the substring "HSE" anywhere in the assignment set, which
/// `RCC_RTC_Clock_Source_FROM_HSE = RCC_RTCCLKSOURCE_HSE_DIV2` satisfies for
/// free — so every solution scored as "HSE used" and HSI always won.
#[test]
fn f411_declared_crystal_drives_the_pll() {
    let Some(pack) = load_pack() else { return };
    let resolved = validate(&pack, &doc(100_000_000)).expect("hard failure");
    assert_eq!(
        resolved.clock.assignments.get("PLLSourceVirtual").map(String::as_str),
        Some("RCC_PLLSOURCE_HSE"),
        "HSE crystal declared but the PLL was sourced elsewhere: {:?}",
        resolved.clock.assignments
    );
}

#[test]
fn f411_rejects_120mhz() {
    let Some(pack) = load_pack() else { return };
    let d = doc(120_000_000); // F411 max is 100 MHz
    let resolved = validate(&pack, &d).expect("hard failure");
    assert!(
        resolved.diags.iter().any(|x| x.code == "CLK_UNSAT"),
        "120 MHz must be unsat on F411: {:?}",
        resolved.diags
    );
}
