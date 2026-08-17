//! FreeRTOS middleware generator (P5). Spec: docs/middleware-gen-spec.md §2,
//! mining evidence: docs/mining/mine-freertos.md.
//!
//! Scope (v1): CMSIS-RTOS **v1** wrapper (`cmsis_os.c` V1.02) over kernel
//! V10.3.1, wired exactly like the ODrive reference project. A document
//! selecting `api: CMSIS_V2` still generates v1-style output and gets a
//! warning diagnostic (v2 codegen is deferred). Deferred as well: the
//! `SysTick_Handler`+`osSystickHandler()` combo CubeMX emits when FreeRTOS
//! runs on a SysTick HAL timebase (we warn instead — spec mining Q3 shows
//! CubeMX itself only warns), and the timers/queues/semaphores object
//! tables (config knobs pass through, objects beyond tasks are not in the
//! frozen config contract).

use super::{CmakeAdditions, MainHooks, MiddlewareGen};
use crate::{GenCtx, GeneratedFile};
use anyhow::ensure;
use std::path::Path;
use stm32ck_engine::config::{FreertosCfg, RtosTask};
use stm32ck_engine::diag::Diagnostic;

pub struct FreertosGen;

impl MiddlewareGen for FreertosGen {
    fn name(&self) -> &'static str {
        "freertos"
    }

    fn applies(&self, ctx: &GenCtx<'_>) -> bool {
        ctx.doc
            .middleware
            .as_ref()
            .is_some_and(|m| m.freertos.is_some())
    }

    /// `Core/Inc/FreeRTOSConfig.h` (spec §2.1) + `Core/Src/freertos.c`
    /// (spec §2.2).
    fn files(&self, ctx: &GenCtx<'_>) -> anyhow::Result<Vec<GeneratedFile>> {
        Ok(vec![
            GeneratedFile {
                rel_path: "Core/Inc/FreeRTOSConfig.h".to_string(),
                content: freertos_config_h(ctx),
            },
            GeneratedFile {
                rel_path: "Core/Src/freertos.c".to_string(),
                content: freertos_c(ctx),
            },
        ])
    }

    /// main.c integration (spec §1.3/§2.3, CMSIS v1: NO `osKernelInitialize`).
    fn main_hooks(&self, _ctx: &GenCtx<'_>) -> MainHooks {
        MainHooks {
            includes: vec!["cmsis_os.h".to_string()],
            prototypes: vec!["void MX_FREERTOS_Init(void);".to_string()],
            post_init_calls: vec![
                // Stock CubeMX text says cmsis_os2.c even for v1 (spec §2.3).
                "  /* Call init function for freertos objects (in cmsis_os2.c) */".to_string(),
                "  MX_FREERTOS_Init();".to_string(),
                String::new(),
                "  /* Start scheduler */".to_string(),
                "  osKernelStart();".to_string(),
                String::new(),
                "  /* We should never get here as control is now taken by the scheduler */"
                    .to_string(),
            ],
            ..MainHooks::default()
        }
    }

    /// The port owns SVC/PendSV always (`vPortSVCHandler`/`xPortPendSVHandler`
    /// aliases) and SysTick too when the HAL timebase is a TIM (spec §2.4:
    /// CubeMX deletes all three from it.c/it.h).
    fn suppressed_it_handlers(&self, ctx: &GenCtx<'_>) -> Vec<String> {
        let mut v = vec!["SVC_Handler".to_string(), "PendSV_Handler".to_string()];
        if ctx.resolved.timebase.is_some() {
            v.push("SysTick_Handler".to_string());
        }
        v
    }

    /// Engine-side couplings this generator cannot enforce (config.rs and
    /// session.rs are frozen): warn like CubeMX's pre-generate dialog does
    /// (mining Q3 — a warning, never forced).
    fn diagnostics(&self, ctx: &GenCtx<'_>) -> Vec<Diagnostic> {
        let mut diags = Vec::new();
        if port_dir(&ctx.resolved.part.core).is_none() {
            diags.push(unsupported_core(&ctx.resolved.part.core));
        }
        let cfg = cfg(ctx);
        if cfg.api != "CMSIS_V1" {
            diags.push(Diagnostic::warning(
                "MW_FREERTOS_API",
                "/middleware/freertos/api",
                format!(
                    "FreeRTOS api `{}` is not implemented yet; CMSIS_V1-style \
                     code was generated (v2 codegen is deferred)",
                    cfg.api
                ),
            ));
        }
        if ctx.doc.project.hal_timebase.is_none() {
            diags.push(
                Diagnostic::warning(
                    "MW_FREERTOS_TIMEBASE",
                    "/project/halTimebase",
                    "when FreeRTOS is used, it is strongly recommended to use a HAL \
                     timebase source other than the SysTick (the port takes over \
                     SysTick_Handler)",
                )
                .with_suggestion("set project.halTimebase to a basic timer, e.g. \"TIM14\""),
            );
        }
        if let Some(pg) = ctx.doc.nvic.priority_group.as_deref() {
            if pg != "NVIC_PRIORITYGROUP_4" {
                diags.push(Diagnostic::warning(
                    "MW_FREERTOS_PRIORITY_GROUP",
                    "/nvic/priorityGroup",
                    format!(
                        "FreeRTOS requires NVIC_PRIORITYGROUP_4 (all bits preemption); \
                         `{pg}` breaks configMAX_SYSCALL_INTERRUPT_PRIORITY masking"
                    ),
                ));
            }
        }
        diags
    }

    /// hal_conf: nothing — `USE_RTOS` stays `0U` even with FreeRTOS on
    /// (spec §3.4), and no module enables are needed.
    fn hal_conf_defines(&self, _ctx: &GenCtx<'_>) -> Vec<String> {
        Vec::new()
    }

    /// Kernel + wrapper + port sources and include dirs (spec §2.6 — the
    /// exact set of the reference cmake/stm32cubemx list, croutine.c
    /// included), flattened into the single add_executable/-I lists.
    fn cmake(&self, ctx: &GenCtx<'_>) -> CmakeAdditions {
        const ROOT: &str = "Middlewares/Third_Party/FreeRTOS/Source";
        let Some(port) = port_dir(&ctx.resolved.part.core) else {
            return CmakeAdditions::default(); // copy_sources reports the error
        };
        let mut sources = vec!["Core/Src/freertos.c".to_string()];
        for f in KERNEL_SOURCES {
            sources.push(format!("{ROOT}/{f}"));
        }
        sources.push(format!("{ROOT}/CMSIS_RTOS/cmsis_os.c"));
        sources.push(format!("{ROOT}/portable/MemMang/heap_4.c"));
        sources.push(format!("{ROOT}/portable/GCC/{port}/port.c"));
        CmakeAdditions {
            sources,
            includes: vec![
                format!("{ROOT}/include"),
                format!("{ROOT}/CMSIS_RTOS"),
                format!("{ROOT}/portable/GCC/{port}"),
            ],
            defines: Vec::new(),
        }
    }

    /// Copy the needed FreeRTOS payload subset from
    /// `<fw>/MW/FreeRTOS/Source` into `Middlewares/Third_Party/FreeRTOS/
    /// Source` mirroring the reference layout: the 7 kernel .c files +
    /// LICENSE, all of include/, the CMSIS v1 wrapper, heap_4.c and the
    /// GCC port dir.
    fn copy_sources(
        &self,
        ctx: &GenCtx<'_>,
        fw: &Path,
        out: &Path,
    ) -> anyhow::Result<Vec<String>> {
        const ROOT: &str = "Middlewares/Third_Party/FreeRTOS/Source";
        let src_root = fw.join("MW").join("FreeRTOS").join("Source");
        ensure!(
            src_root.is_dir(),
            "FreeRTOS firmware payload not found at {} (expected <fw>/MW/FreeRTOS/Source)",
            src_root.display()
        );
        let core = &ctx.resolved.part.core;
        let Some(port) = port_dir(core) else {
            anyhow::bail!("{}", unsupported_core(core).message);
        };

        let mut rels: Vec<String> = KERNEL_SOURCES.iter().map(|f| f.to_string()).collect();
        if src_root.join("LICENSE").is_file() {
            rels.push("LICENSE".to_string());
        }
        rels.extend(dir_files(&src_root.join("include"), "include")?);
        rels.push("CMSIS_RTOS/cmsis_os.c".to_string());
        rels.push("CMSIS_RTOS/cmsis_os.h".to_string());
        rels.push("portable/MemMang/heap_4.c".to_string());
        let port_rel = format!("portable/GCC/{port}");
        let port_dir_abs = src_root.join(port_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        rels.extend(dir_files(&port_dir_abs, &port_rel)?);

        let mut copied = Vec::new();
        for rel in rels {
            let from = src_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            ensure!(from.is_file(), "FreeRTOS payload file missing: {}", from.display());
            let dest_rel = format!("{ROOT}/{rel}");
            let dest = out.join(&dest_rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &dest)?;
            copied.push(dest_rel);
        }
        copied.sort();
        Ok(copied)
    }
}

