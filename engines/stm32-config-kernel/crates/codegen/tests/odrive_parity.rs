//! P7 — the FINAL ODrive parity acceptance gate (plan §P7).
//!
//! Loads `tests/parity/odrive/odrive.json` UNSTRIPPED (full middleware,
//! halTimebase, DMA, NVIC fine-graining, pin stacking, userConstants) and
//! asserts, against the CubeMX 6.x reference project at
//! `D:/embedded_agent/motorcontrol/odrive_cubemx_demo`:
//!
//! 1. validation is CLEAN — zero errors, an EXACT allowed warning-code set,
//!    PIN_SHARED infos for the stacked pads;
//! 2. FILE-SET EQUALITY — generated `Core/Src/*.c` == reference `Src/*.c`,
//!    generated `Core/Inc/*.h` (incl. FreeRTOSConfig.h) == reference
//!    `Inc/*.h`, and the copied `Middlewares/` tree covers every file the
//!    reference CMake compiles;
//! 3. NORMALIZED PER-FUNCTION DIFF — assignment/call statement multisets per
//!    same-named function (tools/parity_diff.py), every delta whitelisted in
//!    `tests/parity/odrive/parity-whitelist.md`;
//! 4. the generated project COMPILES and links with arm-gcc (cmake+ninja);
//!    `.text` size vs the reference build is reported informationally;
//! 5. DETERMINISM — a second generation is byte-identical.
//!
//! Skips (with a message) when the F4 pack, firmware payloads, reference
//! tree, python, or the arm toolchain are absent.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use stm32ck_codegen::generate_project;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::Severity;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

/// Where the CubeMX reference project lives, overridable with
/// `STM32CK_ODRIVE_REF`.
///
/// A hardcoded absolute path is how this gate went dark: the reference tree
/// moved, `is_dir()` said no, and the strongest correctness check in the repo
/// skipped silently for as long as nobody looked at the test output. It is
/// now (a) overridable and (b) loud — see [`prerequisites`].
const REFERENCE_DIR_DEFAULT: &str = "D:/toy/odrive_demo";

fn reference_dir() -> PathBuf {
    match std::env::var("STM32CK_ODRIVE_REF") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => PathBuf::from(REFERENCE_DIR_DEFAULT),
    }
}

/// The reference project's `Src`/`Inc` pair. CubeMX emits two layouts
/// depending on the toolchain chosen for the reference: the standalone
/// Makefile flavour puts them at the root, the CubeIDE/CMake flavour under
/// `Core/` — which is also the layout this generator produces.
fn reference_layout(reference: &Path) -> Option<(PathBuf, PathBuf)> {
    for (src, inc) in [("Core/Src", "Core/Inc"), ("Src", "Inc")] {
        let (s, i) = (reference.join(src), reference.join(inc));
        if s.is_dir() && i.is_dir() {
            return Some((s, i));
        }
    }
    None
}

/// Warning codes the full ODrive document is ALLOWED (and expected) to
/// produce. The set must match EXACTLY — the full ODrive doc validates with
/// NO warnings at all (the symbolic-userConstant pass-through and the
/// stacked pads are Severity::Info: PARAM_SYMBOLIC / PIN_SHARED, asserted
/// separately below).
const ALLOWED_WARNING_CODES: &[&str] = &[];

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

fn prerequisites() -> Option<(IrPack, PathBuf, PathBuf)> {
    let pack = load_pack("stm32f4.irpack")?;
    let fw_dir = repo_root().join("data").join("fw");
    for sub in ["STM32F4", "MW/FreeRTOS", "MW/USB_Device"] {
        if !fw_dir.join(sub).is_dir() {
            eprintln!("skip: firmware payload {sub} not present under {}", fw_dir.display());
            return None;
        }
    }
    // Not finding the reference is a FAILURE, not a skip: this gate is the
    // only thing that checks output against real CubeMX, and a silent skip
    // reads exactly like a pass. Declare the absence deliberately with
    // `STM32CK_ODRIVE_REF=skip` if the tree genuinely is not available.
    let reference = reference_dir();
    if std::env::var("STM32CK_ODRIVE_REF").is_ok_and(|v| v == "skip") {
        eprintln!("skip: STM32CK_ODRIVE_REF=skip");
        return None;
    }
    assert!(
        reference_layout(&reference).is_some(),
        "CubeMX reference project not found at {} (no Core/Src+Core/Inc, no Src+Inc).\n\
         Point STM32CK_ODRIVE_REF at it, or set STM32CK_ODRIVE_REF=skip to opt out.",
        reference.display()
    );
    for tool in ["arm-none-eabi-gcc", "cmake", "ninja", "python"] {
        if !tool_available(tool) {
            eprintln!("skip: `{tool}` not found on PATH");
            return None;
        }
    }
    Some((pack, fw_dir, reference))
}

