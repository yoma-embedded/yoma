//! FreeRTOS middleware gate (P5) — the ODrive freertos configuration
//! (defaultTask 0/256/StartDefaultTask, heap 65536, the 4 config flags) on
//! the parity config with halTimebase TIM14 and WITHOUT usbDevice:
//!
//! * `FreeRTOSConfig.h` content-asserted against the reference
//!   `Inc/FreeRTOSConfig.h` (normalized: USER CODE interiors + comments
//!   stripped; the `#define` SET and values must match),
//! * `freertos.c` matches the reference minus the deferred USB init,
//! * main.c carries the spec §2.3 integration block,
//! * it.c/it.h drop SVC/PendSV/SysTick (port-owned, spec §2.4),
//! * the whole project compiles + links with arm-gcc (the real gate).
//!
//! Plus the cross-middleware handshake: WITH a usbDevice config the
//! `MX_USB_DEVICE_Init()` call appears as the first statement of
//! StartDefaultTask (only OUR line insertion is asserted — the USB
//! generator may still be a stub, so that variant is not compiled).

use std::path::{Path, PathBuf};
use std::process::Command;
use stm32ck_codegen::middleware::freertos::FreertosGen;
use stm32ck_codegen::middleware::MiddlewareGen;
use stm32ck_codegen::{generate_project, GenCtx};
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::{validate, Resolved};
use stm32ck_ir::model::IrPack;

const REFERENCE: &str = "D:/embedded_agent/motorcontrol/odrive_cubemx_demo";

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

fn reference_file(rel: &str) -> Option<String> {
    let path = PathBuf::from(REFERENCE).join(rel);
    if !path.is_file() {
        eprintln!("skip: reference file {} not present", path.display());
        return None;
    }
    Some(std::fs::read_to_string(path).unwrap())
}

/// odrive.json with USB_OTG_FS stripped (the PCD glue is P6-owned; this
/// gate stays independent) and, unless `with_usb`, the usbDevice
/// middleware stripped too. FreeRTOS + halTimebase TIM14 + NVIC GROUP_4
/// stay — that's the P5 target.
fn freertos_doc(with_usb: bool) -> ConfigDoc {
    let path = repo_root().join("tests/parity/odrive/odrive.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let periphs = v["peripherals"].as_object_mut().unwrap();
    assert!(periphs.remove("USB_OTG_FS").is_some());
    let mw = v["middleware"].as_object_mut().unwrap();
    assert!(mw.contains_key("freertos"), "odrive.json must configure freertos");
    if !with_usb {
        assert!(mw.remove("usbDevice").is_some());
    }
    serde_json::from_value(v).unwrap()
}

fn validate_clean<'a>(pack: &'a IrPack, doc: &'a ConfigDoc) -> Resolved<'a> {
    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "freertos gate doc must validate clean");
    resolved
}

/// Run FreertosGen::files() and return the named file's content.
fn generated(pack: &IrPack, doc: &ConfigDoc, resolved: &Resolved<'_>, rel: &str) -> String {
    let ctx = GenCtx {
        pack,
        resolved,
        doc,
        kernel_version: "0.1.0",
        fw: None,
    };
    FreertosGen
        .files(&ctx)
        .unwrap()
        .into_iter()
        .find(|f| f.rel_path == rel)
        .unwrap_or_else(|| panic!("FreertosGen did not produce {rel}"))
        .content
}

// ---------------------------------------------------------------------------
// Normalization: strip USER CODE interiors, then comments, then collapse
// whitespace and drop empty lines.
// ---------------------------------------------------------------------------