/// Kernel core sources (spec §2.6 / Configs.xml component list — croutine
/// stays in even though configUSE_CO_ROUTINES is 0, exactly like CubeMX).
const KERNEL_SOURCES: [&str; 7] = [
    "croutine.c",
    "event_groups.c",
    "list.c",
    "queue.c",
    "stream_buffer.c",
    "tasks.c",
    "timers.c",
];

/// FreeRTOS GCC port directory for a core (mining Q5: no computation in
/// CubeMX — each family's Configs.xml pins the dir; this is the equivalent
/// static table for the cores the project shell supports). M4 parts that
/// reach here have an FPU (F4/G4/L4), hence CM4F. `None` for cores whose
/// port is not vendored: M33/M23 need the TrustZone-split CM33_NTZ port and
/// a CMSIS-RTOS2 wrapper (CubeMX ships those via X-CUBE-FREERTOS, not the
/// classic bundle this generator mirrors) — and note the order: "m33"
/// contains "m3", so the M33 test must run before the M3 one.
fn port_dir(core: &str) -> Option<&'static str> {
    let c = core.to_ascii_lowercase();
    if c.contains("m33") || c.contains("m23") {
        None
    } else if c.contains("m7") {
        Some("ARM_CM7/r0p1")
    } else if c.contains("m4") {
        Some("ARM_CM4F")
    } else if c.contains("m3") {
        Some("ARM_CM3")
    } else if c.contains("m0") {
        Some("ARM_CM0")
    } else {
        None
    }
}

