//! Project shell tests: pure device_macro mapping plus, when the F1 IR pack
//! and firmware components are present, assemble()/copy_firmware() against
//! the F103 golden configuration (same doc as engine/tests/f103_golden.rs).

use std::path::PathBuf;
use stm32ck_codegen::project::{assemble, copy_firmware, device_macro};
use stm32ck_codegen::GenCtx;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::{IrPack, Part};

// ---------------------------------------------------------------------------
// device_macro: pure, no pack / firmware needed
// ---------------------------------------------------------------------------

/// The stems `device_stems()` reads off cmsis_device_f1 / cmsis_device_f4 /
/// the H5+H7 Cube packs, spelled out so the bucketing rule can be tested
/// without a firmware tree on disk.
fn stems(which: &str) -> Vec<String> {
    let list: &[&str] = match which {
        "f1" => &[
            "stm32f100xb", "stm32f100xe", "stm32f101x6", "stm32f101xb", "stm32f101xe",
            "stm32f101xg", "stm32f102x6", "stm32f102xb", "stm32f103x6", "stm32f103xb",
            "stm32f103xe", "stm32f103xg", "stm32f105xc", "stm32f107xc",
        ],
        "f4" => &[
            "stm32f401xc", "stm32f401xe", "stm32f405xx", "stm32f407xx", "stm32f410cx",
            "stm32f410rx", "stm32f410tx", "stm32f411xe", "stm32f412cx", "stm32f412rx",
            "stm32f412vx", "stm32f412zx", "stm32f413xx", "stm32f415xx", "stm32f417xx",
            "stm32f423xx", "stm32f427xx", "stm32f429xx", "stm32f437xx", "stm32f439xx",
            "stm32f446xx", "stm32f469xx", "stm32f479xx",
        ],
        "h5" => &[
            "stm32h503xx", "stm32h523xx", "stm32h533xx", "stm32h543xx", "stm32h553xx",
            "stm32h562xx", "stm32h563xx", "stm32h573xx", "stm32h5e4xx", "stm32h5e5xx",
            "stm32h5f4xx", "stm32h5f5xx",
        ],
        "h7" => &[
            "stm32h723xx", "stm32h725xx", "stm32h730xx", "stm32h730xxq", "stm32h733xx",
            "stm32h735xx", "stm32h742xx", "stm32h743xx", "stm32h745xg", "stm32h745xx",
            "stm32h747xg", "stm32h747xx", "stm32h750xx", "stm32h753xx", "stm32h755xx",
            "stm32h757xx", "stm32h7a3xx", "stm32h7a3xxq", "stm32h7b0xx", "stm32h7b0xxq",
            "stm32h7b3xx", "stm32h7b3xxq",
        ],
        other => panic!("no stem fixture for {other}"),
    };
    list.iter().map(|s| s.to_string()).collect()
}

fn mk_part(family: &str, core: &str, flash_kb: Vec<u32>, ram_kb: Vec<u32>) -> Part {
    Part {
        ref_name: "TEST".to_string(),
        family: family.to_string(),
        line: String::new(),
        package: String::new(),
        clock_tree: String::new(),
        die: String::new(),
        core: core.to_string(),
        max_freq_mhz: 0,
        flash_kb,
        ram_kb,
        memory_maps: Default::default(),
        io_count: 0,
        ccm_ram_kb: None,
        voltage_mv: None,
        part_numbers: Vec::new(),
        pins: Vec::new(),
        ip_instances: Vec::new(),
    }
}

#[test]
fn device_macro_f103c8_maps_to_xb() {
    let part = mk_part("STM32F1", "Arm Cortex-M3", vec![64, 128], vec![20]);
    let (mac, stem) = device_macro(&part, "STM32F103C8Tx", &stems("f1")).unwrap();
    assert_eq!(mac, "STM32F103xB");
    assert_eq!(stem, "startup_stm32f103xb");
}

#[test]
fn device_macro_f411ce_maps_to_xe() {
    let part = mk_part("STM32F4", "Arm Cortex-M4", vec![512], vec![128]);
    let (mac, stem) = device_macro(&part, "STM32F411CEUx", &stems("f4")).unwrap();
    assert_eq!(mac, "STM32F411xE");
    assert_eq!(stem, "startup_stm32f411xe");
}

