//! ODrive parity gate — P4 progress cut (plan §P7 will lift the remaining
//! restrictions): the hand-converted odrive.json, stripped ONLY of the
//! middleware section (freertos + usbDevice, P5/P6) and the USB_OTG_FS
//! peripheral (P6), with project.halTimebase KEPT, must
//!
//! * validate CLEAN (pin stacking PA0/PA1 + shared analog pads now legal),
//! * generate a project whose Core/Src file SET equals the reference
//!   project's Src/*.c minus the middleware-owned files,
//! * compile + link with arm-gcc.

use std::collections::BTreeSet;
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

fn prerequisites() -> Option<(IrPack, PathBuf)> {
    let pack = load_pack("stm32f4.irpack")?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F4").is_dir() {
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

/// odrive.json with the not-yet-implemented middleware layers stripped:
/// remove `middleware.*` (P5 freertos / P6 usbDevice) and the USB_OTG_FS
/// peripheral (P6). EVERYTHING else — halTimebase, pin stacking, NVIC
/// fine-graining, initOrder — stays.
fn stripped_odrive_doc() -> ConfigDoc {
    let path = repo_root().join("tests/parity/odrive/odrive.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let obj = v.as_object_mut().unwrap();
    assert!(
        obj.remove("middleware").is_some(),
        "odrive.json is expected to carry the middleware section (P5/P6 target)"
    );
    let periphs = obj.get_mut("peripherals").unwrap().as_object_mut().unwrap();
    assert!(
        periphs.remove("USB_OTG_FS").is_some(),
        "odrive.json is expected to configure USB_OTG_FS (P6 target)"
    );
    serde_json::from_value(v).unwrap()
}

fn run(cwd: &Path, program: &str, args: &[&str]) {
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("spawn {program}: {e}"));
    assert!(
        out.status.success(),
        "{program} {args:?} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn odrive_p4_structural_parity() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = stripped_odrive_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("parity_gate_odrive");
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).unwrap();
    }
    std::fs::create_dir_all(&out_dir).unwrap();

    // ---- full validation must be CLEAN (no errors) -------------------------
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(
        !has_errors(&resolved.diags),
        "stripped ODrive draft must validate clean"
    );
    // The stacked pads must be reported (info) — PA0 and PA1.
    let shared: Vec<&str> = resolved
        .diags
        .iter()
        .filter(|d| d.code == "PIN_SHARED")
        .map(|d| d.path.as_str())
        .collect();
    assert!(
        shared.contains(&"/pinout/PA0") && shared.contains(&"/pinout/PA1"),
        "expected PIN_SHARED infos for PA0+PA1, got {shared:?}"
    );

    // ---- generate ------------------------------------------------------------
    let manifest = generate_project(&pack, &resolved, &doc, &fw_dir, &out_dir, "0.1.0")
        .expect("generate_project");
    assert!(!manifest.files.is_empty());

    // ---- file-set parity: Core/Src names == reference Src/*.c minus the
    //      middleware-owned files (freertos + the four usb files) ------------
    let generated: BTreeSet<String> = manifest
        .files
        .iter()
        .filter_map(|f| f.strip_prefix("Core/Src/"))
        .filter(|f| f.ends_with(".c"))
        .map(String::from)
        .collect();
    let expected: BTreeSet<String> = [
        "adc.c",
        "can.c",
        "dma.c",
        "gpio.c",
        "main.c",
        "spi.c",
        "stm32f4xx_hal_msp.c",
        "stm32f4xx_hal_timebase_tim.c",
        "stm32f4xx_it.c",
        "syscalls.c",
        "sysmem.c",
        "system_stm32f4xx.c",
        "tim.c",
        "usart.c",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(
        generated, expected,
        "generated Core/Src file set must match the reference minus middleware"
    );

    // Cross-check the expectation against the actual reference tree when it
    // is present on this machine: reference Src/*.c minus
    // {freertos.c, usb_device.c, usbd_cdc_if.c, usbd_conf.c, usbd_desc.c}.
    let reference_src = PathBuf::from("D:/embedded_agent/motorcontrol/odrive_cubemx_demo/Src");
    if reference_src.is_dir() {
        let mw_owned = [
            "freertos.c",
            "usb_device.c",
            "usbd_cdc_if.c",
            "usbd_conf.c",
            "usbd_desc.c",
        ];
        let ref_set: BTreeSet<String> = std::fs::read_dir(&reference_src)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".c") && !mw_owned.contains(&n.as_str()))
            .collect();
        assert_eq!(
            generated, ref_set,
            "generated set must equal the live reference Src listing minus middleware"
        );
    } else {
        eprintln!("note: CubeMX reference Src/ not present; skipped live cross-check");
    }

    // ---- structural spot checks --------------------------------------------
    let main_c = std::fs::read_to_string(out_dir.join("Core/Src/main.c")).unwrap();
    // Reference init-call order via project.initOrder.
    let mut last = 0usize;
    for call in [
        "MX_GPIO_Init();",
        "MX_DMA_Init();",
        "MX_ADC1_Init();",
        "MX_ADC2_Init();",
        "MX_CAN1_Init();",
        "MX_TIM1_Init();",
        "MX_TIM8_Init();",
        "MX_TIM3_Init();",
        "MX_TIM4_Init();",
        "MX_SPI3_Init();",
        "MX_ADC3_Init();",
        "MX_TIM2_Init();",
        "MX_UART4_Init();",
        "MX_TIM5_Init();",
        "MX_TIM13_Init();",
    ] {
        let pos = main_c.find(call).unwrap_or_else(|| panic!("main.c missing {call}"));
        assert!(pos > last, "init call {call} out of order");
        last = pos;
    }
    // Timebase: callback in main.c, TICK_INT_PRIORITY 0U, shared handler.
    assert!(main_c.contains("void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)"));
    assert!(main_c.contains("if (htim->Instance == TIM14)"));
    let conf = std::fs::read_to_string(out_dir.join("Core/Inc/stm32f4xx_hal_conf.h")).unwrap();
    assert!(conf.contains("#define  TICK_INT_PRIORITY            0U"));
    let it_c = std::fs::read_to_string(out_dir.join("Core/Src/stm32f4xx_it.c")).unwrap();
    assert!(it_c.contains("void TIM8_TRG_COM_TIM14_IRQHandler(void)"), "it.c:\n{it_c}");
    assert!(it_c.contains("HAL_TIM_IRQHandler(&htim8);"));
    assert!(it_c.contains("HAL_TIM_IRQHandler(&htim14);"));
    let tb8 = it_c.find("HAL_TIM_IRQHandler(&htim8);").unwrap();
    let tb14 = it_c.find("HAL_TIM_IRQHandler(&htim14);").unwrap();
    assert!(tb8 < tb14, "timebase handle dispatches last (reference order)");
    // Vectors with generateHandler=false stay out of it.c.
    assert!(!it_c.contains("TIM1_UP_TIM10_IRQHandler"), "it.c:\n{it_c}");
    assert!(!it_c.contains("TIM8_UP_TIM13_IRQHandler"), "it.c:\n{it_c}");
    assert!(!it_c.contains("DMA2_Stream0_IRQHandler"), "it.c:\n{it_c}");
    // Pin stacking: UART4 MspInit owns the PA0/PA1 pads via the gpio labels
    // (pull merged from the gpio entries), gpio.c does not touch them.
    let usart_c = std::fs::read_to_string(out_dir.join("Core/Src/usart.c")).unwrap();
    assert!(usart_c.contains("GPIO_InitStruct.Pin = GPIO_1_Pin;"), "usart.c:\n{usart_c}");
    assert!(usart_c.contains("GPIO_InitStruct.Pull = GPIO_PULLDOWN;"));
    assert!(usart_c.contains("GPIO_InitStruct.Pin = GPIO_2_Pin;"));
    let gpio_c = std::fs::read_to_string(out_dir.join("Core/Src/gpio.c")).unwrap();
    assert!(!gpio_c.contains("GPIO_1_Pin"), "stacked PA0 must not be re-inited:\n{gpio_c}");
    assert!(!gpio_c.contains("GPIO_2_Pin"), "stacked PA1 must not be re-inited:\n{gpio_c}");

    // ---- compile ---------------------------------------------------------------
    run(
        &out_dir,
        "cmake",
        &["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug"],
    );
    run(&out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("odrive_cubemx_demo.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}