/// Diagnostic for a core with no vendored port (shared by cmake/copy paths).
fn unsupported_core(core: &str) -> Diagnostic {
    Diagnostic::error(
        "MW_FREERTOS_CORE",
        "/middleware/freertos",
        format!(
            "FreeRTOS generation covers Cortex-M0/M0+/M3/M4F/M7; `{core}` has \
             no vendored GCC port in this kernel version"
        ),
    )
}

/// Sorted `rel_prefix/<file>` entries for every plain file in `dir`.
fn dir_files(dir: &Path, rel_prefix: &str) -> anyhow::Result<Vec<String>> {
    ensure!(dir.is_dir(), "FreeRTOS payload dir missing: {}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    Ok(names.into_iter().map(|n| format!("{rel_prefix}/{n}")).collect())
}

/// The freertos config this generator was gated on ([`MiddlewareGen::applies`]).
fn cfg<'a>(ctx: &GenCtx<'a>) -> &'a FreertosCfg {
    ctx.doc
        .middleware
        .as_ref()
        .and_then(|m| m.freertos.as_ref())
        .expect("FreertosGen hook called without applies() gate")
}

/// Whether the USB Device middleware is configured too (cross-middleware
/// handshake: MX_USB_DEVICE_Init is then deferred to the default task and
/// NOT called from main() — spec §4.5).
fn usb_configured(ctx: &GenCtx<'_>) -> bool {
    ctx.doc
        .middleware
        .as_ref()
        .is_some_and(|m| m.usb_device.is_some())
}

/// Render a raw config knob value as-is (config.rs contract).
fn render(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(true) => "1".to_string(),
        serde_json::Value::Bool(false) => "0".to_string(),
        other => other.to_string(),
    }
}

/// Effective value of one FreeRTOSConfig knob: user override merged over
/// the generator default.
fn knob(cfg: &FreertosCfg, name: &str, default: &str) -> String {
    cfg.config
        .get(name)
        .map(render)
        .unwrap_or_else(|| default.to_string())
}

/// ioc integer -> CMSIS-RTOS v1 priority enum (mining Q2, Conversion.java:
/// -3=Idle .. 0=Normal .. 3=Realtime; anything else clamps to Normal).
fn os_priority(p: i32) -> &'static str {
    match p {
        -3 => "osPriorityIdle",
        -2 => "osPriorityLow",
        -1 => "osPriorityBelowNormal",
        1 => "osPriorityAboveNormal",
        2 => "osPriorityHigh",
        3 => "osPriorityRealtime",
        _ => "osPriorityNormal",
    }
}

/// osThreadCreate argument: `NULL` stays bare, anything else gets the
/// `(void*) ` prefix CubeMX adds (mining Q2, ThreadTable.java).
fn task_arg(t: &RtosTask) -> String {
    let p = t.parameter.trim();
    if p.is_empty() || p == "NULL" {
        "NULL".to_string()
    } else if p.starts_with("(void*)") {
        p.to_string()
    } else {
        format!("(void*) {p}")
    }
}

// ---------------------------------------------------------------------------
// FreeRTOSConfig.h (spec §2.1)
// ---------------------------------------------------------------------------

/// `#define {name:<width}{value}` (column-aligned like the reference; falls
/// back to a single space when the name overflows the column).
fn def(out: &mut String, name: &str, value: &str, width: usize) {
    if name.len() >= width {
        out.push_str(&format!("#define {name} {value}\n"));
    } else {
        out.push_str(&format!("#define {name:<width$}{value}\n"));
    }
}

/// Macro names the skeleton below places explicitly (or owns as a fixed
/// derivation); every other key in `middleware.freertos.config` is
/// appended in the extras block.
const KNOWN_KNOBS: [&str; 35] = [
    "configENABLE_FPU",
    "configENABLE_MPU",
    "configUSE_PREEMPTION",
    "configSUPPORT_STATIC_ALLOCATION",
    "configSUPPORT_DYNAMIC_ALLOCATION",
    "configUSE_IDLE_HOOK",
    "configUSE_TICK_HOOK",
    "configTICK_RATE_HZ",
    "configMAX_PRIORITIES",
    "configMINIMAL_STACK_SIZE",
    "configTOTAL_HEAP_SIZE",
    "configMAX_TASK_NAME_LEN",
    "configUSE_16_BIT_TICKS",
    "configUSE_MUTEXES",
    "configQUEUE_REGISTRY_SIZE",
    "configCHECK_FOR_STACK_OVERFLOW",
    "configUSE_PORT_OPTIMISED_TASK_SELECTION",
    "configUSE_CO_ROUTINES",
    "configMAX_CO_ROUTINE_PRIORITIES",
    "configLIBRARY_LOWEST_INTERRUPT_PRIORITY",
    "configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY",
    "INCLUDE_vTaskPrioritySet",
    "INCLUDE_uxTaskPriorityGet",
    "INCLUDE_vTaskDelete",
    "INCLUDE_vTaskCleanUpResources",
    "INCLUDE_vTaskSuspend",
    "INCLUDE_vTaskDelayUntil",
    "INCLUDE_vTaskDelay",
    "INCLUDE_xTaskGetSchedulerState",
    "INCLUDE_uxTaskGetStackHighWaterMark",
    // Fixed derivations / skeleton-owned (never duplicated into extras).
    "configCPU_CLOCK_HZ",
    "configPRIO_BITS",
    "configKERNEL_INTERRUPT_PRIORITY",
    "configMAX_SYSCALL_INTERRUPT_PRIORITY",
    "configMESSAGE_BUFFER_LENGTH_TYPE",
];

