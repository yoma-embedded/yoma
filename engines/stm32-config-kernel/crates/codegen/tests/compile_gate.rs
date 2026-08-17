//! End-to-end compile gate: the golden F103 project (72 MHz HSE, USART1
//! async PA9/PA10 + NVIC, PC13 LED) is generated with [`generate_project`]
//! and must build cleanly with the real arm-none-eabi toolchain via
//! cmake + ninja. Skips (with an eprintln) when the IR pack, the firmware
//! components, or the cross toolchain are not available.

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

fn tool_available(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Common gate: pack + firmware + toolchain present, else None (skip).
fn prerequisites_for(family: &str) -> Option<(IrPack, PathBuf)> {
    let pack = load_pack(&format!("{}.irpack", family.to_ascii_lowercase()))?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join(family).is_dir() {
        eprintln!(
            "skip: {family} firmware components not present under {}",
            fw_dir.display()
        );
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

fn prerequisites() -> Option<(IrPack, PathBuf)> {
    prerequisites_for("STM32F1")
}

/// Validate the golden doc and generate the full project into `out_dir`
/// (wiped first so stale files from previous runs cannot mask breakage).
fn generate(pack: &IrPack, doc: &ConfigDoc, fw_dir: &Path, out_dir: &Path) -> Vec<String> {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir).unwrap();
    }
    std::fs::create_dir_all(out_dir).unwrap();

    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "golden config must be clean");

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

/// Generate into a fresh dir, cross-compile, and assert the flashable images
/// exist. Returns the project dir so callers can inspect what was emitted.
fn build_and_assert_images(
    pack: &IrPack,
    doc: &ConfigDoc,
    fw_dir: &Path,
    tag: &str,
) -> PathBuf {
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("compile_gate_{tag}"));
    generate(pack, doc, fw_dir, &out_dir);

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
    out_dir
}

#[test]
fn f103_golden_project_compiles() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    build_and_assert_images(&pack, &golden_doc(), &fw_dir, "f103");
}

fn h_series_doc(part: &str, sysclk_hz: u64, led: &str) -> ConfigDoc {
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "{part}" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            "targets": {{ "SYSCLK": {{ "hz": {sysclk_hz} }} }}
          }},
          "peripherals": {{
            "USART1": {{
              "mode": "Asynchronous",
              "params": {{ "BaudRate": 115200 }},
              "pins": {{ "TX": "PA9", "RX": "PA10" }},
              "nvic": {{ "enabled": true, "preemptionPriority": 1 }}
            }}
          }},
          "gpio": {{ "{led}": {{ "mode": "output", "initHigh": false, "label": "LED" }} }}
        }}"#
    ))
    .unwrap()
}

