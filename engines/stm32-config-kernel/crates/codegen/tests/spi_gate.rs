//! SPI compile gate (audit §二-1/4/6): SPI master projects on F103 and
//! F411 must generate AND build with the real arm-none-eabi toolchain,
//! zero manual patches — the audit found the HAL module wiring missing
//! (no HAL_SPI_MODULE_ENABLED / include / hal_spi.c / CMake entry).
//! Also asserts the CubeMX-matching GPIO speed preset (F1 SCK: FREQ_HIGH),
//! the hardware-NSS register value, and the I2C explicit-zero + handle-name
//! fixes. Mirrors compile_gate.rs skip logic.

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

/// Pack + firmware + toolchain present, else None (skip).
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

fn f103_spi_doc(modes: &str) -> ConfigDoc {
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
              "params": {{ "BaudRatePrescaler": "SPI_BAUDRATEPRESCALER_16" }},
              "pins": {{ "SCK": "PA5", "MISO": "PA6", "MOSI": "PA7" }}
            }}
          }},
          "gpio": {{ "PC13": {{ "mode": "output", "label": "LED" }} }}
        }}"#
    ))
    .unwrap()
}

fn f411_spi_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F411CEUx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 25000000 } },
            "targets": { "SYSCLK": { "hz": 100000000 } }
          },
          "peripherals": {
            "SPI1": {
              "mode": "Full_Duplex_Master",
              "pins": { "SCK": "PA5", "MISO": "PA6", "MOSI": "PA7" }
            }
          },
          "gpio": { "PC13": { "mode": "output", "label": "LED" } }
        }"#,
    )
    .unwrap()
}

fn f103_i2c_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F103C8Tx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "targets": { "SYSCLK": { "hz": 72000000 } }
          },
          "peripherals": {
            "I2C1": {
              "mode": "I2C",
              "pins": { "SCL": "PB6", "SDA": "PB7" }
            }
          }
        }"#,
    )
    .unwrap()
}

/// Validate + generate into a wiped `out_dir`.
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

