//! TIM channel-machinery gate (plan §P2): the ODrive TIM1 shape —
//! center-aligned CENTERALIGNED3, complementary PWM2 on CH1-3 + CH1N-3N,
//! OC4 no-output, dead time, TRGO update — on STM32F405RGTx must emit a
//! `MX_TIM1_Init` whose assignment set matches the CubeMX reference
//! (`odrive_cubemx_demo/Src/tim.c`) field for field, and the project must
//! compile with the real arm-none-eabi toolchain. Mirrors spi_gate skip
//! logic.

use std::collections::BTreeMap;
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

/// The ODrive TIM1 entry (tests/parity/odrive/odrive.json), with the OC4
/// pulse as a plain numeric literal (10) to exercise the non-symbolic path
/// alongside the userConstants one.
fn f405_tim1_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "targets": { "SYSCLK": { "hz": 168000000 } }
          },
          "peripherals": {
            "TIM1": {
              "mode": [
                "Internal",
                "PWM Generation1 CH1 CH1N",
                "PWM Generation2 CH2 CH2N",
                "PWM Generation3 CH3 CH3N",
                "Output Compare4 No Output"
              ],
              "params": {
                "CounterMode": "TIM_COUNTERMODE_CENTERALIGNED3",
                "Period": "TIM_1_8_PERIOD_CLOCKS",
                "RepetitionCounter": "TIM_1_8_RCR",
                "DeadTime": "TIM_1_8_DEADTIME_CLOCKS",
                "OffStateRunMode": "TIM_OSSR_ENABLE",
                "OffStateIDLEMode": "TIM_OSSI_ENABLE",
                "TIM_MasterOutputTrigger": "TIM_TRGO_UPDATE",
                "OCMode_PWM-CH1": "TIM_OCMODE_PWM2",
                "OCMode_PWM-CH2": "TIM_OCMODE_PWM2",
                "OCMode_PWM-CH3": "TIM_OCMODE_PWM2",
                "OCNPolarity-CH1": "TIM_OCNPOLARITY_HIGH",
                "OCNPolarity-CH2": "TIM_OCNPOLARITY_HIGH",
                "OCNPolarity-CH3": "TIM_OCNPOLARITY_HIGH",
                "Pulse-CH4": 10
              },
              "pins": {
                "CH1": "PA8", "CH2": "PA9", "CH3": "PA10",
                "CH1N": "PB13", "CH2N": "PB14", "CH3N": "PB15"
              }
            }
          },
          "project": {
            "name": "app",
            "userConstants": {
              "TIM_1_8_PERIOD_CLOCKS": "3500",
              "TIM_1_8_RCR": "2",
              "TIM_1_8_DEADTIME_CLOCKS": "20"
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

/// Extract the body of one function DEFINITION from C source (the
/// signature must be followed by its opening brace, so prototypes with a
/// trailing `;` never match).
fn fn_body<'a>(src: &'a str, signature: &str) -> &'a str {
    let mut from = 0;
    while let Some(pos) = src[from..].find(signature) {
        let start = from + pos;
        let line_end = src[start..]
            .find('\n')
            .map(|i| start + i)
            .unwrap_or(src.len());
        // A prototype's line ends in `;` — skip it, keep the definition.
        if !src[start..line_end].contains(';') {
            let rest = &src[start..];
            let end = rest.find("\n}").map(|i| i + 2).unwrap_or(rest.len());
            return &rest[..end];
        }
        from = line_end;
    }
    panic!("function definition `{signature}` not found");
}

/// All `lhs = rhs;` assignment statements in a function body (trimmed),
/// as a multiset (line -> count).
fn assignments(body: &str) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for line in body.lines() {
        let t = line.trim();
        if t.ends_with(';') && t.contains(" = ") && !t.starts_with("if") && !t.starts_with("/*") {
            *out.entry(t.to_string()).or_default() += 1;
        }
    }
    out
}

