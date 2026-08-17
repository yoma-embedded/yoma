//! ADC auto-activated-RefMode gate (plan §P2): the ODrive ADC1 shape —
//! regular ADC_CHANNEL_6 rank 1 + injected ADC_CHANNEL_6 triggered by
//! T1_TRGO rising — on STM32F405RGTx. `ChannelRegularConversion` /
//! `ChannelInjectedConversion` / `ADC_Settings` are NOT mode-tree leaves:
//! they auto-activate from the `-{RefModeName}` suffix params and the bare
//! ADC settings, and the generated MX_ADC1_Init must match the CubeMX
//! reference (`odrive_cubemx_demo/Src/adc.c`). Mirrors spi_gate skip logic.

use std::path::{Path, PathBuf};
use std::process::Command;
use stm32ck_codegen::generate_project;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_pack(name: &str) -> Option<IrPack> {
    let path = repo_root().join("data").join(name);
    if !path.is_file() {
        eprintln!("skip: {} not present (run the importer first)", path.display());
        return None;
    }
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn tool_available(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn prerequisites(pack_name: &str, fw_family: &str) -> Option<(IrPack, PathBuf)> {
    let pack = load_pack(pack_name)?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join(fw_family).is_dir() {
        eprintln!("skip: firmware components not present under {}", fw_dir.display());
        return None;
    }
    for tool in ["arm-none-eabi-gcc", "cmake", "ninja"] {
        if !tool_available(tool) {
            eprintln!("skip: `{tool}` not found on PATH");
            return None;
        }
    }
    Some((pack, fw_dir))
}

/// ODrive's ADC1 (tests/parity/odrive/odrive.json), reduced to the one
/// channel the gate asserts (IN6 = PA6 "VBUS_S").
fn f405_adc1_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "targets": { "SYSCLK": { "hz": 168000000 } }
          },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6"],
              "params": {
                "ClockPrescaler": "ADC_CLOCK_SYNC_PCLK_DIV4",
                "Resolution": "ADC_RESOLUTION_12B",
                "DataAlign": "ADC_DATAALIGN_RIGHT",
                "ScanConvMode": "DISABLE",
                "ContinuousConvMode": "DISABLE",
                "DiscontinuousConvMode": "DISABLE",
                "DMAContinuousRequests": "DISABLE",
                "EOCSelection": "ADC_EOC_SINGLE_CONV",
                "NbrOfConversion": 1,
                "ExternalTrigConv": "ADC_SOFTWARE_START",
                "ExternalTrigConvEdge": "ADC_EXTERNALTRIGCONVEDGE_NONE",
                "InjNumberOfConversion": 1,
                "InjectedConvMode": "None",
                "ExternalTrigInjecConv": "ADC_EXTERNALTRIGINJECCONV_T1_TRGO",
                "ExternalTrigInjecConvEdge": "ADC_EXTERNALTRIGINJECCONVEDGE_RISING",
                "Channel-ChannelRegularConversion": "ADC_CHANNEL_6",
                "Rank-ChannelRegularConversion": 1,
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_3CYCLES",
                "Channel-ChannelInjectedConversion": "ADC_CHANNEL_6",
                "InjectedRank-ChannelInjectedConversion": 1,
                "SamplingTime-ChannelInjectedConversion": "ADC_SAMPLETIME_3CYCLES",
                "InjectedOffset-ChannelInjectedConversion": 0
              },
              "pins": { "IN6": "PA6" },
              "nvic": { "enabled": true, "preemptionPriority": 5 }
            }
          }
        }"#,
    )
    .unwrap()
}

fn generate(pack: &IrPack, doc: &ConfigDoc, fw_dir: &Path, out_dir: &Path) {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir).unwrap();
    }
    std::fs::create_dir_all(out_dir).unwrap();
    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "config must validate clean");
    let manifest = generate_project(pack, &resolved, doc, fw_dir, out_dir, "0.1.0")
        .expect("generate_project");
    assert!(!manifest.files.is_empty());
}