fn freertos_config_h(ctx: &GenCtx<'_>) -> String {
    let cfg = cfg(ctx);
    // Timebase != SysTick decides the xPortSysTickHandler alias state
    // (spec §2.1 surprise #1) and the extra prototype (mining Q1).
    let tim_timebase = ctx.resolved.timebase.is_some();
    let w = 41; // value column 49 in the main block
    let wi = 37; // value column 45 in the INCLUDE block

    let mut s = String::new();
    // FreeRTOS/Amazon MIT license header, verbatim from the reference file.
    s.push_str(
        "/* USER CODE BEGIN Header */\n\
         /*\n\
         \x20* FreeRTOS Kernel V10.3.1\n\
         \x20* Portion Copyright (C) 2017 Amazon.com, Inc. or its affiliates.  All Rights Reserved.\n\
         \x20* Portion Copyright (C) 2019 StMicroelectronics, Inc.  All Rights Reserved.\n\
         \x20*\n\
         \x20* Permission is hereby granted, free of charge, to any person obtaining a copy of\n\
         \x20* this software and associated documentation files (the \"Software\"), to deal in\n\
         \x20* the Software without restriction, including without limitation the rights to\n\
         \x20* use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of\n\
         \x20* the Software, and to permit persons to whom the Software is furnished to do so,\n\
         \x20* subject to the following conditions:\n\
         \x20*\n\
         \x20* The above copyright notice and this permission notice shall be included in all\n\
         \x20* copies or substantial portions of the Software.\n\
         \x20*\n\
         \x20* THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n\
         \x20* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS\n\
         \x20* FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR\n\
         \x20* COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER\n\
         \x20* IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN\n\
         \x20* CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\
         \x20*\n\
         \x20* http://www.FreeRTOS.org\n\
         \x20* http://aws.amazon.com/freertos\n\
         \x20*\n\
         \x20* 1 tab == 4 spaces!\n\
         \x20*/\n\
         /* USER CODE END Header */\n\n",
    );
    s.push_str("#ifndef FREERTOS_CONFIG_H\n#define FREERTOS_CONFIG_H\n\n");
    s.push_str(
        "/*-----------------------------------------------------------\n\
         \x20* Application specific definitions.\n\
         \x20*\n\
         \x20* These definitions should be adjusted for your particular hardware and\n\
         \x20* application requirements.\n\
         \x20*\n\
         \x20* These parameters and more are described within the 'configuration' section of the\n\
         \x20* FreeRTOS API documentation available on the FreeRTOS.org web site.\n\
         \x20*\n\
         \x20* See http://www.freertos.org/a00110.html\n\
         \x20*----------------------------------------------------------*/\n\n",
    );
    s.push_str(
        "/* USER CODE BEGIN Includes */\n\
         /* Section where include file can be added */\n\
         /* USER CODE END Includes */\n\n",
    );
    s.push_str(
        "/* Ensure definitions are only used by the compiler, and not by the assembler. */\n\
         #if defined(__ICCARM__) || defined(__CC_ARM) || defined(__GNUC__)\n\
         \x20 #include <stdint.h>\n\
         \x20 extern uint32_t SystemCoreClock;\n",
    );
    if !tim_timebase {
        // SysTick timebase: the port handler is called from the HAL-owned
        // SysTick_Handler, so its prototype is needed here (mining Q1).
        s.push_str("  void xPortSysTickHandler(void);\n");
    }
    s.push_str("#endif\n");
    def(&mut s, "configENABLE_FPU", &knob(cfg, "configENABLE_FPU", "0"), w);
    def(&mut s, "configENABLE_MPU", &knob(cfg, "configENABLE_MPU", "0"), w);
    s.push('\n');
    def(&mut s, "configUSE_PREEMPTION", &knob(cfg, "configUSE_PREEMPTION", "1"), w);
    def(
        &mut s,
        "configSUPPORT_STATIC_ALLOCATION",
        &knob(cfg, "configSUPPORT_STATIC_ALLOCATION", "1"),
        w,
    );
    def(
        &mut s,
        "configSUPPORT_DYNAMIC_ALLOCATION",
        &knob(cfg, "configSUPPORT_DYNAMIC_ALLOCATION", "1"),
        w,
    );
    def(&mut s, "configUSE_IDLE_HOOK", &knob(cfg, "configUSE_IDLE_HOOK", "0"), w);
    def(&mut s, "configUSE_TICK_HOOK", &knob(cfg, "configUSE_TICK_HOOK", "0"), w);
    // Fixed derivation, never a literal (mining Q1).
    def(&mut s, "configCPU_CLOCK_HZ", "( SystemCoreClock )", w);
    def(
        &mut s,
        "configTICK_RATE_HZ",
        &format!("((TickType_t){})", knob(cfg, "configTICK_RATE_HZ", "1000")),
        w,
    );
    def(
        &mut s,
        "configMAX_PRIORITIES",
        &format!("( {} )", knob(cfg, "configMAX_PRIORITIES", "7")),
        w,
    );
    def(
        &mut s,
        "configMINIMAL_STACK_SIZE",
        &format!("((uint16_t){})", knob(cfg, "configMINIMAL_STACK_SIZE", "128")),
        w,
    );
    // heapSize is the dedicated field; a raw configTOTAL_HEAP_SIZE knob wins.
    def(
        &mut s,
        "configTOTAL_HEAP_SIZE",
        &format!(
            "((size_t){})",
            knob(cfg, "configTOTAL_HEAP_SIZE", &cfg.heap_size.to_string())
        ),
        w,
    );
    def(
        &mut s,
        "configMAX_TASK_NAME_LEN",
        &format!("( {} )", knob(cfg, "configMAX_TASK_NAME_LEN", "16")),
        w,
    );
    def(&mut s, "configUSE_16_BIT_TICKS", &knob(cfg, "configUSE_16_BIT_TICKS", "0"), w);
    // Presence-conditional macros (mining Q1: omitted entirely at 0).
    let mutexes = knob(cfg, "configUSE_MUTEXES", "1");
    if mutexes != "0" {
        def(&mut s, "configUSE_MUTEXES", &mutexes, w);
    }
    def(
        &mut s,
        "configQUEUE_REGISTRY_SIZE",
        &knob(cfg, "configQUEUE_REGISTRY_SIZE", "8"),
        w,
    );
    let stack_ovf = knob(cfg, "configCHECK_FOR_STACK_OVERFLOW", "0");
    if stack_ovf != "0" {
        def(&mut s, "configCHECK_FOR_STACK_OVERFLOW", &stack_ovf, w);
    }
    def(
        &mut s,
        "configUSE_PORT_OPTIMISED_TASK_SELECTION",
        &knob(cfg, "configUSE_PORT_OPTIMISED_TASK_SELECTION", "1"),
        w,
    );
    s.push_str(
        "/* USER CODE BEGIN MESSAGE_BUFFER_LENGTH_TYPE */\n\
         /* Defaults to size_t for backward compatibility, but can be changed\n\
         \x20  if lengths will always be less than the number of bytes in a size_t. */\n\
         #define configMESSAGE_BUFFER_LENGTH_TYPE         size_t\n\
         /* USER CODE END MESSAGE_BUFFER_LENGTH_TYPE */\n\n",
    );
    s.push_str("/* Co-routine definitions. */\n");
    def(&mut s, "configUSE_CO_ROUTINES", &knob(cfg, "configUSE_CO_ROUTINES", "0"), w);
    def(
        &mut s,
        "configMAX_CO_ROUTINE_PRIORITIES",
        &format!("( {} )", knob(cfg, "configMAX_CO_ROUTINE_PRIORITIES", "2")),
        w,
    );
    s.push('\n');
    s.push_str(
        "/* Set the following definitions to 1 to include the API function, or zero\n\
         to exclude the API function. */\n",
    );
    def(&mut s, "INCLUDE_vTaskPrioritySet", &knob(cfg, "INCLUDE_vTaskPrioritySet", "1"), wi);
    def(&mut s, "INCLUDE_uxTaskPriorityGet", &knob(cfg, "INCLUDE_uxTaskPriorityGet", "1"), wi);
    def(&mut s, "INCLUDE_vTaskDelete", &knob(cfg, "INCLUDE_vTaskDelete", "1"), wi);
    def(
        &mut s,
        "INCLUDE_vTaskCleanUpResources",
        &knob(cfg, "INCLUDE_vTaskCleanUpResources", "0"),
        wi,
    );
    def(&mut s, "INCLUDE_vTaskSuspend", &knob(cfg, "INCLUDE_vTaskSuspend", "1"), wi);
    def(&mut s, "INCLUDE_vTaskDelayUntil", &knob(cfg, "INCLUDE_vTaskDelayUntil", "0"), wi);
    def(&mut s, "INCLUDE_vTaskDelay", &knob(cfg, "INCLUDE_vTaskDelay", "1"), wi);
    def(
        &mut s,
        "INCLUDE_xTaskGetSchedulerState",
        &knob(cfg, "INCLUDE_xTaskGetSchedulerState", "1"),
        wi,
    );
    // Conditional 9th INCLUDE (mining Q1: only 8 are unconditional).
    let hwm = knob(cfg, "INCLUDE_uxTaskGetStackHighWaterMark", "0");
    if hwm != "0" {
        def(&mut s, "INCLUDE_uxTaskGetStackHighWaterMark", &hwm, wi);
    }
    // Extra user knobs not covered by the skeleton, sorted (BTreeMap order).
    let extras: Vec<(&String, &serde_json::Value)> = cfg
        .config
        .iter()
        .filter(|(k, _)| !KNOWN_KNOBS.contains(&k.as_str()))
        .collect();
    if !extras.is_empty() {
        s.push('\n');
        s.push_str("/* Additional definitions from the configuration document. */\n");
        for (k, v) in extras {
            def(&mut s, k, &render(v), w);
        }
    }
    s.push('\n');
    s.push_str(
        "/* Cortex-M specific definitions. */\n\
         #ifdef __NVIC_PRIO_BITS\n\
         \x20/* __BVIC_PRIO_BITS will be specified when CMSIS is being used. */\n\
         \x20#define configPRIO_BITS         __NVIC_PRIO_BITS\n\
         #else\n\
         \x20#define configPRIO_BITS         4\n\
         #endif\n\n",
    );
    s.push_str(
        "/* The lowest interrupt priority that can be used in a call to a \"set priority\"\n\
         function. */\n",
    );
    s.push_str(&format!(
        "#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY   {}\n\n",
        knob(cfg, "configLIBRARY_LOWEST_INTERRUPT_PRIORITY", "15")
    ));
    s.push_str(
        "/* The highest interrupt priority that can be used by any interrupt service\n\
         routine that makes calls to interrupt safe FreeRTOS API functions.  DO NOT CALL\n\
         INTERRUPT SAFE FREERTOS API FUNCTIONS FROM ANY INTERRUPT THAT HAS A HIGHER\n\
         PRIORITY THAN THIS! (higher priorities are lower numeric values. */\n",
    );
    s.push_str(&format!(
        "#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY {}\n\n",
        knob(cfg, "configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY", "5")
    ));
    s.push_str(
        "/* Interrupt priorities used by the kernel port layer itself.  These are generic\n\
         to all Cortex-M ports, and do not rely on any particular library functions. */\n\
         #define configKERNEL_INTERRUPT_PRIORITY \t\t( configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS) )\n\
         /* !!!! configMAX_SYSCALL_INTERRUPT_PRIORITY must not be set to zero !!!!\n\
         See http://www.FreeRTOS.org/RTOS-Cortex-M3-M4.html. */\n\
         #define configMAX_SYSCALL_INTERRUPT_PRIORITY \t( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS) )\n\n",
    );
    s.push_str(
        "/* Normal assert() semantics without relying on the provision of an assert.h\n\
         header file. */\n\
         /* USER CODE BEGIN 1 */\n\
         #define configASSERT( x ) if ((x) == 0) {taskDISABLE_INTERRUPTS(); for( ;; );}\n\
         /* USER CODE END 1 */\n\n",
    );
    s.push_str(
        "/* Definitions that map the FreeRTOS port interrupt handlers to their CMSIS\n\
         standard names. */\n\
         #define vPortSVCHandler    SVC_Handler\n\
         #define xPortPendSVHandler PendSV_Handler\n\n",
    );
    if tim_timebase {
        // Uncommented: the port owns SysTick outright (spec §2.1 quirk).
        s.push_str(
            "/* IMPORTANT: This define is commented when used with STM32Cube firmware, when the timebase source is SysTick,\n\
             \x20             to prevent overwriting SysTick_Handler defined within STM32Cube HAL */\n\n\
             #define xPortSysTickHandler SysTick_Handler\n\n",
        );
    } else {
        s.push_str(
            "/* IMPORTANT: This define MUST be commented when used with STM32Cube firmware,\n\
             \x20             to prevent overwriting SysTick_Handler defined within STM32Cube HAL */\n\n\
             /* #define xPortSysTickHandler SysTick_Handler */\n\n",
        );
    }
    s.push_str(
        "/* USER CODE BEGIN Defines */\n\
         /* Section where parameter definitions can be added (for instance, to override default ones in FreeRTOS.h) */\n\
         /* USER CODE END Defines */\n\n\
         #endif /* FREERTOS_CONFIG_H */\n",
    );
    s
}