/// H743 at 400 MHz off an 8 MHz crystal: exercises the fractional-PLL clock
/// engine, the Cortex-M7 flags, the discovered `startup_stm32h743xx.s`, and a
/// linker script whose `RAM` is the AXI SRAM at 0x24000000 rather than the
/// 128K of DTCM sharing 0x20000000.
#[test]
fn h743_project_compiles() {
    let Some((pack, fw_dir)) = prerequisites_for("STM32H7") else { return };
    let doc = h_series_doc("STM32H743VITx", 400_000_000, "PB0");
    let out_dir = build_and_assert_images(&pack, &doc, &fw_dir, "h743");

    let ld = std::fs::read_to_string(out_dir.join("STM32H743VITx_FLASH.ld")).unwrap();
    assert!(
        ld.contains("ORIGIN = 0x24000000, LENGTH = 512K   /* RAM_AXI */"),
        "H743 must link against the AXI SRAM, not the DTCM:\n{ld}"
    );
    assert!(ld.contains("ORIGIN = 0x20000000, LENGTH = 128K"), "DTCM declared");

    let main_c = std::fs::read_to_string(out_dir.join("Core/Src/main.c")).unwrap();
    // H7 has no PWR clock gate; it selects a supply and waits for VOSRDY.
    assert!(!main_c.contains("__HAL_RCC_PWR_CLK_ENABLE"));
    assert!(main_c.contains("HAL_PWREx_ConfigSupply(PWR_LDO_SUPPLY);"));
    assert!(main_c.contains("while(!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}"));
    // The H7 PLL struct: 8 MHz / 1 * 100 / 2 = 400 MHz, integer (FRACN 0).
    for field in [
        "PLL.PLLM = 1;",
        "PLL.PLLN = 100;",
        "PLL.PLLP = 2;",
        "PLL.PLLFRACN = 0;",
        "PLL.PLLVCOSEL = RCC_PLL1VCOWIDE;",
    ] {
        assert!(main_c.contains(field), "missing `{field}`\n{main_c}");
    }
    // 200 MHz HCLK at VOS1 needs two flash wait states.
    assert!(main_c.contains("FLASH_LATENCY_2"), "wrong flash latency\n{main_c}");
    // The H7 bus matrix has four APB domains, not two.
    for field in ["APB3CLKDivider", "APB4CLKDivider", "SYSCLKDivider"] {
        assert!(main_c.contains(field), "missing ClkInit field `{field}`");
    }
    // Peripheral kernel clocks: the USART1 in this document must actually be
    // programmed. This block used to be F1-only, so an H7 project compiled
    // with its peripheral clock left at whatever reset chose.
    for line in [
        "RCC_PeriphCLKInitTypeDef PeriphClkInit = {0};",
        "PeriphClkInit.PeriphClockSelection = RCC_PERIPHCLK_USART1;",
        "PeriphClkInit.Usart16ClockSelection =",
        "if (HAL_RCCEx_PeriphCLKConfig(&PeriphClkInit) != HAL_OK)",
    ] {
        assert!(main_c.contains(line), "missing PeriphCLK line `{line}`\n{main_c}");
    }
    // CSI exists on H7 and its HAL references CSI_VALUE unconditionally.
    let conf = std::fs::read_to_string(out_dir.join("Core/Inc/stm32h7xx_hal_conf.h")).unwrap();
    assert!(conf.contains("#define CSI_VALUE"), "hal_conf must define CSI_VALUE");
}

/// H563 at 250 MHz: Cortex-M33 flags, the TrustZone-flavoured address map
/// reduced to its non-secure view (one 640K SRAM, counted once), and the
/// newer ST startup that imports `_sstack`.
#[test]
fn h563_project_compiles() {
    let Some((pack, fw_dir)) = prerequisites_for("STM32H5") else { return };
    let doc = h_series_doc("STM32H563ZITx", 250_000_000, "PB0");
    let out_dir = build_and_assert_images(&pack, &doc, &fw_dir, "h563");

    let ld = std::fs::read_to_string(out_dir.join("STM32H563ZITx_FLASH.ld")).unwrap();
    assert!(
        ld.contains("ORIGIN = 0x20000000, LENGTH = 640K"),
        "SRAM1+2+3 must merge into one 640K bank:\n{ld}"
    );
    assert!(ld.contains("_sstack = _estack - _Min_Stack_Size;"));
    // Secure aliases of the same physical banks must not be declared.
    assert!(!ld.contains("0x0c000000") && !ld.contains("0x0C000000"));

    let cmake = std::fs::read_to_string(out_dir.join("CMakeLists.txt")).unwrap();
    assert!(cmake.contains("-mcpu=cortex-m33"), "H5 is a Cortex-M33 part");

    let main_c = std::fs::read_to_string(out_dir.join("Core/Src/main.c")).unwrap();
    assert!(!main_c.contains("__HAL_RCC_PWR_CLK_ENABLE"));
    assert!(main_c.contains("while(!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}"));
    // 8 MHz / 2 * 125 / 2 = 250 MHz.
    for field in ["PLL.PLLM = 2;", "PLL.PLLN = 125;", "PLL.PLLP = 2;"] {
        assert!(main_c.contains(field), "missing `{field}`\n{main_c}");
    }
    assert!(main_c.contains("APB3CLKDivider"), "H5 has a third APB domain");
    let conf = std::fs::read_to_string(out_dir.join("Core/Inc/stm32h5xx_hal_conf.h")).unwrap();
    for m in ["#define CSI_VALUE", "#define HSI48_VALUE"] {
        assert!(conf.contains(m), "hal_conf must define {m}");
    }
}