#[test]
fn f405_tim1_odrive_shape_matches_reference_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites("stm32f4.irpack", "STM32F4") else { return };
    let doc = f405_tim1_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("tim_gate_f405");
    generate(&pack, &doc, &fw_dir, &out_dir);

    let main_c = read(&out_dir, "Core/Src/tim.c");
    let body = fn_body(&main_c, "void MX_TIM1_Init(void)");

    // Local config structs declared once at function top.
    for local in [
        "TIM_ClockConfigTypeDef sClockSourceConfig = {0};",
        "TIM_MasterConfigTypeDef sMasterConfig = {0};",
        "TIM_OC_InitTypeDef sConfigOC = {0};",
        "TIM_BreakDeadTimeConfigTypeDef sBreakDeadTimeConfig = {0};",
    ] {
        assert_eq!(
            body.matches(local).count(),
            1,
            "local `{local}` must be declared exactly once:\n{body}"
        );
    }

    // Per-channel ConfigChannel calls, ascending, PWM 1..3 then OC 4.
    for call in [
        "HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_1)",
        "HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_2)",
        "HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_3)",
        "HAL_TIM_OC_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_4)",
        "HAL_TIMEx_ConfigBreakDeadTime(&htim1, &sBreakDeadTimeConfig)",
        "HAL_TIMEx_MasterConfigSynchronization(&htim1, &sMasterConfig)",
        "HAL_TIM_Base_Init(&htim1)",
        "HAL_TIM_ConfigClockSource(&htim1, &sClockSourceConfig)",
        "HAL_TIM_PWM_Init(&htim1)",
        "HAL_TIM_OC_Init(&htim1)",
    ] {
        assert!(body.contains(call), "missing `{call}` in:\n{body}");
    }
    let ch1 = body.find("TIM_CHANNEL_1)").unwrap();
    let ch2 = body.find("TIM_CHANNEL_2)").unwrap();
    let ch3 = body.find("TIM_CHANNEL_3)").unwrap();
    let ch4 = body.find("TIM_CHANNEL_4)").unwrap();
    assert!(ch1 < ch2 && ch2 < ch3 && ch3 < ch4, "channels must ascend");
    let bdt = body.find("HAL_TIMEx_ConfigBreakDeadTime").unwrap();
    assert!(ch4 < bdt, "BreakDeadTime comes after the channel configs");
    let master = body.find("HAL_TIMEx_MasterConfigSynchronization").unwrap();
    assert!(master < ch1, "MasterConfig comes before the channel configs");

    // Per-channel values: PWM2 for CH1-3, TIMING + literal pulse for CH4.
    assert!(body.contains("sConfigOC.OCMode = TIM_OCMODE_PWM2;"));
    assert!(body.contains("sConfigOC.OCMode = TIM_OCMODE_TIMING;"));
    assert!(body.contains("sConfigOC.Pulse = 0;"));
    assert!(body.contains("sConfigOC.Pulse = 10;"));
    assert!(body.contains("sBreakDeadTimeConfig.DeadTime = TIM_1_8_DEADTIME_CLOCKS;"));

    // Deferred AF pin init: PostInit call at the end of MX_TIM1_Init, and
    // the callback lives in the MSP file.
    assert!(body.contains("HAL_TIM_MspPostInit(&htim1);"), "body:\n{body}");
    let msp = read(&out_dir, "Core/Src/tim.c");
    assert!(msp.contains("void HAL_TIM_MspPostInit(TIM_HandleTypeDef* timHandle)"));
    let tim_h = read(&out_dir, "Core/Inc/tim.h");
    assert!(tim_h.contains("void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);"), "tim.h:
{tim_h}");
    assert!(msp.contains("GPIO_AF1_TIM1"), "msp:\n{msp}");
    // MspInit keeps only clock enable (pins moved to PostInit).
    let msp_init = fn_body(&msp, "void HAL_TIM_Base_MspInit");
    assert!(msp_init.contains("__HAL_RCC_TIM1_CLK_ENABLE();"));
    assert!(!msp_init.contains("HAL_GPIO_Init"), "TIM output pins belong to PostInit:\n{msp_init}");

    // userConstants emitted as #defines in main.h.
    let main_h = read(&out_dir, "Core/Inc/main.h");
    for def in [
        "#define TIM_1_8_PERIOD_CLOCKS 3500",
        "#define TIM_1_8_RCR 2",
        "#define TIM_1_8_DEADTIME_CLOCKS 20",
    ] {
        assert!(main_h.contains(def), "main.h missing `{def}`:\n{main_h}");
    }

    // Field-for-field against the CubeMX reference, when it is present on
    // this machine. Only intended config deltas may differ: our gate doc
    // sets Pulse-CH4 = 10 (reference leaves CH4 pulse at 0), which adds
    // exactly one extra `sConfigOC.Pulse = 10;` re-assignment.
    let reference = PathBuf::from("D:/embedded_agent/motorcontrol/odrive_cubemx_demo/Src/tim.c");
    if reference.is_file() {
        let ref_src = std::fs::read_to_string(&reference).unwrap();
        let ref_body = fn_body(&ref_src, "void MX_TIM1_Init(void)");
        let mut ours = assignments(body);
        let theirs = assignments(ref_body);
        // Remove the intended delta before comparing.
        let extra = ours.remove("sConfigOC.Pulse = 10;");
        assert_eq!(extra, Some(1), "expected exactly one CH4 pulse re-assign");
        assert_eq!(
            ours, theirs,
            "MX_TIM1_Init assignment set differs from the CubeMX reference"
        );
    } else {
        eprintln!("note: CubeMX reference tim.c not present; skipped field diff");
    }

    build(&out_dir);
}