fn run(cwd: &Path, program: &str, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Names of files with extension `ext` directly under `dir`.
fn file_names(dir: &Path, ext: &str) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(ext))
        .collect()
}

/// Reference file names of one extension, gathering the USB Device app files
/// wherever this reference put them.
///
/// The two CubeMX project flavours differ only in *placement* of the four USB
/// Device files: the standalone-Makefile one drops them into `Src/`, the
/// CubeIDE/CMake one splits them into `USB_DEVICE/App` + `USB_DEVICE/Target`.
/// This generator emits them alongside the rest under `Core/Src`. Comparing
/// the union keeps the file-SET assertion about content coverage rather than
/// about which folder ST's project wizard chose.
fn reference_file_names(reference: &Path, dir: &Path, ext: &str) -> BTreeSet<String> {
    let mut out = file_names(dir, ext);
    for sub in ["USB_DEVICE/App", "USB_DEVICE/Target"] {
        let p = reference.join(sub);
        if p.is_dir() {
            out.extend(file_names(&p, ext));
        }
    }
    out
}

/// Files the reference `cmake/stm32cubemx/CMakeLists.txt` compiles out of
/// the Middlewares/ tree (FreeRTOS kernel set + USB Device Core/CDC set).
const REFERENCE_MIDDLEWARE_SOURCES: &[&str] = &[
    "Middlewares/Third_Party/FreeRTOS/Source/croutine.c",
    "Middlewares/Third_Party/FreeRTOS/Source/event_groups.c",
    "Middlewares/Third_Party/FreeRTOS/Source/list.c",
    "Middlewares/Third_Party/FreeRTOS/Source/queue.c",
    "Middlewares/Third_Party/FreeRTOS/Source/stream_buffer.c",
    "Middlewares/Third_Party/FreeRTOS/Source/tasks.c",
    "Middlewares/Third_Party/FreeRTOS/Source/timers.c",
    "Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS/cmsis_os.c",
    "Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_4.c",
    "Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F/port.c",
    "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c",
    "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ctlreq.c",
    "Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ioreq.c",
    "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Src/usbd_cdc.c",
];

/// Headers those sources need from the copied include dirs (reference
/// `MX_Include_Dirs` roots inside Middlewares/).
const REFERENCE_MIDDLEWARE_HEADERS: &[&str] = &[
    "Middlewares/Third_Party/FreeRTOS/Source/include/FreeRTOS.h",
    "Middlewares/Third_Party/FreeRTOS/Source/include/task.h",
    "Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS/cmsis_os.h",
    "Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F/portmacro.h",
    "Middlewares/ST/STM32_USB_Device_Library/Core/Inc/usbd_core.h",
    "Middlewares/ST/STM32_USB_Device_Library/Core/Inc/usbd_def.h",
    "Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc/usbd_cdc.h",
];