#[test]
fn f103_spi_master_project_compiles() {
    let Some((pack, fw_dir)) = prerequisites("stm32f1.irpack", "STM32F1") else { return };
    let doc = f103_spi_doc(r#""Full_Duplex_Master""#);
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("spi_gate_f103");
    generate(&pack, &doc, &fw_dir, &out_dir);

    // HAL module wiring: all four surfaces (audit §二-1).
    let conf = read(&out_dir, "Core/Inc/stm32f1xx_hal_conf.h");
    assert!(conf.contains("#define HAL_SPI_MODULE_ENABLED"), "conf:\n{conf}");
    assert!(conf.contains("#include \"stm32f1xx_hal_spi.h\""));
    // Include order: DMA before SPI (SPI_HandleTypeDef.hdmarx needs the
    // complete DMA_HandleTypeDef).
    let dma_inc = conf.find("#include \"stm32f1xx_hal_dma.h\"").expect("dma include");
    let spi_inc = conf.find("#include \"stm32f1xx_hal_spi.h\"").expect("spi include");
    assert!(dma_inc < spi_inc, "DMA include must precede SPI include");
    let cmake = read(&out_dir, "CMakeLists.txt");
    assert!(cmake.contains("stm32f1xx_hal_spi.c"), "cmake:\n{cmake}");
    assert!(
        out_dir
            .join("Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_spi.c")
            .is_file(),
        "hal_spi.c must be copied"
    );

    // Init call + master fields from defaults-on-blackboard (spi.c since
    // the file split; main.c only calls MX_SPI1_Init).
    let main_c = read(&out_dir, "Core/Src/spi.c");
    assert!(main_c.contains("SPI_HandleTypeDef hspi1;"), "spi.c:\n{main_c}");
    let spi_h = read(&out_dir, "Core/Inc/spi.h");
    assert!(spi_h.contains("void MX_SPI1_Init(void);"), "spi.h:\n{spi_h}");
    assert!(spi_h.contains("extern SPI_HandleTypeDef hspi1;"));
    let top = read(&out_dir, "Core/Src/main.c");
    assert!(top.contains("#include \"spi.h\""), "main.c:\n{top}");
    assert!(top.contains("MX_SPI1_Init();"));
    assert!(main_c.contains("hspi1.Instance = SPI1;"));
    assert!(main_c.contains("hspi1.Init.Mode = SPI_MODE_MASTER;"));
    assert!(main_c.contains("hspi1.Init.Direction = SPI_DIRECTION_2LINES;"));
    assert!(main_c.contains("hspi1.Init.DataSize = SPI_DATASIZE_8BIT;"));
    assert!(main_c.contains("hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;"));
    assert!(main_c.contains("hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;"));
    assert!(main_c.contains("hspi1.Init.NSS = SPI_NSS_SOFT;"));
    assert!(main_c.contains("hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16;"));
    assert!(main_c.contains("hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;"));
    assert!(main_c.contains("hspi1.Init.TIMode = SPI_TIMODE_DISABLE;"));
    assert!(main_c.contains("if (HAL_SPI_Init(&hspi1) != HAL_OK)"));

    // GPIO speed preset (audit §二-4): F1 SPI SCK/MOSI are AF-PP at the
    // high-speed default, exactly as CubeMX emits.
    let msp = read(&out_dir, "Core/Src/spi.c");
    assert!(msp.contains("GPIO_InitStruct.Pin = GPIO_PIN_5|GPIO_PIN_7;"), "msp:\n{msp}");
    assert!(msp.contains("GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;"));
    assert!(msp.contains("__HAL_RCC_SPI1_CLK_ENABLE();"));

    build(&out_dir);
}

#[test]
fn f103_spi_hardware_nss_emits_hard_output() {
    let Some((pack, fw_dir)) = prerequisites("stm32f1.irpack", "STM32F1") else { return };
    let doc = f103_spi_doc(r#"["Full_Duplex_Master", "NSS_Signal_Hard_Output"]"#);
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("spi_gate_f103_nss");
    generate(&pack, &doc, &fw_dir, &out_dir);

    // Audit §二-2: hardware NSS silently emitted SPI_NSS_SOFT before.
    let main_c = read(&out_dir, "Core/Src/spi.c");
    assert!(
        main_c.contains("hspi1.Init.NSS = SPI_NSS_HARD_OUTPUT;"),
        "main.c:\n{main_c}"
    );
    build(&out_dir);
}

#[test]
fn f411_spi_master_project_compiles() {
    let Some((pack, fw_dir)) = prerequisites("stm32f4.irpack", "STM32F4") else { return };
    let doc = f411_spi_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("spi_gate_f411");
    generate(&pack, &doc, &fw_dir, &out_dir);

    let conf = read(&out_dir, "Core/Inc/stm32f4xx_hal_conf.h");
    assert!(conf.contains("#define HAL_SPI_MODULE_ENABLED"), "conf:\n{conf}");
    let dma_inc = conf.find("#include \"stm32f4xx_hal_dma.h\"").expect("dma include");
    let spi_inc = conf.find("#include \"stm32f4xx_hal_spi.h\"").expect("spi include");
    assert!(dma_inc < spi_inc, "DMA include must precede SPI include (F4 audit)");

    let main_c = read(&out_dir, "Core/Src/spi.c");
    assert!(main_c.contains("hspi1.Init.Mode = SPI_MODE_MASTER;"), "spi.c:\n{main_c}");
    assert!(main_c.contains("if (HAL_SPI_Init(&hspi1) != HAL_OK)"));

    // F4 AF path: SCK gets the AF macro and the high-speed default.
    let msp = read(&out_dir, "Core/Src/spi.c");
    assert!(msp.contains("GPIO_AF5_SPI1"), "msp:\n{msp}");
    assert!(msp.contains("GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;"));

    build(&out_dir);
}

#[test]
fn f103_i2c_handle_name_and_explicit_zero() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc = f103_i2c_doc();
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "diags: {:?}", resolved.diags);
    let ctx = stm32ck_codegen::GenCtx {
        pack: &pack,
        resolved: &resolved,
        doc: &doc,
        kernel_version: "0.0.0-test",
        fw: None,
    };
    let files: std::collections::BTreeMap<String, String> =
        stm32ck_codegen::emit::emit_all(&ctx)
            .expect("emit_all")
            .into_iter()
            .map(|f| (f.rel_path, f.content))
            .collect();
    let main_c = &files["Core/Src/i2c.c"];

    // Audit §二-3: instance digits must be the trailing run ("hi2c1", not
    // "hi2c21").
    assert!(main_c.contains("I2C_HandleTypeDef hi2c1;"), "i2c.c:\n{main_c}");
    assert!(!main_c.contains("hi2c21"));
    assert!(main_c.contains("hi2c1.Instance = I2C1;"));
    // Audit §二-6: integer fields with empty defaults get an explicit 0.
    assert!(main_c.contains("hi2c1.Init.OwnAddress1 = 0;"));
    assert!(main_c.contains("if (HAL_I2C_Init(&hi2c1) != HAL_OK)"));

    // AF open-drain wiring stays intact.
    let msp = &files["Core/Src/i2c.c"];
    assert!(msp.contains("GPIO_MODE_AF_OD"), "msp:\n{msp}");
}