// ---------------------------------------------------------------------------
// freertos.c (spec §2.2)
// ---------------------------------------------------------------------------

/// First task index generating each entry function: a repeated entry
/// function gets one prototype and one body (mining Q2,
/// `generateStartFunction`/`alreadyGenerated`).
fn entry_owners(tasks: &[RtosTask]) -> Vec<usize> {
    let mut seen: Vec<&str> = Vec::new();
    let mut owners = Vec::new();
    for (i, t) in tasks.iter().enumerate() {
        if !seen.contains(&t.entry_function.as_str()) {
            seen.push(&t.entry_function);
            owners.push(i);
        }
    }
    owners
}

fn freertos_c(ctx: &GenCtx<'_>) -> String {
    let cfg = cfg(ctx);
    let usb = usb_configured(ctx);
    let idle_hook = knob(cfg, "configUSE_IDLE_HOOK", "0") != "0";
    let stack_ovf = knob(cfg, "configCHECK_FOR_STACK_OVERFLOW", "0") != "0";
    let static_alloc = knob(cfg, "configSUPPORT_STATIC_ALLOCATION", "1") != "0";
    let owners = entry_owners(&cfg.tasks);

    let mut s = String::new();
    s.push_str(&format!(
        "/* USER CODE BEGIN Header */\n\
         /**\n\
         \x20 ******************************************************************************\n\
         \x20 * File Name          : freertos.c\n\
         \x20 * Description        : Code for freertos applications\n\
         \x20 ******************************************************************************\n\
         \x20 * @attention\n\
         \x20 *\n\
         \x20 * Generated by stm32kernel {} -- IR pack {} (CubeMX db {}).\n\
         \x20 * Regenerated files keep user code only inside USER CODE sections.\n\
         \x20 *\n\
         \x20 ******************************************************************************\n\
         \x20 */\n\
         /* USER CODE END Header */\n\n",
        ctx.kernel_version, ctx.pack.family, ctx.pack.db_version
    ));
    s.push_str(
        "/* Includes ------------------------------------------------------------------*/\n\
         #include \"FreeRTOS.h\"\n\
         #include \"task.h\"\n\
         #include \"main.h\"\n\
         #include \"cmsis_os.h\"\n\n\
         /* Private includes ----------------------------------------------------------*/\n\
         /* USER CODE BEGIN Includes */\n\n\
         /* USER CODE END Includes */\n\n\
         /* Private typedef -----------------------------------------------------------*/\n\
         /* USER CODE BEGIN PTD */\n\n\
         /* USER CODE END PTD */\n\n\
         /* Private define ------------------------------------------------------------*/\n\
         /* USER CODE BEGIN PD */\n\n\
         /* USER CODE END PD */\n\n\
         /* Private macro -------------------------------------------------------------*/\n\
         /* USER CODE BEGIN PM */\n\n\
         /* USER CODE END PM */\n\n\
         /* Private variables ---------------------------------------------------------*/\n\
         /* USER CODE BEGIN Variables */\n\n\
         /* USER CODE END Variables */\n",
    );
    // One handle per task entry, no blank line between (spec §2.2); static
    // tasks add their stack buffer + control block (mining Q2 vars.ftl).
    for t in &cfg.tasks {
        s.push_str(&format!("osThreadId {}Handle;\n", t.name));
    }
    for t in cfg.tasks.iter().filter(|t| t.allocation == "Static") {
        s.push_str(&format!("uint32_t {}[ {} ];\n", t.buffer, t.stack_size));
        s.push_str(&format!("osStaticThreadDef_t {};\n", t.control_block));
    }
    s.push_str(
        "\n/* Private function prototypes -----------------------------------------------*/\n\
         /* USER CODE BEGIN FunctionPrototypes */\n\n\
         /* USER CODE END FunctionPrototypes */\n\n",
    );
    for &i in &owners {
        let t = &cfg.tasks[i];
        if t.code_generation == "As external" {
            s.push_str(&format!(
                "extern void {}(void const * argument);\n",
                t.entry_function
            ));
        } else {
            s.push_str(&format!("void {}(void const * argument);\n", t.entry_function));
        }
    }
    s.push('\n');
    if usb {
        // Deferred middleware init handshake (spec §2.2/§4.5).
        s.push_str("extern void MX_USB_DEVICE_Init(void);\n");
    }
    s.push_str("void MX_FREERTOS_Init(void); /* (MISRA C 2004 rule 8.1) */\n\n");
    if static_alloc {
        s.push_str(
            "/* GetIdleTaskMemory prototype (linked to static allocation support) */\n\
             void vApplicationGetIdleTaskMemory( StaticTask_t **ppxIdleTaskTCBBuffer, StackType_t **ppxIdleTaskStackBuffer, uint32_t *pulIdleTaskStackSize );\n\n",
        );
    }
    s.push_str("/* Hook prototypes */\n");
    if idle_hook {
        s.push_str("void vApplicationIdleHook(void);\n");
    }
    if stack_ovf {
        s.push_str("void vApplicationStackOverflowHook(xTaskHandle xTask, signed char *pcTaskName);\n");
    }
    s.push('\n');
    // Hook stub bodies live INSIDE the numbered USER CODE sections
    // (spec §2.2: idle -> 2, stack overflow -> 4).
    if idle_hook {
        s.push_str(
            "/* USER CODE BEGIN 2 */\n\
             __weak void vApplicationIdleHook( void )\n\
             {\n\
             \x20  /* vApplicationIdleHook() will only be called if configUSE_IDLE_HOOK is set\n\
             \x20  to 1 in FreeRTOSConfig.h. It will be called on each iteration of the idle\n\
             \x20  task. It is essential that code added to this hook function never attempts\n\
             \x20  to block in any way (for example, call xQueueReceive() with a block time\n\
             \x20  specified, or call vTaskDelay()). If the application makes use of the\n\
             \x20  vTaskDelete() API function (as this demo application does) then it is also\n\
             \x20  important that vApplicationIdleHook() is permitted to return to its calling\n\
             \x20  function, because it is the responsibility of the idle task to clean up\n\
             \x20  memory allocated by the kernel to any task that has since been deleted. */\n\
             }\n\
             /* USER CODE END 2 */\n\n",
        );
    } else {
        s.push_str("/* USER CODE BEGIN 2 */\n\n/* USER CODE END 2 */\n\n");
    }
    if stack_ovf {
        s.push_str(
            "/* USER CODE BEGIN 4 */\n\
             __weak void vApplicationStackOverflowHook(xTaskHandle xTask, signed char *pcTaskName)\n\
             {\n\
             \x20  /* Run time stack overflow checking is performed if\n\
             \x20  configCHECK_FOR_STACK_OVERFLOW is defined to 1 or 2. This hook function is\n\
             \x20  called if a stack overflow is detected. */\n\
             }\n\
             /* USER CODE END 4 */\n\n",
        );
    } else {
        s.push_str("/* USER CODE BEGIN 4 */\n\n/* USER CODE END 4 */\n\n");
    }
    if static_alloc {
        s.push_str(
            "/* USER CODE BEGIN GET_IDLE_TASK_MEMORY */\n\
             static StaticTask_t xIdleTaskTCBBuffer;\n\
             static StackType_t xIdleStack[configMINIMAL_STACK_SIZE];\n\n\
             void vApplicationGetIdleTaskMemory( StaticTask_t **ppxIdleTaskTCBBuffer, StackType_t **ppxIdleTaskStackBuffer, uint32_t *pulIdleTaskStackSize )\n\
             {\n\
             \x20 *ppxIdleTaskTCBBuffer = &xIdleTaskTCBBuffer;\n\
             \x20 *ppxIdleTaskStackBuffer = &xIdleStack[0];\n\
             \x20 *pulIdleTaskStackSize = configMINIMAL_STACK_SIZE;\n\
             \x20 /* place for user code */\n\
             }\n\
             /* USER CODE END GET_IDLE_TASK_MEMORY */\n\n",
        );
    }
    s.push_str(
        "/**\n\
         \x20 * @brief  FreeRTOS initialization\n\
         \x20 * @param  None\n\
         \x20 * @retval None\n\
         \x20 */\n\
         void MX_FREERTOS_Init(void) {\n\
         \x20 /* USER CODE BEGIN Init */\n\n\
         \x20 /* USER CODE END Init */\n\n\
         \x20 /* USER CODE BEGIN RTOS_MUTEX */\n\
         \x20 /* add mutexes, ... */\n\
         \x20 /* USER CODE END RTOS_MUTEX */\n\n\
         \x20 /* USER CODE BEGIN RTOS_SEMAPHORES */\n\
         \x20 /* add semaphores, ... */\n\
         \x20 /* USER CODE END RTOS_SEMAPHORES */\n\n\
         \x20 /* USER CODE BEGIN RTOS_TIMERS */\n\
         \x20 /* start timers, add new ones, ... */\n\
         \x20 /* USER CODE END RTOS_TIMERS */\n\n\
         \x20 /* USER CODE BEGIN RTOS_QUEUES */\n\
         \x20 /* add queues, ... */\n\
         \x20 /* USER CODE END RTOS_QUEUES */\n\n\
         \x20 /* Create the thread(s) */\n",
    );
    for t in &cfg.tasks {
        s.push_str(&format!("  /* definition and creation of {} */\n", t.name));
        if t.allocation == "Static" {
            s.push_str(&format!(
                "  osThreadStaticDef({}, {}, {}, 0, {}, {}, &{});\n",
                t.name,
                t.entry_function,
                os_priority(t.priority),
                t.stack_size,
                t.buffer,
                t.control_block
            ));
        } else {
            s.push_str(&format!(
                "  osThreadDef({}, {}, {}, 0, {});\n",
                t.name,
                t.entry_function,
                os_priority(t.priority),
                t.stack_size
            ));
        }
        s.push_str(&format!(
            "  {}Handle = osThreadCreate(osThread({}), {});\n",
            t.name,
            t.name,
            task_arg(t)
        ));
    }
    s.push_str(
        "\n  /* USER CODE BEGIN RTOS_THREADS */\n\
         \x20 /* add threads, ... */\n\
         \x20 /* USER CODE END RTOS_THREADS */\n\n\
         }\n\n",
    );
    // Task entry bodies, doc order, one per unique entry function; "As
    // external" entries get no body (mining Q2 codegen-mode literals).
    for &i in &owners {
        let t = &cfg.tasks[i];
        if t.code_generation == "As external" {
            continue;
        }
        let fun = &t.entry_function;
        s.push_str(&format!(
            "/* USER CODE BEGIN Header_{fun} */\n\
             /**\n\
             \x20 * @brief  Function implementing the {} thread.\n\
             \x20 * @param  argument: Not used\n\
             \x20 * @retval None\n\
             \x20 */\n\
             /* USER CODE END Header_{fun} */\n",
            t.name
        ));
        let weak = if t.code_generation == "As weak" { "__weak " } else { "" };
        s.push_str(&format!("{weak}void {fun}(void const * argument)\n{{\n"));
        if usb && i == 0 {
            // Handshake: first statement of the default (first) task,
            // OUTSIDE the USER CODE section (spec §2.2/§4.5).
            s.push_str("  /* init code for USB_DEVICE */\n  MX_USB_DEVICE_Init();\n");
        }
        s.push_str(&format!(
            "  /* USER CODE BEGIN {fun} */\n\
             \x20 /* Infinite loop */\n\
             \x20 for(;;)\n\
             \x20 {{\n\
             \x20   osDelay(1);\n\
             \x20 }}\n\
             \x20 /* USER CODE END {fun} */\n\
             }}\n\n",
        ));
    }
    s.push_str(
        "/* Private application code --------------------------------------------------*/\n\
         /* USER CODE BEGIN Application */\n\n\
         /* USER CODE END Application */\n",
    );
    s
}
