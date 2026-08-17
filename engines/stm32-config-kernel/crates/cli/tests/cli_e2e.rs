//! End-to-end tests driving the built `stm32kernel` binary as a real
//! subprocess. Tests needing the F1 IR pack (and, for generate, the
//! firmware components) skip with an eprintln when those are absent.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_stm32kernel");

const GOLDEN: &str = r#"{
  "schemaVersion": 1,
  "mcu": { "part": "STM32F103C8Tx" },
  "clock": {
    "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
    "targets": { "SYSCLK": { "hz": 72000000 } }
  },
  "peripherals": {
    "USART1": {
      "mode": "Asynchronous",
      "params": { "BaudRate": 115200 },
      "pins": { "TX": "PA9", "RX": "PA10" },
      "nvic": { "enabled": true, "preemptionPriority": 1 }
    }
  },
  "gpio": { "PC13": { "mode": "output", "initHigh": true, "label": "LED" } }
}"#;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn data_dir() -> PathBuf {
    repo_root().join("data")
}

fn have_pack() -> bool {
    let present = data_dir().join("stm32f1.irpack").is_file();
    if !present {
        eprintln!("skip: data/stm32f1.irpack not present (run the importer first)");
    }
    present
}

/// Run the binary with --data-dir pointing at the repo packs; return the
/// exit code and the raw stdout/stderr text uninterpreted.
fn run_raw(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(BIN)
        .arg("--data-dir")
        .arg(data_dir())
        .args(args)
        .output()
        .expect("spawn stm32kernel");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    (out.status.code().unwrap_or(-1), stdout, stderr)
}

/// [`run_raw`], then parse stdout as JSON. Panics with full output when
/// stdout is not a JSON document.
fn run(args: &[&str]) -> (i32, Value, String) {
    let (code, stdout, stderr) = run_raw(args);
    let value: Value = serde_json::from_str(&stdout).unwrap_or_else(|e| {
        panic!("stdout is not JSON ({e}):\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}")
    });
    (code, value, stderr)
}

/// Write the golden config (optionally mutated) into the test tmp dir.
fn write_config(name: &str, mutate: impl FnOnce(&mut Value)) -> PathBuf {
    let mut doc: Value = serde_json::from_str(GOLDEN).unwrap();
    mutate(&mut doc);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    path
}