#[test]
fn device_macro_flash_buckets() {
    let f1 = stems("f1");
    let part = mk_part("STM32F1", "Arm Cortex-M3", vec![16, 32], vec![10]);
    // 16K low-density F103 shares the x6 header with 32K.
    let (mac, stem) = device_macro(&part, "STM32F103C4Tx", &f1).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32F103x6", "startup_stm32f103x6"));
    // 512K high-density -> xE; 768K+ XL-density -> xG.
    let part = mk_part("STM32F1", "Arm Cortex-M3", vec![256, 384, 512], vec![64]);
    let (mac, _) = device_macro(&part, "STM32F103ZETx", &f1).unwrap();
    assert_eq!(mac, "STM32F103xE");
    let part = mk_part("STM32F1", "Arm Cortex-M3", vec![768, 1024], vec![96]);
    let (mac, stem) = device_macro(&part, "STM32F103ZGTx", &f1).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32F103xG", "startup_stm32f103xg"));
}

#[test]
fn device_macro_f4_catchall_and_pin_keyed() {
    let f4 = stems("f4");
    let part = mk_part("STM32F4", "Arm Cortex-M4", vec![1024], vec![192]);
    let (mac, stem) = device_macro(&part, "STM32F405RGTx", &f4).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32F405xx", "startup_stm32f405xx"));
    // F410 headers are keyed by pin count, not flash size.
    let part = mk_part("STM32F4", "Arm Cortex-M4", vec![128], vec![32]);
    let (mac, stem) = device_macro(&part, "STM32F410CBUx", &f4).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32F410Cx", "startup_stm32f410cx"));
}

/// The H-series stems are all catch-all `xx`, so flash size never enters the
/// mapping — the whole line shares one header and one startup file.
#[test]
fn device_macro_h5_h7_catchall() {
    let part = mk_part("STM32H7", "Arm Cortex-M7", vec![2048], vec![864]);
    let (mac, stem) = device_macro(&part, "STM32H743VITx", &stems("h7")).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32H743xx", "startup_stm32h743xx"));
    // H750 ships 128K flash but the same catch-all header.
    let part = mk_part("STM32H7", "Arm Cortex-M7", vec![128], vec![1024]);
    let (mac, stem) = device_macro(&part, "STM32H750VBTx", &stems("h7")).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32H750xx", "startup_stm32h750xx"));
    let part = mk_part("STM32H5", "Arm Cortex-M33", vec![2048], vec![640]);
    let (mac, stem) = device_macro(&part, "STM32H563ZITx", &stems("h5")).unwrap();
    assert_eq!((mac.as_str(), stem.as_str()), ("STM32H563xx", "startup_stm32h563xx"));
}

#[test]
fn device_macro_rejects_garbage() {
    let part = mk_part("STM32F1", "Arm Cortex-M3", vec![64], vec![20]);
    assert!(device_macro(&part, "GD32F103", &stems("f1")).is_err());
    assert!(device_macro(&part, "STM32X999Z9", &stems("f1")).is_err());
    // A line the firmware tree has no stem for must fail, not guess.
    assert!(device_macro(&part, "STM32F103C8Tx", &stems("f4")).is_err());
}

// ---------------------------------------------------------------------------
// Golden F103 shell (skips when pack/firmware not present)
// ---------------------------------------------------------------------------

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

fn golden_doc() -> ConfigDoc {
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
          "gpio": { "PC13": { "mode": "output", "initHigh": true, "label": "LED" } }
        }"#,
    )
    .unwrap()
}

