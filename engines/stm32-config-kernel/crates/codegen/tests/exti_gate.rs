//! End-to-end EXTI gate: the golden F103 project plus a PA0 EXTI rising
//! pin (label BTN, NVIC enabled) must emit the NVIC enable in gpio.c, the
//! EXTI0 IRQ handler in stm32f1xx_it.c, and build cleanly with the real
//! arm-none-eabi toolchain via cmake + ninja. Skips (with an eprintln) when
//! the IR pack, the firmware components, or the cross toolchain are not
//! available (mirrors compile_gate.rs).

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

/// Golden config plus a PA0 EXTI rising-edge button with NVIC enabled.
fn exti_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
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
          "gpio": {
            "PA0": {
              "mode": "exti",
              "trigger": "rising",
              "pull": "down",
              "label": "BTN",
              "nvic": { "enabled": true }
            },
            "PC13": { "mode": "output", "initHigh": true, "label": "LED" }
          }
        }"#,
    )
    .unwrap()
}

fn tool_available(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Common gate: pack + firmware + toolchain present, else None (skip).
fn prerequisites() -> Option<(IrPack, PathBuf)> {
    let pack = load_pack("stm32f1.irpack")?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F1").is_dir() {
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

/// Validate the doc and generate the full project into `out_dir` (wiped
/// first so stale files from previous runs cannot mask breakage).
fn generate(pack: &IrPack, doc: &ConfigDoc, fw_dir: &Path, out_dir: &Path) -> Vec<String> {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir).unwrap();
    }
    std::fs::create_dir_all(out_dir).unwrap();

    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "exti config must be clean");

    let manifest = generate_project(pack, &resolved, doc, fw_dir, out_dir, "0.1.0")
        .expect("generate_project");
    assert!(!manifest.files.is_empty());
    manifest.files
}

/// Run one command in `cwd`; panic with full stdout/stderr on failure.
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

#[test]
fn f103_exti_project_emits_nvic_and_handler_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = exti_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("exti_gate_f103");
    generate(&pack, &doc, &fw_dir, &out_dir);

    // gpio.c: PA0 configured as rising-edge EXTI, NVIC enabled at the end
    // of MX_GPIO_Init.
    let gpio_c = std::fs::read_to_string(out_dir.join("Core/Src/gpio.c")).unwrap();
    assert!(
        gpio_c.contains("GPIO_InitStruct.Mode = GPIO_MODE_IT_RISING;"),
        "gpio.c:\n{gpio_c}"
    );
    assert!(gpio_c.contains("/* EXTI interrupt init*/"), "gpio.c:\n{gpio_c}");
    assert!(
        gpio_c.contains("HAL_NVIC_SetPriority(EXTI0_IRQn, 0, 0);"),
        "gpio.c:\n{gpio_c}"
    );
    assert!(
        gpio_c.contains("HAL_NVIC_EnableIRQ(EXTI0_IRQn);"),
        "gpio.c:\n{gpio_c}"
    );

    // it.c: EXTI0 handler dispatching to the HAL with the labeled pin macro.
    let it_c = std::fs::read_to_string(out_dir.join("Core/Src/stm32f1xx_it.c")).unwrap();
    assert!(it_c.contains("void EXTI0_IRQHandler(void)"), "it.c:\n{it_c}");
    assert!(
        it_c.contains("HAL_GPIO_EXTI_IRQHandler(BTN_Pin);"),
        "it.c:\n{it_c}"
    );
    let it_h = std::fs::read_to_string(out_dir.join("Core/Inc/stm32f1xx_it.h")).unwrap();
    assert!(it_h.contains("void EXTI0_IRQHandler(void);"), "it.h:\n{it_h}");

    // main.h: label defines including the EXTI IRQn alias.
    let main_h = std::fs::read_to_string(out_dir.join("Core/Inc/main.h")).unwrap();
    assert!(main_h.contains("#define BTN_Pin GPIO_PIN_0"), "main.h:\n{main_h}");
    assert!(main_h.contains("#define BTN_GPIO_Port GPIOA"), "main.h:\n{main_h}");
    assert!(main_h.contains("#define BTN_EXTI_IRQn EXTI0_IRQn"), "main.h:\n{main_h}");

    // The full project must build with the real cross toolchain.
    run(
        &out_dir,
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
    run(&out_dir, "cmake", &["--build", "build"]);

    let elf = out_dir.join("build").join(format!("{}.elf", doc.project.name));
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
    for ext in ["hex", "bin"] {
        let img = out_dir.join("build").join(format!("{}.{ext}", doc.project.name));
        assert!(img.is_file(), "missing {ext} image at {}", img.display());
    }
}