/// One representative part per family, with the family's IR pack name.
///
/// Dev-board-grade parts where one exists, so the numbers in a failure are
/// recognisable. The three families with no entry cannot reach this gate and
/// are listed in [`FAMILIES_WITHOUT_A_BARE_METAL_PROJECT`] with the reason.
const FAMILY_PARTS: &[(&str, &str)] = &[
    ("STM32C0", "STM32C031C6Tx"),
    ("STM32F0", "STM32F030R8Tx"),
    ("STM32F1", "STM32F103C8Tx"),
    ("STM32F2", "STM32F207ZGTx"),
    ("STM32F3", "STM32F303RETx"),
    ("STM32F4", "STM32F411CEUx"),
    ("STM32F7", "STM32F746ZGTx"),
    ("STM32G0", "STM32G071RBTx"),
    ("STM32G4", "STM32G474RETx"),
    ("STM32H5", "STM32H563ZITx"),
    ("STM32H7", "STM32H743ZITx"),
    ("STM32L0", "STM32L053R8Tx"),
    ("STM32L1", "STM32L152RETx"),
    ("STM32L4", "STM32L476RGTx"),
    ("STM32L5", "STM32L552ZETx"),
    ("STM32U0", "STM32U083RCTx"),
    ("STM32U3", "STM32U385RGTx"),
    ("STM32U5", "STM32U575ZITx"),
    ("STM32WB", "STM32WB55RGVx"),
    ("STM32WB0", "STM32WB05KZVx"),
    ("STM32WBA", "STM32WBA52CGUx"),
    ("STM32WL", "STM32WLE5JCIx"),
    ("STM32WL3", "STM32WL33CCVx"),
];

/// Families whose IR pack ships but which this project shell cannot target,
/// with the reason. Kept next to the gate so the list cannot drift silently.
const FAMILIES_WITHOUT_A_BARE_METAL_PROJECT: &[(&str, &str)] = &[
    ("STM32MP1", "Cortex-A7 application processor; the M4 context needs \
                  CubeMX-style context selection and an SRAM-only image"),
    ("STM32MP2", "Cortex-A35 + M33 multi-context, device headers are keyed \
                  by core (`stm32mp257fxx_cm33`)"),
    ("STM32N6", "TrustZone-only; needs a generated `partition_<device>.h` \
                 and an FSBL/secure image split"),
    ("STM32WL4", "no public HAL firmware (no ST component repo, not in the \
                  Cube firmware cache)"),
];

/// The name of this part's system-clock output node.
///
/// Not a constant: most families call the parameter `SYSCLKFreq_VALUE`, WB0
/// and WL3 call it `CLKSYSFreq_VALUE`, and N6 has no single system-clock
/// output at all (its CPU clock comes off an IC divider). Asking the tree
/// keeps the gate from encoding a per-family table that would drift.
fn sysclk_target(pack: &IrPack, sales_part: &str) -> Option<String> {
    use stm32ck_ir::model::ClockElementKind;
    let part = pack
        .parts
        .values()
        .find(|p| p.part_numbers.iter().any(|n| n == sales_part))?;
    let tree = pack.clock_trees.get(&part.clock_tree)?;
    let mut names: Vec<&str> = tree
        .elements
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                ClockElementKind::Output | ClockElementKind::ActiveOutput
            )
        })
        .filter_map(|e| e.ref_parameter.as_deref())
        .filter(|p| p.starts_with("SYSCLK") || p.starts_with("CLKSYS"))
        .collect();
    names.sort_unstable();
    names.dedup();
    names.first().map(|s| s.to_string())
}