#[test]
fn f103_golden_shell_and_firmware_copy() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F1").is_dir() {
        eprintln!("skip: {} not present (run tools/fetch-fw first)", fw_dir.display());
        return;
    }
    let doc = golden_doc();
    let resolved = validate(&pack, &doc).expect("hard failure");
    assert!(!has_errors(&resolved.diags), "golden config must be clean: {:?}", resolved.diags);
    let ctx = GenCtx {
        pack: &pack,
        resolved: &resolved,
        doc: &doc,
        kernel_version: "test",
        fw: None,
    };

    // ---- assemble -----------------------------------------------------------
    let files = assemble(&ctx, &fw_dir).unwrap();
    let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
    assert!(rels.contains(&"CMakeLists.txt"), "rels: {rels:?}");
    assert!(rels.contains(&"cmake/gcc-arm-none-eabi.cmake"), "rels: {rels:?}");
    assert!(rels.contains(&"STM32F103C8Tx_FLASH.ld"), "rels: {rels:?}");

    let cmake = &files
        .iter()
        .find(|f| f.rel_path == "CMakeLists.txt")
        .unwrap()
        .content;
    assert!(cmake.contains("Core/Startup/startup_stm32f103xb.s"), "cmake:\n{cmake}");
    assert!(cmake.contains("STM32F103xB"), "device define missing:\n{cmake}");
    assert!(cmake.contains("-mcpu=cortex-m3"), "core flags missing:\n{cmake}");
    assert!(cmake.contains("-mfloat-abi=soft"));
    assert!(cmake.contains("USE_HAL_DRIVER"));
    assert!(cmake.contains("Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_uart.c"));
    assert!(cmake.contains("project(app C ASM)"));
    assert!(cmake.contains("-Wl,--gc-sections"));

    let toolchain = &files
        .iter()
        .find(|f| f.rel_path == "cmake/gcc-arm-none-eabi.cmake")
        .unwrap()
        .content;
    assert!(toolchain.contains("set(CMAKE_SYSTEM_NAME               Generic)"));
    assert!(toolchain.contains("CMAKE_TRY_COMPILE_TARGET_TYPE"));

    let ld = &files
        .iter()
        .find(|f| f.rel_path == "STM32F103C8Tx_FLASH.ld")
        .unwrap()
        .content;
    assert!(ld.contains("FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 64K"), "ld:\n{ld}");
    assert!(ld.contains("RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 20K"), "ld:\n{ld}");
    assert!(ld.contains("ENTRY(Reset_Handler)"));
    assert!(ld.contains("_Min_Heap_Size = 0x200"));
    assert!(ld.contains("_Min_Stack_Size = 0x400"));
    assert!(ld.contains("_estack = ORIGIN(RAM) + LENGTH(RAM);"));

    // ---- copy_firmware ------------------------------------------------------
    let out = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("f103_shell_out");
    let _ = std::fs::remove_dir_all(&out);
    let copied = copy_firmware(&ctx, &fw_dir, &out).unwrap();

    for expected in [
        "Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_uart.c",
        "Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_rcc.c",
        "Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal_gpio.c",
        "Drivers/STM32F1xx_HAL_Driver/Inc/stm32f1xx_hal_uart.h",
        "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h",
        "Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f1xx.h",
        "Drivers/CMSIS/Include/core_cm3.h",
        "Core/Startup/startup_stm32f103xb.s",
        "Core/Src/system_stm32f1xx.c",
    ] {
        assert!(
            copied.iter().any(|p| p == expected),
            "{expected} not in copy list"
        );
    }
    // LL sources and other-family files must not leak in.
    assert!(!copied.iter().any(|p| p.contains("_ll_") && p.ends_with(".c")));
    assert!(copied.iter().filter(|p| p.starts_with("Core/Startup/")).count() == 1);

    // Sorted, and every path really exists on disk with `/` separators.
    let mut sorted = copied.clone();
    sorted.sort();
    assert_eq!(copied, sorted, "copy list must be sorted");
    for p in &copied {
        assert!(!p.contains('\\'), "backslash in rel path {p}");
        assert!(out.join(p).is_file(), "{p} missing on disk");
    }

    // CMakeLists references exactly the copied compilation units.
    for p in copied.iter().filter(|p| p.ends_with(".c") || p.ends_with(".s")) {
        assert!(cmake.contains(p.as_str()), "CMakeLists missing source {p}");
    }

    // ---- determinism --------------------------------------------------------
    let files2 = assemble(&ctx, &fw_dir).unwrap();
    for (a, b) in files.iter().zip(files2.iter()) {
        assert_eq!(a.rel_path, b.rel_path);
        assert_eq!(a.content, b.content, "assemble not deterministic: {}", a.rel_path);
    }
    let copied2 = copy_firmware(&ctx, &fw_dir, &out).unwrap();
    assert_eq!(copied, copied2, "copy_firmware not deterministic");
}