fn error_diags(value: &Value) -> Vec<Value> {
    value["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d["severity"] == "error")
        .collect()
}

#[test]
fn list_mcus_covers_the_f1_catalog() {
    if !have_pack() {
        return;
    }
    let (code, value, stderr) = run(&["list-mcus"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let mcus = value["mcus"].as_array().expect("mcus array");
    assert!(mcus.len() > 50, "only {} rows", mcus.len());
    assert!(
        mcus.iter().any(|m| m["refName"] == "STM32F103C(8-B)Tx"),
        "BluePill part missing from listing"
    );
    // Every row carries the documented columns.
    for key in ["refName", "partNumbers", "family", "package", "flashKb", "ramKb", "maxFreqMhz", "ioCount"] {
        assert!(!mcus[0][key].is_null(), "column {key} missing: {}", mcus[0]);
    }
}

#[test]
fn describe_mcu_reports_pins_and_ips() {
    if !have_pack() {
        return;
    }
    let (code, value, stderr) = run(&["describe-mcu", "STM32F103C8Tx"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(value["part"]["refName"], "STM32F103C(8-B)Tx");
    let pins = value["pins"].as_array().unwrap();
    assert!(pins.iter().any(|p| p["name"] == "PA9"
        && p["signals"].as_array().unwrap().iter().any(|s| s == "USART1_TX")));
    let ips = value["ipInstances"].as_array().unwrap();
    assert!(ips.iter().any(|i| i["instance"] == "USART1"));
}

#[test]
fn validate_golden_config_is_clean() {
    if !have_pack() {
        return;
    }
    let cfg = write_config("cli_golden_validate.json", |_| {});
    let (code, value, stderr) = run(&["validate", "--config", cfg.to_str().unwrap()]);
    assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
    assert!(error_diags(&value).is_empty(), "diags: {}", value["diagnostics"]);
    assert_eq!(value["summary"]["part"], "STM32F103C(8-B)Tx");
    assert_eq!(value["summary"]["sysclkHz"], json!(72_000_000u64));
    assert_eq!(value["summary"]["placements"]["USART1_TX"], "PA9");
}

#[test]
fn solve_clock_picks_pll_mul9() {
    if !have_pack() {
        return;
    }
    let cfg = write_config("cli_golden_solve.json", |_| {});
    let (code, value, stderr) = run(&["solve-clock", "--config", cfg.to_str().unwrap()]);
    assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
    assert_eq!(
        value["assignments"]["PLLMUL"], "RCC_PLL_MUL9",
        "assignments: {}",
        value["assignments"]
    );
    let sysclk = value["freqs"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(id, _)| id.to_uppercase().contains("SYSCLK"))
        .map(|(_, hz)| hz.clone())
        .expect("sysclk frequency propagated");
    assert_eq!(sysclk, json!(72_000_000u64));
}

#[test]
fn candidates_lists_usart1_tx_pads_with_remap_blocks() {
    if !have_pack() {
        return;
    }
    let cfg = write_config("cli_golden_candidates.json", |_| {});
    let (code, value, stderr) = run(&[
        "candidates",
        "--config",
        cfg.to_str().unwrap(),
        "--peripheral",
        "USART1",
        "--signal",
        "TX",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
    let signals = value["signals"].as_array().unwrap();
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0]["signal"], "USART1_TX");
    let cands = signals[0]["candidates"].as_array().unwrap();
    let pins: Vec<&str> = cands.iter().map(|c| c["pin"].as_str().unwrap()).collect();
    assert!(pins.contains(&"PA9") && pins.contains(&"PB6"), "pads: {pins:?}");
    // F1: every candidate must carry its AFIO remap-block info.
    for c in cands {
        assert!(
            !c["remapBlocks"].as_array().unwrap().is_empty(),
            "remap info missing on {}",
            c["pin"]
        );
    }
}

#[test]
fn candidates_via_part_needs_no_config() {
    if !have_pack() {
        return;
    }
    let (code, value, stderr) = run(&[
        "candidates",
        "--part",
        "STM32F103C8Tx",
        "--peripheral",
        "USART1",
        "--signal",
        "TX",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
    assert_eq!(value["activeModes"], json!([]), "part query is mode-agnostic");
    let signals = value["signals"].as_array().unwrap();
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0]["signal"], "USART1_TX");
    let cands = signals[0]["candidates"].as_array().unwrap();
    let pins: Vec<&str> = cands.iter().map(|c| c["pin"].as_str().unwrap()).collect();
    assert!(pins.contains(&"PA9") && pins.contains(&"PB6"), "pads: {pins:?}");
    // The shared pad enumeration must carry the F1 remap info here too.
    for c in cands {
        assert!(
            !c["remapBlocks"].as_array().unwrap().is_empty(),
            "remap info missing on {}",
            c["pin"]
        );
    }
    assert!(error_diags(&value).is_empty(), "{value}");
}

#[test]
fn candidates_falls_back_when_peripheral_not_in_config() {
    if !have_pack() {
        return;
    }
    // GOLDEN configures only USART1; TIM4 exists on the part but not in the
    // document — the pre-config question this command exists for.
    let cfg = write_config("cli_candidates_fallback.json", |_| {});
    let (code, value, stderr) = run(&[
        "candidates",
        "--config",
        cfg.to_str().unwrap(),
        "--peripheral",
        "TIM4",
        "--signal",
        "CH1",
    ]);
    assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
    let signals = value["signals"].as_array().unwrap();
    assert_eq!(signals[0]["signal"], "TIM4_CH1");
    let pins: Vec<&str> = signals[0]["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["pin"].as_str().unwrap())
        .collect();
    assert_eq!(pins, ["PB6"], "F103C8 TIM4_CH1 lives on PB6");
    let diags = value["diagnostics"].as_array().unwrap();
    assert!(
        diags
            .iter()
            .any(|d| d["code"] == "PERIPH_UNCONFIGURED" && d["severity"] == "info"),
        "expected the PERIPH_UNCONFIGURED info pointer: {value}"
    );
    assert!(error_diags(&value).is_empty(), "{value}");
}

#[test]
fn candidates_part_query_rejects_unknown_instance() {
    if !have_pack() {
        return;
    }
    let (code, value, _stderr) = run(&[
        "candidates",
        "--part",
        "STM32F103C8Tx",
        "--peripheral",
        "TIM99",
    ]);
    assert_eq!(code, 1);
    let errs = error_diags(&value);
    assert!(
        errs.iter().any(|d| d["code"] == "PERIPH_UNKNOWN"
            && d["message"].as_str().unwrap().contains("does not exist")),
        "{value}"
    );
}

#[test]
fn candidates_requires_config_or_part() {
    // No pack needed: clap rejects the argv before any data loads.
    let (code, _out, _err) = run_raw(&["candidates", "--peripheral", "USART1"]);
    assert_eq!(code, 2, "missing both --config and --part is a usage error");
    let (code, _out, _err) = run_raw(&[
        "candidates",
        "--config",
        "x.json",
        "--part",
        "STM32F103C8Tx",
        "--peripheral",
        "USART1",
    ]);
    assert_eq!(code, 2, "--config and --part conflict");
}

#[test]
fn validate_rejects_96mhz_sysclk_with_clk_unsat() {
    if !have_pack() {
        return;
    }
    let cfg = write_config("cli_broken_96mhz.json", |doc| {
        doc["clock"]["targets"]["SYSCLK"]["hz"] = json!(96_000_000u64);
    });
    let (code, value, _) = run(&["validate", "--config", cfg.to_str().unwrap()]);
    assert_eq!(code, 1, "json: {value}");
    assert!(
        value["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "CLK_UNSAT"),
        "diags: {}",
        value["diagnostics"]
    );
}

#[test]
fn generate_writes_project_and_is_byte_deterministic() {
    if !have_pack() {
        return;
    }
    let fw = data_dir().join("fw");
    if !fw.join("STM32F1").is_dir() {
        eprintln!("skip: firmware components not present under {}", fw.display());
        return;
    }
    let cfg = write_config("cli_golden_generate.json", |_| {});
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let out_a = base.join("cli_gen_a");
    let out_b = base.join("cli_gen_b");
    for dir in [&out_a, &out_b] {
        if dir.exists() {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    let mut manifests: Vec<Vec<String>> = Vec::new();
    for out_dir in [&out_a, &out_b] {
        let (code, value, stderr) = run(&[
            "generate",
            "--config",
            cfg.to_str().unwrap(),
            "--out",
            out_dir.to_str().unwrap(),
            "--fw-dir",
            fw.to_str().unwrap(),
        ]);
        assert_eq!(code, 0, "stderr: {stderr}\njson: {value}");
        assert!(error_diags(&value).is_empty(), "diags: {}", value["diagnostics"]);
        manifests.push(
            value["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f.as_str().unwrap().to_string())
                .collect(),
        );
    }
    assert_eq!(manifests[0], manifests[1], "manifests differ between runs");
    assert!(
        manifests[0].iter().any(|f| f == "Core/Src/main.c"),
        "manifest misses main.c: {:?}",
        manifests[0]
    );
    assert!(out_a.join("CMakeLists.txt").is_file(), "CMakeLists.txt not written");

    let a = std::fs::read(out_a.join("Core/Src/main.c")).unwrap();
    let b = std::fs::read(out_b.join("Core/Src/main.c")).unwrap();
    assert!(a == b, "Core/Src/main.c differs between two identical runs");
}

#[test]
fn generate_writes_nothing_on_error_diagnostics() {
    if !have_pack() {
        return;
    }
    let cfg = write_config("cli_broken_generate.json", |doc| {
        doc["clock"]["targets"]["SYSCLK"]["hz"] = json!(96_000_000u64);
    });
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let out_dir = base.join("cli_gen_refused");
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).unwrap();
    }
    let (code, value, _) = run(&[
        "generate",
        "--config",
        cfg.to_str().unwrap(),
        "--out",
        out_dir.to_str().unwrap(),
        "--fw-dir",
        data_dir().join("fw").to_str().unwrap(),
    ]);
    assert_eq!(code, 1, "json: {value}");
    assert!(!error_diags(&value).is_empty());
    assert!(value.get("files").is_none(), "no manifest expected: {value}");
    assert!(!out_dir.exists(), "output dir must not be created on error");
}

#[test]
fn schema_full_prints_the_json_schema() {
    // schema needs no pack — must work even on a bare checkout.
    let (code, value, stderr) = run(&["schema", "--full"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    let text = serde_json::to_string(&value).unwrap();
    assert!(text.contains("schemaVersion"), "schema misses schemaVersion: {text}");
    assert!(
        value["properties"]["schemaVersion"].is_object(),
        "schemaVersion property missing: {value}"
    );
    assert!(!value["$defs"].as_object().unwrap().is_empty());
    // Guards --full against accidental description stripping.
    assert!(value["$defs"]["GpioPinCfg"]["properties"]["sharedWith"]["description"].is_string());
}

#[test]
fn schema_default_is_compact_and_complete() {
    // schema needs no pack — must work even on a bare checkout.
    let (code, text, stderr) = run_raw(&["schema"]);
    assert_eq!(code, 0, "stderr: {stderr}");
    // Budget gate. On breach, re-curate the /// doc comments in
    // crates/engine/src/config.rs (move maintainer-only lore down into
    // adjacent // comments); never truncate mechanically in the renderer.
    assert!(
        text.len() <= 7 * 1024,
        "compact schema doc grew past 7KB budget: {} bytes",
        text.len()
    );
    // Field-inventory drift guard — what makes the generated route safe:
    // every object def and every property of the real schemars schema
    // must surface in the compact rendering.
    let full =
        serde_json::to_value(schemars::schema_for!(stm32ck_engine::config::ConfigDoc)).unwrap();
    let mut objects: Vec<&Value> = vec![&full];
    for (name, def) in full["$defs"].as_object().unwrap() {
        if def.get("properties").is_some() {
            assert!(
                text.contains(&format!("\n{name}")),
                "compact schema lost object def {name}"
            );
            objects.push(def);
        }
    }
    for node in objects {
        for prop in node["properties"].as_object().unwrap().keys() {
            assert!(
                text.contains(&format!("\n  {prop}: ")) || text.contains(&format!("\n  {prop}?: ")),
                "compact schema lost field {prop}"
            );
        }
    }
    // Load-bearing tokens, each backed by eval or kernel evidence.
    for tok in [
        "-<RefMode>",
        "-CH<n>",
        "halTimebase",
        "reserved",
        "sharedWith",
        "PIN_CONFLICT",
        "\"crystal\"|\"bypass\"",
        "RCC_SYSCLKSOURCE_PLLCLK",
        "HSI/LSI need no declaration",
        "schema --full",
    ] {
        assert!(text.contains(tok), "compact schema lost load-bearing token {tok}");
    }
    // The default output is a text document, not JSON.
    assert!(serde_json::from_str::<serde_json::Value>(&text).is_err());
}

#[test]
fn schema_default_is_deterministic() {
    let (code_a, a, _) = run_raw(&["schema"]);
    let (code_b, b, _) = run_raw(&["schema"]);
    assert_eq!(code_a, 0);
    assert_eq!(code_b, 0);
    assert!(a == b, "schema output differs between two identical runs");
}