fn run(cwd: &Path, program: &str, args: &[&str]) {
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn `{program}`: {e}"));
    if !out.status.success() {
        panic!(
            "`{program} {}` failed with {} in {}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            args.join(" "),
            out.status,
            cwd.display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

fn build(out_dir: &Path) {
    run(
        out_dir,
        "cmake",
        &[
            "-G",
            "Ninja",
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_TOOLCHAIN_FILE=cmake/gcc-arm-none-eabi.cmake",
            "-B",
            "build",
        ],
    );
    run(out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("app.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}

fn read(out_dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(out_dir.join(rel))
        .unwrap_or_else(|e| panic!("missing {rel}: {e}"))
}

/// Three-rank regular sequence: one sConfig block per rank in IN order with
/// ascending Rank, equal-value elision on SamplingTime (rank 2+ assign only
/// Channel/Rank — the motor_demo G473 reference shape), NbrOfConversion=3,
/// scan mode on, and the whole thing still compiles.
#[test]
fn f405_adc1_three_rank_sequence_matches_cubemx_shape() {
    let Some((pack, fw_dir)) = prerequisites("stm32f4.irpack", "STM32F4") else { return };
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "targets": { "SYSCLK": { "hz": 168000000 } }
          },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6", "IN7", "IN8"],
              "params": {
                "ClockPrescaler": "ADC_CLOCK_SYNC_PCLK_DIV4",
                "ScanConvMode": "ENABLE",
                "NbrOfConversion": 3,
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_3CYCLES"
              },
              "pins": { "IN6": "PA6", "IN7": "PA7", "IN8": "PB0" }
            }
          }
        }"#,
    )
    .unwrap();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("adc_gate_f405_ranks");
    generate(&pack, &doc, &fw_dir, &out_dir);

    let adc_c = read(&out_dir, "Core/Src/adc.c");
    for line in [
        "hadc1.Init.ScanConvMode = ENABLE;",
        "hadc1.Init.NbrOfConversion = 3;",
    ] {
        assert!(adc_c.contains(line), "adc.c missing `{line}`:\n{adc_c}");
    }
    assert_eq!(
        adc_c.matches("if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)").count(),
        3,
        "one guarded ConfigChannel call per rank:\n{adc_c}"
    );
    assert_eq!(
        adc_c.matches("ADC_ChannelConfTypeDef sConfig = {0};").count(),
        1,
        "sConfig declared once:\n{adc_c}"
    );
    assert_eq!(
        adc_c.matches("sConfig.SamplingTime").count(),
        1,
        "equal-value elision: SamplingTime assigned on rank 1 only:\n{adc_c}"
    );
    // Ranks in IN order, each Channel before its Rank, strictly ascending.
    let pos = |needle: &str| {
        adc_c
            .find(needle)
            .unwrap_or_else(|| panic!("adc.c missing `{needle}`:\n{adc_c}"))
    };
    let seq = [
        pos("sConfig.Channel = ADC_CHANNEL_6;"),
        pos("sConfig.Rank = 1;"),
        pos("sConfig.Channel = ADC_CHANNEL_7;"),
        pos("sConfig.Rank = 2;"),
        pos("sConfig.Channel = ADC_CHANNEL_8;"),
        pos("sConfig.Rank = 3;"),
    ];
    assert!(
        seq.windows(2).all(|w| w[0] < w[1]),
        "rank blocks out of order (positions {seq:?}):\n{adc_c}"
    );

    build(&out_dir);
}

/// G4 spells Rank as ADC_REGULAR_RANK_n (CubeMX common.ftl Bz40086 family
/// branch — F0/L0/F2/F4 keep the bare integer, everyone else wraps it) and
/// scan mode as ADC_SCAN_ENABLE. The motor_demo G473 reference is the
/// ground truth for this shape.
#[test]
fn g473_adc1_multi_rank_macro_spelling() {
    let Some((pack, fw_dir)) = prerequisites("stm32g4.irpack", "STM32G4") else { return };
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32G473RCTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } }
          },
          "peripherals": {
            "ADC1": {
              "mode": ["IN1-Single-Ended", "IN6-Single-Ended", "IN7-Single-Ended"],
              "params": {
                "ScanConvMode": "ADC_SCAN_ENABLE",
                "NbrOfConversion": 3,
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_47CYCLES_5"
              },
              "pins": { "IN1": "PA0", "IN6": "PC0", "IN7": "PC1" }
            }
          }
        }"#,
    )
    .unwrap();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("adc_gate_g473_ranks");
    generate(&pack, &doc, &fw_dir, &out_dir);

    let adc_c = read(&out_dir, "Core/Src/adc.c");
    for line in [
        "hadc1.Init.ScanConvMode = ADC_SCAN_ENABLE;",
        "hadc1.Init.NbrOfConversion = 3;",
        "sConfig.Rank = ADC_REGULAR_RANK_1;",
        "sConfig.Rank = ADC_REGULAR_RANK_2;",
        "sConfig.Rank = ADC_REGULAR_RANK_3;",
        "sConfig.Channel = ADC_CHANNEL_1;",
        "sConfig.Channel = ADC_CHANNEL_6;",
        "sConfig.Channel = ADC_CHANNEL_7;",
    ] {
        assert!(adc_c.contains(line), "adc.c missing `{line}`:\n{adc_c}");
    }
    assert!(
        !adc_c.contains("sConfig.Rank = 1;"),
        "bare integer rank must not appear on G4:\n{adc_c}"
    );
    build(&out_dir);
}