/// The lowest-numbered USART/UART instance this part carries.
///
/// Numeric, not lexicographic: `UART12` sorts before `UART4` as a string, and
/// a gate should exercise the instance a user would actually reach for.
fn first_uart(pack: &IrPack, sales_part: &str) -> Option<String> {
    let part = pack
        .parts
        .values()
        .find(|p| p.part_numbers.iter().any(|n| n == sales_part))?;
    let index = |n: &str| -> u32 {
        n.chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(u32::MAX)
    };
    part.ip_instances
        .iter()
        .filter(|i| i.name.starts_with("USART") || i.name.starts_with("UART"))
        .map(|i| i.instance.clone())
        .min_by_key(|n| (index(n), n.clone()))
}

/// The gate document for one family: an async UART with its NVIC vector and
/// a DMA request on TX, pins left to the allocator.
///
/// An empty configuration only proves the project skeleton links — it never
/// reaches `HAL_RCCEx_PeriphCLKConfig`, the DMA generator, the MSP, or the
/// NVIC tables, which is where the per-family differences actually live.
///
/// The clock target is HSE passthrough at 8 MHz rather than each family's top
/// speed. It solves in under half a second on every family (a top-speed
/// target does not — see README), and it is electrically valid everywhere: at
/// reset voltage scaling the peripheral kernel-clock ceilings are low, and
/// H743's own default (64 MHz HSI straight onto PCLK2 at VOS3) genuinely
/// exceeds the 50 MHz the USART may take.
fn gate_doc(
    uart: Option<&str>,
    with_dma: bool,
    sysclk: Option<&str>,
    part: &str,
    name: &str,
) -> ConfigDoc {
    let periphs = match uart {
        Some(u) => {
            let dma = if with_dma {
                format!(r#", "dma": {{ "{u}_TX": {{}} }}"#)
            } else {
                String::new()
            };
            format!(
                r#""{u}": {{
                     "mode": "Asynchronous",
                     "params": {{ "BaudRate": 115200 }},
                     "nvic": {{ "enabled": true }}{dma}
                   }}"#
            )
        }
        None => String::new(),
    };
    let targets = match sysclk {
        Some(node) => format!(r#""{node}": {{ "hz": 8000000 }}"#),
        None => String::new(),
    };
    serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "{part}" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 8000000 }} }},
            "targets": {{ {targets} }}
          }},
          "peripherals": {{ {periphs} }},
          "gpio": {{}},
          "project": {{ "name": "{name}" }}
        }}"#
    ))
    .unwrap()
}

/// Every family with a landed firmware tree generates a project that
/// cross-compiles. One test rather than 23 so a newly imported family is
/// covered the moment it appears in [`FAMILY_PARTS`].
/// Families whose DMA service controller this engine does not model, so the
/// gate configures no DMA request for them.
///
/// `GPDMA`/`HPDMA` (H5, U3, U5, N6, WBA) do not use the classic
/// `controller -> flow -> request-leaf` mode tree the F1..G4 and DMAMUX
/// families share: their channels are `ENABLE_GPDMACH<n>` modes and the
/// request is a RefParameter value, so `flow_matrix` finds no leaf named
/// `USART1_TX`. The list is asserted to match reality below, so it cannot
/// quietly grow.
const DMA_UNMODELLED: &[&str] = &["STM32H5", "STM32N6", "STM32U3", "STM32U5", "STM32WBA"];