#[test]
fn odrive_full_parity() {
    let Some((pack, fw_dir, reference)) = prerequisites() else { return };

    // ---- 1. validate the UNSTRIPPED document -------------------------------
    let doc_path = repo_root().join("tests/parity/odrive/odrive.json");
    let text = std::fs::read_to_string(&doc_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", doc_path.display()));
    let doc: ConfigDoc = serde_json::from_str(&text)
        .expect("the FULL odrive.json must parse (no stripping in P7)");

    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    let errors: Vec<_> = resolved
        .diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errors.is_empty(), "full ODrive doc must validate with zero errors: {errors:#?}");
    let warning_codes: BTreeSet<&str> = resolved
        .diags
        .iter()
        .filter(|d| d.severity == Severity::Warning)
        .map(|d| d.code.as_str())
        .collect();
    let allowed: BTreeSet<&str> = ALLOWED_WARNING_CODES.iter().copied().collect();
    assert_eq!(
        warning_codes, allowed,
        "warning-code set must equal the documented allowed set"
    );
    // The userConstant pass-through must be REPORTED (info) — 9 symbolic
    // TIM parameters in the ODrive doc.
    let symbolic = resolved
        .diags
        .iter()
        .filter(|d| d.code == "PARAM_SYMBOLIC" && d.severity == Severity::Info)
        .count();
    assert_eq!(symbolic, 9, "expected 9 PARAM_SYMBOLIC infos (TIM userConstants)");
    // Stacked pads must be REPORTED (info), not silently absorbed.
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

    // ---- 2. generate + file-set equality ------------------------------------
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("odrive_parity_gen");
    if out_dir.exists() {
        std::fs::remove_dir_all(&out_dir).unwrap();
    }
    std::fs::create_dir_all(&out_dir).unwrap();
    let manifest = generate_project(&pack, &resolved, &doc, &fw_dir, &out_dir, "0.1.0")
        .expect("generate_project");
    for d in &manifest.diags {
        eprintln!("gen diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(
        !manifest.diags.iter().any(|d| d.severity == Severity::Error),
        "generation diags must carry no errors: {:#?}",
        manifest.diags
    );

    let (ref_src_dir, ref_inc_dir) =
        reference_layout(&reference).expect("reference layout checked in prerequisites");
    let gen_src = file_names(&out_dir.join("Core/Src"), ".c");
    let ref_src = reference_file_names(&reference, &ref_src_dir, ".c");
    assert_eq!(
        gen_src, ref_src,
        "generated Core/Src/*.c must equal reference {}/*.c EXACTLY",
        ref_src_dir.display()
    );
    let gen_inc = file_names(&out_dir.join("Core/Inc"), ".h");
    let ref_inc = reference_file_names(&reference, &ref_inc_dir, ".h");
    assert_eq!(
        gen_inc, ref_inc,
        "generated Core/Inc/*.h (incl. FreeRTOSConfig.h) must equal reference {}/*.h EXACTLY",
        ref_inc_dir.display()
    );

    // Middlewares tree: everything the reference CMake compiles/includes
    // must have been copied (manifest rel paths are /-separated).
    let files: BTreeSet<&str> = manifest.files.iter().map(String::as_str).collect();
    for need in REFERENCE_MIDDLEWARE_SOURCES.iter().chain(REFERENCE_MIDDLEWARE_HEADERS) {
        assert!(
            files.contains(need) && out_dir.join(need).is_file(),
            "Middlewares copy must cover the reference-compiled file {need}"
        );
    }
    // ... and the generated CMake must compile every reference-compiled
    // middleware source.
    let cmake = std::fs::read_to_string(out_dir.join("CMakeLists.txt")).unwrap();
    for need in REFERENCE_MIDDLEWARE_SOURCES {
        assert!(cmake.contains(need), "CMakeLists.txt must compile {need}");
    }

    // ---- 3. normalized per-function diff (python helper) --------------------
    let diff_tool = repo_root().join("tools/parity_diff.py");
    let whitelist = repo_root().join("tests/parity/odrive/parity-whitelist.md");
    let out = Command::new("python")
        .arg(&diff_tool)
        .arg(&out_dir)
        .arg(&reference)
        .arg(&whitelist)
        .output()
        .expect("spawn python parity_diff.py");
    let report = String::from_utf8_lossy(&out.stdout);
    eprintln!("--- parity_diff report ---\n{report}");
    assert!(
        out.status.success(),
        "normalized per-function diff found unwhitelisted deltas (or dead whitelist \
         rows):\n{report}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // ---- 5. determinism (before the build dirties the tree) -----------------
    let out_dir2 = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("odrive_parity_regen");
    if out_dir2.exists() {
        std::fs::remove_dir_all(&out_dir2).unwrap();
    }
    std::fs::create_dir_all(&out_dir2).unwrap();
    let manifest2 = generate_project(&pack, &resolved, &doc, &fw_dir, &out_dir2, "0.1.0")
        .expect("second generate_project");
    assert_eq!(manifest.files, manifest2.files, "manifests must list identical files");
    for rel in &manifest.files {
        let a = std::fs::read(out_dir.join(rel)).unwrap();
        let b = std::fs::read(out_dir2.join(rel)).unwrap();
        assert!(a == b, "non-deterministic output for {rel}");
    }

    // ---- 4. compile + link ---------------------------------------------------
    run(
        &out_dir,
        "cmake",
        &["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug"],
    );
    run(&out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("odrive_cubemx_demo.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());

    // Informational: .text size vs the reference build (when present).
    let gen_size = run(&out_dir, "arm-none-eabi-size", &[elf.to_str().unwrap()]);
    eprintln!("generated ELF size:\n{gen_size}");
    let ref_elf = reference.join("build/Debug/odrive_cubemx_demo.elf");
    if ref_elf.is_file() {
        let ref_size = run(&out_dir, "arm-none-eabi-size", &[ref_elf.to_str().unwrap()]);
        eprintln!("reference ELF size:\n{ref_size}");
    } else {
        eprintln!("note: reference build ELF not present; size comparison skipped");
    }
}