fn strip_user_code(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for line in text.lines() {
        if line.contains("USER CODE BEGIN") {
            depth += 1;
            continue;
        }
        if line.contains("USER CODE END") {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth == 0 {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn strip_comments(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            out.push(' ');
        } else if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

fn norm_lines(text: &str) -> Vec<String> {
    strip_comments(&strip_user_code(text))
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect()
}

/// Sorted multiset of normalized `#define ...` lines.
fn defines(text: &str) -> Vec<String> {
    let mut v: Vec<String> = norm_lines(text)
        .into_iter()
        .filter(|l| l.starts_with("#define "))
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------------------
// Content parity vs the CubeMX reference
// ---------------------------------------------------------------------------

#[test]
fn freertos_config_h_matches_reference() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let Some(reference) = reference_file("Inc/FreeRTOSConfig.h") else { return };
    let doc = freertos_doc(false);
    let resolved = validate_clean(&pack, &doc);
    let ours = generated(&pack, &doc, &resolved, "Core/Inc/FreeRTOSConfig.h");

    assert_eq!(
        defines(&ours),
        defines(&reference),
        "FreeRTOSConfig.h macro set/values must match the reference\n--- generated ---\n{ours}"
    );
    // The TIM-timebase quirk (spec §2.1 surprise #1): the SysTick alias is
    // UNCOMMENTED (also covered by the define-set compare; assert the raw
    // line to make the intent explicit).
    assert!(
        ours.contains("\n#define xPortSysTickHandler SysTick_Handler\n"),
        "xPortSysTickHandler alias must be uncommented under a TIM timebase"
    );
}

#[test]
fn freertos_c_matches_reference_minus_usb_init() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let Some(reference) = reference_file("Src/freertos.c") else { return };
    let doc = freertos_doc(false);
    let resolved = validate_clean(&pack, &doc);
    let ours = generated(&pack, &doc, &resolved, "Core/Src/freertos.c");

    // The reference defers MX_USB_DEVICE_Init to the default task; this
    // variant has no usbDevice, so those two statements must be the ONLY
    // difference (normalized).
    let ref_lines: Vec<String> = norm_lines(&reference)
        .into_iter()
        .filter(|l| l != "extern void MX_USB_DEVICE_Init(void);" && l != "MX_USB_DEVICE_Init();")
        .collect();
    assert_eq!(
        norm_lines(&ours),
        ref_lines,
        "freertos.c must match the reference minus the USB init lines\n--- generated ---\n{ours}"
    );
}

// ---------------------------------------------------------------------------
// main.c / it.c integration through the middleware seam
// ---------------------------------------------------------------------------

fn emit_file(pack: &IrPack, doc: &ConfigDoc, resolved: &Resolved<'_>, rel: &str) -> String {
    let ctx = GenCtx {
        pack,
        resolved,
        doc,
        kernel_version: "0.1.0",
        fw: None,
    };
    stm32ck_codegen::emit::emit_all(&ctx)
        .unwrap()
        .into_iter()
        .find(|f| f.rel_path == rel)
        .unwrap_or_else(|| panic!("emit_all did not produce {rel}"))
        .content
}

#[test]
fn main_c_has_kernel_start_block_and_it_files_drop_rtos_handlers() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let doc = freertos_doc(false);
    let resolved = validate_clean(&pack, &doc);

    let main_c = emit_file(&pack, &doc, &resolved, "Core/Src/main.c");
    // Include slot: cmsis_os.h right after main.h (spec §1.3).
    assert!(
        main_c.contains("#include \"main.h\"\n#include \"cmsis_os.h\"\n"),
        "cmsis_os.h must be the second include:\n{main_c}"
    );
    assert!(main_c.contains("void MX_FREERTOS_Init(void);\n"));
    // §2.3 block verbatim, v1 (NO osKernelInitialize), after USER CODE 2.
    let block = "  /* USER CODE END 2 */\n\n  \
                 /* Call init function for freertos objects (in cmsis_os2.c) */\n  \
                 MX_FREERTOS_Init();\n\n  \
                 /* Start scheduler */\n  \
                 osKernelStart();\n\n  \
                 /* We should never get here as control is now taken by the scheduler */\n\n  \
                 /* Infinite loop */\n";
    assert!(main_c.contains(block), "main.c §2.3 block missing/misplaced:\n{main_c}");
    assert!(!main_c.contains("osKernelInitialize"), "v1 has no osKernelInitialize");

    // it.c/it.h: the port owns all three system handlers here (TIM14
    // timebase — spec §2.4 / surprise #1).
    let it_c = emit_file(&pack, &doc, &resolved, "Core/Src/stm32f4xx_it.c");
    let it_h = emit_file(&pack, &doc, &resolved, "Core/Inc/stm32f4xx_it.h");
    for name in ["SVC_Handler", "PendSV_Handler", "SysTick_Handler"] {
        assert!(!it_c.contains(&format!("void {name}(void)")), "{name} must not be in it.c");
        assert!(!it_h.contains(&format!("void {name}(void);")), "{name} must not be in it.h");
    }
    // The other Cortex handlers stay.
    assert!(it_c.contains("void HardFault_Handler(void)"));
    assert!(it_c.contains("void NMI_Handler(void)"));
}

#[test]
fn usb_handshake_inserts_usb_init_in_default_task() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let doc = freertos_doc(true); // usbDevice kept (generator may be a stub)
    let resolved = validate_clean(&pack, &doc);
    let freertos_c = generated(&pack, &doc, &resolved, "Core/Src/freertos.c");

    assert!(
        freertos_c.contains("extern void MX_USB_DEVICE_Init(void);\n"),
        "file-scope extern missing:\n{freertos_c}"
    );
    // First statement of StartDefaultTask, OUTSIDE user code, with the
    // reference comment (spec §2.2/§4.5).
    let body = "void StartDefaultTask(void const * argument)\n{\n  \
                /* init code for USB_DEVICE */\n  \
                MX_USB_DEVICE_Init();\n  \
                /* USER CODE BEGIN StartDefaultTask */\n";
    assert!(freertos_c.contains(body), "deferred USB init misplaced:\n{freertos_c}");
}

#[test]
fn warns_without_tim_timebase_and_on_wrong_priority_group() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    // Variant: no halTimebase, non-GROUP_4 grouping.
    let path = repo_root().join("tests/parity/odrive/odrive.json");
    let mut v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["peripherals"].as_object_mut().unwrap().remove("USB_OTG_FS");
    v["middleware"].as_object_mut().unwrap().remove("usbDevice");
    v["project"].as_object_mut().unwrap().remove("halTimebase");
    v["nvic"]["priorityGroup"] = serde_json::json!("NVIC_PRIORITYGROUP_2");
    let doc: ConfigDoc = serde_json::from_value(v).unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    let ctx = GenCtx {
        pack: &pack,
        resolved: &resolved,
        doc: &doc,
        kernel_version: "0.1.0",
        fw: None,
    };

    let diags = FreertosGen.diagnostics(&ctx);
    let codes: Vec<&str> = diags.iter().map(|d| d.code.as_str()).collect();
    assert!(codes.contains(&"MW_FREERTOS_TIMEBASE"), "missing timebase warning: {codes:?}");
    assert!(
        codes.contains(&"MW_FREERTOS_PRIORITY_GROUP"),
        "missing priority-group warning: {codes:?}"
    );

    // Without a TIM timebase only SVC/PendSV disappear; SysTick stays
    // HAL-owned (its handler keeps ticking via HAL_IncTick).
    let it_c = emit_file(&pack, &doc, &resolved, "Core/Src/stm32f4xx_it.c");
    assert!(!it_c.contains("void SVC_Handler(void)"));
    assert!(!it_c.contains("void PendSV_Handler(void)"));
    assert!(it_c.contains("void SysTick_Handler(void)"));
    assert!(it_c.contains("HAL_IncTick();"));

    // And FreeRTOSConfig.h keeps the alias commented (SysTick timebase).
    let conf = generated(&pack, &doc, &resolved, "Core/Inc/FreeRTOSConfig.h");
    assert!(conf.contains("/* #define xPortSysTickHandler SysTick_Handler */"));
    assert!(conf.contains("void xPortSysTickHandler(void);"));
}