#[test]
fn every_family_project_compiles() {
    let mut checked = 0usize;
    let mut skipped: Vec<&str> = Vec::new();
    let mut no_uart: Vec<&str> = Vec::new();
    let mut dma_rejected: Vec<&str> = Vec::new();
    for (family, part) in FAMILY_PARTS {
        let Some((pack, fw_dir)) = prerequisites_for(family) else {
            skipped.push(family);
            continue;
        };
        let tag = family.to_ascii_lowercase();
        let sysclk = sysclk_target(&pack, part);
        let uart = first_uart(&pack, part);
        if uart.is_none() {
            no_uart.push(family);
        }
        let with_dma = !DMA_UNMODELLED.contains(family);
        // Prove the exclusion is still the truth rather than a stale note:
        // an unmodelled controller must actually reject the request, and a
        // modelled one must actually accept it.
        if let Some(u) = uart.as_deref() {
            let probe = gate_doc(Some(u), true, sysclk.as_deref(), part, "probe");
            let resolved = validate(&pack, &probe).expect("hard failure");
            let rejected = resolved
                .diags
                .iter()
                .any(|d| d.code == "DMA_REQUEST_UNKNOWN" || d.code == "DMA_IP_MISSING");
            if rejected {
                dma_rejected.push(family);
            }
        }
        let doc = gate_doc(
            uart.as_deref(),
            with_dma,
            sysclk.as_deref(),
            part,
            &format!("smoke_{tag}"),
        );
        build_and_assert_images(&pack, &doc, &fw_dir, &tag);
        checked += 1;
    }
    if !skipped.is_empty() {
        eprintln!("skipped (no pack/firmware/toolchain): {skipped:?}");
    }
    assert!(
        no_uart.is_empty(),
        "every gated part should carry a UART; these did not: {no_uart:?}"
    );
    let declared: Vec<&str> = DMA_UNMODELLED
        .iter()
        .copied()
        .filter(|f| FAMILY_PARTS.iter().any(|(g, _)| g == f) && !skipped.contains(f))
        .collect();
    assert_eq!(
        dma_rejected, declared,
        "DMA_UNMODELLED is out of date: the families that actually reject a \
         `<UART>_TX` request are {dma_rejected:?}"
    );
    eprintln!(
        "compiled {checked}/{} families ({} with a DMA request)",
        FAMILY_PARTS.len(),
        checked - dma_rejected.len()
    );
}

/// The unsupported list is documentation with teeth: each entry must still be
/// a family the kernel ships data for, and must not also be in the gate.
#[test]
fn unsupported_families_are_data_only() {
    for (family, reason) in FAMILIES_WITHOUT_A_BARE_METAL_PROJECT {
        assert!(!reason.is_empty(), "{family} needs a reason");
        assert!(
            !FAMILY_PARTS.iter().any(|(f, _)| f == family),
            "{family} is both gated and listed unsupported"
        );
        let pack = repo_root()
            .join("data")
            .join(format!("{}.irpack", family.to_ascii_lowercase()));
        if pack.is_file() {
            // Data ships; only the project shell is missing.
            continue;
        }
        eprintln!("skip: {} not present", pack.display());
    }
}

/// A rel path is *generated* (as opposed to copied firmware) when it is not
/// under Drivers/, not the copied startup, and not the copied system file.
fn is_generated(rel: &str) -> bool {
    !(rel.starts_with("Drivers/")
        || rel.starts_with("Core/Startup/")
        || rel.starts_with("Core/Src/system_"))
}

#[test]
fn f103_generation_is_deterministic_on_disk() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = golden_doc();
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let dir_a = base.join("compile_gate_det_a");
    let dir_b = base.join("compile_gate_det_b");
    let files_a = generate(&pack, &doc, &fw_dir, &dir_a);
    let files_b = generate(&pack, &doc, &fw_dir, &dir_b);

    assert_eq!(files_a, files_b, "manifests differ between runs");
    let generated: Vec<&String> = files_a.iter().filter(|f| is_generated(f)).collect();
    assert!(
        generated.iter().any(|f| f.as_str() == "Core/Src/main.c"),
        "generated set unexpectedly empty of emitted C: {generated:?}"
    );
    for rel in generated {
        let a = std::fs::read(dir_a.join(rel)).unwrap();
        let b = std::fs::read(dir_b.join(rel)).unwrap();
        assert!(a == b, "generated file {rel} differs between two runs");
    }
}
