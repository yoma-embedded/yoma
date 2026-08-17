//! USB Device CDC middleware gate (P6) — standalone (no FreeRTOS) F405
//! configuration with the USB_OTG_FS peripheral + middleware.usbDevice
//! carrying the ODrive values. Verifies the generated glue against
//! middleware-gen-spec §4 and compiles + links the whole project (arm-gcc)
//! against the copied USB Device Library v2.11.6.
//!
//! Doc contract exercised here: the OTG_FS vector is configured through the
//! fine-grained `interrupts` map with `generateHandler: false` (the USB
//! middleware provides `OTG_FS_IRQHandler`; the engine's single-`nvic`
//! shorthand currently lands on OTG_FS_WKUP_IRQn — reported engine gap).

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

/// F405 + HSE 8 MHz PLL (the ODrive tree: 168 MHz SYSCLK, PLLQ=7 -> 48 MHz
/// USB) + USB_OTG_FS Device_Only + middleware.usbDevice CDC ODrive values.
fn usb_doc(with_freertos: bool) -> ConfigDoc {
    let freertos = if with_freertos {
        r#""freertos": {
            "api": "CMSIS_V1",
            "tasks": [
              { "name": "defaultTask", "priority": 0, "stackSize": 256,
                "entryFunction": "StartDefaultTask" }
            ]
          },"#
    } else {
        ""
    };
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "STM32F405RGTx" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            "assignments": {{
              "APB1CLKDivider": "RCC_HCLK_DIV4",
              "APB2CLKDivider": "RCC_HCLK_DIV2",
              "PLLM": 4,
              "PLLN": 168,
              "PLLP": "RCC_PLLP_DIV2",
              "PLLQ": 7,
              "PLLSourceVirtual": "RCC_PLLSOURCE_HSE",
              "SYSCLKSource": "RCC_SYSCLKSOURCE_PLLCLK"
            }}
          }},
          "peripherals": {{
            "USB_OTG_FS": {{
              "mode": "Device_Only",
              "params": {{ "vbus_sensing_enable": "DISABLE" }},
              "pins": {{ "DM": "PA11", "DP": "PA12" }},
              "interrupts": {{
                "OTG_FS_IRQn": {{
                  "enabled": true, "preemptionPriority": 5, "subPriority": 0,
                  "generateHandler": false
                }}
              }}
            }}
          }},
          "middleware": {{
            {freertos}
            "usbDevice": {{
              "class": "CDC",
              "vid": "0x1209",
              "pid": "0x0D32",
              "manufacturerString": "ODrive Robotics",
              "productString": "ODrive v3.3",
              "serialNumberString": "000000000001",
              "appRxDataSize": 64,
              "appTxDataSize": 64
            }}
          }},
          "project": {{ "name": "usb_gate" }}
        }}"#
    ))
    .unwrap()
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
    if !fw_dir.join("MW").join("USB_Device").is_dir() {
        eprintln!("skip: USB Device Library not present under {}", fw_dir.display());
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

fn read(out_dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(out_dir.join(rel))
        .unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

#[test]
fn usb_cdc_standalone_project_generates_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = usb_doc(false);
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("usb_gate_standalone");
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).unwrap();
    }
    std::fs::create_dir_all(&out_dir).unwrap();

    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "usb gate doc must validate clean");

    let manifest = generate_project(&pack, &resolved, &doc, &fw_dir, &out_dir, "0.1.0")
        .expect("generate_project");

    // ---- file inventory ----------------------------------------------------
    let files: BTreeSet<&str> = manifest.files.iter().map(String::as_str).collect();
    for expected in [
        "Core/Inc/usb_device.h",
        "Core/Src/usb_device.c",
        "Core/Inc/usbd_conf.h",
        "Core/Src/usbd_conf.c",
        "Core/Inc/usbd_desc.h",
        "Core/Src/usbd_desc.c",
        "Core/Inc/usbd_cdc_if.h",
        "Core/Src/usbd_cdc_if.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ctlreq.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ioreq.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Inc/usbd_def.h",
        "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Src/usbd_cdc.c",
        "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc/usbd_cdc.h",
    ] {
        assert!(files.contains(expected), "manifest missing {expected}");
    }

    // ---- usbd_desc.c: VID/PID/strings, UID serial (spec §4.2) --------------
    let desc = read(&out_dir, "Core/Src/usbd_desc.c");
    assert!(desc.contains("#define USBD_VID     0x1209"), "desc:\n{desc}");
    assert!(desc.contains("#define USBD_PID_FS     0x0D32"));
    assert!(desc.contains("#define USBD_MANUFACTURER_STRING     \"ODrive Robotics\""));
    assert!(desc.contains("#define USBD_PRODUCT_STRING_FS     \"ODrive v3.3\""));
    assert!(desc.contains("#define USBD_CONFIGURATION_STRING_FS     \"CDC Config\""));
    assert!(desc.contains("#define USBD_INTERFACE_STRING_FS     \"CDC Interface\""));
    // The doc's serialNumberString is IGNORED — serial is UID-derived.
    assert!(!desc.contains("000000000001"));
    assert!(desc.contains("Get_SerialNum();"));
    assert!(desc.contains("IntToUnicode(deviceserial0, &USBD_StringSerial[2], 8);"));

    // ---- usbd_conf.c: pins, NVIC, PCD init, FIFO sizes (spec §4.3) ---------
    let conf = read(&out_dir, "Core/Src/usbd_conf.c");
    assert!(conf.contains("PCD_HandleTypeDef hpcd_USB_OTG_FS;"));
    assert!(conf.contains("PA11     ------> USB_OTG_FS_DM"), "conf:\n{conf}");
    assert!(conf.contains("PA12     ------> USB_OTG_FS_DP"));
    assert!(conf.contains("GPIO_InitStruct.Pin = GPIO_PIN_11|GPIO_PIN_12;"));
    assert!(conf.contains("GPIO_InitStruct.Alternate = GPIO_AF10_OTG_FS;"));
    assert!(conf.contains("HAL_NVIC_SetPriority(OTG_FS_IRQn, 5, 0);"));
    assert!(conf.contains("HAL_NVIC_EnableIRQ(OTG_FS_IRQn);"));
    assert!(conf.contains("hpcd_USB_OTG_FS.Init.dev_endpoints = 4;"));
    assert!(conf.contains("hpcd_USB_OTG_FS.Init.speed = PCD_SPEED_FULL;"));
    assert!(conf.contains("hpcd_USB_OTG_FS.Init.vbus_sensing_enable = DISABLE;"));
    assert!(conf.contains("HAL_PCDEx_SetRxFiFo(&hpcd_USB_OTG_FS, 0x80);"));
    assert!(conf.contains("HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 0, 0x40);"));
    assert!(conf.contains("HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 1, 0x80);"));
    assert!(conf.contains("void HAL_PCD_MspInit(PCD_HandleTypeDef* pcdHandle)"));

    // ---- usbd_cdc_if.h buffer sizes (spec §4.4) -----------------------------
    let cdc_h = read(&out_dir, "Core/Inc/usbd_cdc_if.h");
    assert!(cdc_h.contains("#define APP_RX_DATA_SIZE  64"));
    assert!(cdc_h.contains("#define APP_TX_DATA_SIZE  64"));

    // ---- it.c: middleware handler + extern (spec §4.5) ----------------------
    let it_c = read(&out_dir, "Core/Src/stm32f4xx_it.c");
    assert!(it_c.contains("extern PCD_HandleTypeDef hpcd_USB_OTG_FS;"), "it.c:\n{it_c}");
    assert!(it_c.contains("void OTG_FS_IRQHandler(void)"));
    assert!(it_c.contains("HAL_PCD_IRQHandler(&hpcd_USB_OTG_FS);"));
    assert_eq!(
        it_c.matches("void OTG_FS_IRQHandler(void)").count(),
        1,
        "exactly one OTG_FS handler"
    );

    // ---- hal_conf: HAL_PCD_MODULE_ENABLED exactly once ----------------------
    let hal_conf = read(&out_dir, "Core/Inc/stm32f4xx_hal_conf.h");
    assert_eq!(
        hal_conf.matches("#define HAL_PCD_MODULE_ENABLED").count(),
        1,
        "HAL_PCD_MODULE_ENABLED must be defined exactly once:\n{hal_conf}"
    );
    assert!(hal_conf.contains("USE_HAL_PCD_REGISTER_CALLBACKS        0U"));

    // ---- main.c: include + standalone init call ------------------------------
    let main_c = read(&out_dir, "Core/Src/main.c");
    assert!(main_c.contains("#include \"usb_device.h\""));
    assert!(main_c.contains("MX_USB_DEVICE_Init();"), "main.c:\n{main_c}");

    // ---- USB_OTG_FS is a middleware-owned instance (P7): no core per-IP
    //      file pair, no pcd.h include, no MX_USB_OTG_FS_PCD_Init call ---------
    assert!(
        !out_dir.join("Core/Src/pcd.c").exists() && !out_dir.join("Core/Inc/pcd.h").exists(),
        "middleware-owned USB_OTG_FS must not get a core pcd.c/pcd.h pair"
    );
    assert!(
        !files.contains("Core/Src/pcd.c") && !files.contains("Core/Inc/pcd.h"),
        "manifest must not list a core pcd.c/pcd.h"
    );
    assert!(
        !main_c.contains("pcd.h") && !main_c.contains("MX_USB_OTG_FS_PCD_Init"),
        "main.c must not include pcd.h nor call the core PCD init:\n{main_c}"
    );

    // ---- CMake wiring ---------------------------------------------------------
    let cmake = read(&out_dir, "CMakeLists.txt");
    for frag in [
        "Core/Src/usb_device.c",
        "Core/Src/usbd_conf.c",
        "Core/Src/usbd_desc.c",
        "Core/Src/usbd_cdc_if.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c",
        "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Src/usbd_cdc.c",
        "Middlewares/ST/STM32_USB_Device_Library/Core/Inc",
        "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc",
        "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pcd.c",
        "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_ll_usb.c",
    ] {
        assert!(cmake.contains(frag), "CMakeLists.txt missing {frag}:\n{cmake}");
    }
    assert!(!cmake.contains("USE_USB_FS"), "CMake flow adds no USE_USB_FS define");
    assert!(
        !cmake.contains("Core/Src/pcd.c"),
        "CMake must not compile a core pcd.c for the owned instance:\n{cmake}"
    );

    // ---- compile + link against the copied 2.11.6 library --------------------
    run(
        &out_dir,
        "cmake",
        &[
            "-G",
            "Ninja",
            "-DCMAKE_BUILD_TYPE=Debug",
            "-DCMAKE_TOOLCHAIN_FILE=cmake/gcc-arm-none-eabi.cmake",
            "-B",
            "build",
        ],
    );
    run(&out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("usb_gate.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}

/// Handshake (spec §4.5): with FreeRTOS configured, the USB generator must
/// NOT call MX_USB_DEVICE_Init from main() (P5 defers it into
/// StartDefaultTask); main.c keeps the usb_device.h include either way.
#[test]
fn usb_init_call_defers_to_freertos_task_when_rtos_present() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let doc = usb_doc(true);
    let resolved = validate(&pack, &doc).expect("hard failure");
    assert!(!has_errors(&resolved.diags));
    let ctx = stm32ck_codegen::GenCtx {
        pack: &pack,
        resolved: &resolved,
        doc: &doc,
        kernel_version: "0.1.0",
        fw: None,
    };
    let files = stm32ck_codegen::emit::emit_all(&ctx).unwrap();
    let main_c = &files
        .iter()
        .find(|f| f.rel_path == "Core/Src/main.c")
        .expect("main.c emitted")
        .content;
    assert!(main_c.contains("#include \"usb_device.h\""));
    assert!(
        !main_c.contains("MX_USB_DEVICE_Init();"),
        "with FreeRTOS the USB init call moves into StartDefaultTask:\n{main_c}"
    );
}

/// Misconfiguration fallback: middleware.usbDevice without the USB_OTG_FS
/// peripheral emits NO usb files (panic-free) and raises USB_PERIPH_MISSING
/// through the diagnostics hook.
#[test]
fn usb_without_periph_emits_nothing_and_diagnoses() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let mut v: serde_json::Value =
        serde_json::to_value(usb_doc(false)).expect("serialize doc");
    v["peripherals"]
        .as_object_mut()
        .unwrap()
        .remove("USB_OTG_FS")
        .expect("doc carries USB_OTG_FS");
    let doc: ConfigDoc = serde_json::from_value(v).unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    let ctx = stm32ck_codegen::GenCtx {
        pack: &pack,
        resolved: &resolved,
        doc: &doc,
        kernel_version: "0.1.0",
        fw: None,
    };
    let files = stm32ck_codegen::emit::emit_all(&ctx).unwrap();
    assert!(
        !files.iter().any(|f| f.rel_path.contains("usb")),
        "no usb files may be emitted without the USB_OTG_FS peripheral"
    );
    let diags = stm32ck_codegen::middleware::diagnostics(&ctx);
    assert!(
        diags.iter().any(|d| d.code == "USB_PERIPH_MISSING"),
        "expected USB_PERIPH_MISSING, got {diags:?}"
    );
}