// ---------------------------------------------------------------------------
// The real gate: full project generation + cross-compile
// ---------------------------------------------------------------------------

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
fn odrive_freertos_project_compiles() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F4").is_dir() || !fw_dir.join("MW").join("FreeRTOS").is_dir() {
        eprintln!("skip: firmware components not present under {}", fw_dir.display());
        return;
    }
    for tool in ["arm-none-eabi-gcc", "cmake", "ninja"] {
        if !tool_available(tool) {
            eprintln!("skip: `{tool}` not found on PATH");
            return;
        }
    }

    let doc = freertos_doc(false);
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("freertos_gate_odrive");
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).unwrap();
    }
    std::fs::create_dir_all(&out_dir).unwrap();

    let resolved = validate_clean(&pack, &doc);
    let manifest = generate_project(&pack, &resolved, &doc, &fw_dir, &out_dir, "0.1.0")
        .expect("generate_project");
    // The ODrive doc satisfies both couplings — no freertos warnings.
    for d in &manifest.diags {
        eprintln!("manifest diag: {:?} {} {}", d.severity, d.code, d.message);
        assert!(
            !d.code.starts_with("MW_FREERTOS"),
            "unexpected freertos coupling warning on the parity doc: {d:?}"
        );
    }

    // Generated + copied artifacts present.
    for rel in [
        "Core/Inc/FreeRTOSConfig.h",
        "Core/Src/freertos.c",
        "Middlewares/Third_Party/FreeRTOS/Source/tasks.c",
        "Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS/cmsis_os.c",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F/port.c",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_4.c",
        "Middlewares/Third_Party/FreeRTOS/Source/include/FreeRTOS.h",
    ] {
        assert!(manifest.files.contains(&rel.to_string()), "manifest missing {rel}");
        assert!(out_dir.join(rel).is_file(), "file missing on disk: {rel}");
    }
    let cmake_txt = std::fs::read_to_string(out_dir.join("CMakeLists.txt")).unwrap();
    for frag in [
        "Core/Src/freertos.c",
        "Middlewares/Third_Party/FreeRTOS/Source/tasks.c",
        "Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS/cmsis_os.c",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F/port.c",
        "Middlewares/Third_Party/FreeRTOS/Source/include",
        "Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F",
    ] {
        assert!(cmake_txt.contains(frag), "CMakeLists.txt missing {frag}:\n{cmake_txt}");
    }

    run(
        &out_dir,
        "cmake",
        &["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug"],
    );
    run(&out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("odrive_cubemx_demo.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}