#[test]
fn f405_adc1_regular_plus_injected_matches_reference_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites("stm32f4.irpack", "STM32F4") else { return };
    let doc = f405_adc1_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("adc_gate_f405");
    generate(&pack, &doc, &fw_dir, &out_dir);

    let main_c = read(&out_dir, "Core/Src/adc.c");
    // hadc1.Init fields, in the CubeMX order + values.
    for line in [
        "ADC_HandleTypeDef hadc1;",
        "hadc1.Instance = ADC1;",
        "hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;",
        "hadc1.Init.Resolution = ADC_RESOLUTION_12B;",
        "hadc1.Init.ScanConvMode = DISABLE;",
        "hadc1.Init.ContinuousConvMode = DISABLE;",
        "hadc1.Init.DiscontinuousConvMode = DISABLE;",
        "hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;",
        "hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;",
        "hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;",
        "hadc1.Init.NbrOfConversion = 1;",
        "hadc1.Init.DMAContinuousRequests = DISABLE;",
        "hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;",
        "if (HAL_ADC_Init(&hadc1) != HAL_OK)",
        // Regular conversion (auto-activated ChannelRegularConversion).
        "ADC_ChannelConfTypeDef sConfig = {0};",
        "sConfig.Channel = ADC_CHANNEL_6;",
        "sConfig.Rank = 1;",
        "sConfig.SamplingTime = ADC_SAMPLETIME_3CYCLES;",
        "if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)",
        // Injected conversion (auto-activated ChannelInjectedConversion).
        "ADC_InjectionConfTypeDef sConfigInjected = {0};",
        "sConfigInjected.InjectedChannel = ADC_CHANNEL_6;",
        "sConfigInjected.InjectedRank = 1;",
        "sConfigInjected.InjectedNbrOfConversion = 1;",
        "sConfigInjected.InjectedSamplingTime = ADC_SAMPLETIME_3CYCLES;",
        "sConfigInjected.ExternalTrigInjecConvEdge = ADC_EXTERNALTRIGINJECCONVEDGE_RISING;",
        "sConfigInjected.ExternalTrigInjecConv = ADC_EXTERNALTRIGINJECCONV_T1_TRGO;",
        "sConfigInjected.AutoInjectedConv = DISABLE;",
        "sConfigInjected.InjectedDiscontinuousConvMode = DISABLE;",
        "sConfigInjected.InjectedOffset = 0;",
        "if (HAL_ADCEx_InjectedConfigChannel(&hadc1, &sConfigInjected) != HAL_OK)",
    ] {
        assert!(main_c.contains(line), "main.c missing `{line}`:\n{main_c}");
    }
    // Init before regular before injected, matching the reference order.
    let init = main_c.find("HAL_ADC_Init(&hadc1)").unwrap();
    let reg = main_c.find("HAL_ADC_ConfigChannel(&hadc1").unwrap();
    let inj = main_c.find("HAL_ADCEx_InjectedConfigChannel(&hadc1").unwrap();
    assert!(init < reg && reg < inj, "call order must be Init/regular/injected");

    // MSP: clock enable + PA6 analog GPIO, ADC IRQ enable.
    let msp = read(&out_dir, "Core/Src/adc.c");
    for line in [
        "void HAL_ADC_MspInit(ADC_HandleTypeDef* adcHandle)",
        "__HAL_RCC_ADC1_CLK_ENABLE();",
        "GPIO_InitStruct.Pin = GPIO_PIN_6;",
        "GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;",
        "GPIO_InitStruct.Pull = GPIO_NOPULL;",
        "HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);",
        "HAL_NVIC_SetPriority(ADC_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(ADC_IRQn);",
    ] {
        assert!(msp.contains(line), "msp missing `{line}`:\n{msp}");
    }

    // it.c: shared-vector shorthand record dispatches on the configured
    // ADC's handle only.
    let it_c = read(&out_dir, "Core/Src/stm32f4xx_it.c");
    assert!(it_c.contains("extern ADC_HandleTypeDef hadc1;"), "it.c:\n{it_c}");
    assert!(it_c.contains("HAL_ADC_IRQHandler(&hadc1);"));

    // HAL module wiring for ADC.
    let conf = read(&out_dir, "Core/Inc/stm32f4xx_hal_conf.h");
    assert!(conf.contains("#define HAL_ADC_MODULE_ENABLED"));

    build(&out_dir);
}
