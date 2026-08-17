//! Middleware generation seam (plan §P4; consumed by P5 FreeRTOS and P6
//! USB Device CDC WITHOUT touching the core emitters).
//!
//! A middleware is a [`MiddlewareGen`] registered in [`registry`]. The core
//! generator consults the registry at fixed points; each hook lands in a
//! specific place of the generated project:
//!
//! | Hook                     | Consumed by                | Lands in |
//! |--------------------------|----------------------------|----------|
//! | `applies`                | everything below           | gates all other hooks (config-doc driven) |
//! | `files`                  | `lib.rs::generate_project` | extra generated files (`Core/Src/freertos.c`, `Core/Inc/FreeRTOSConfig.h`, ...), merged into the USER-CODE-preserving write path |
//! | `cmake().sources`        | `project.rs::cmakelists`   | `add_executable(...)` source list |
//! | `cmake().includes`       | `project.rs::cmakelists`   | `target_include_directories(...)` |
//! | `cmake().defines`        | `project.rs::cmakelists`   | `target_compile_definitions(...)` |
//! | `hal_conf_defines`       | `emit.rs::hal_conf_h`      | verbatim `#define` lines after the module-enable block (`HAL_PCD_MODULE_ENABLED`, `USE_HAL_PCD_REGISTER_CALLBACKS 0U`, ...) |
//! | `main_hooks().includes`  | `emit.rs::main_c`          | `#include` lines right after `"main.h"` (before the per-IP headers; FreeRTOS's `cmsis_os.h` slot) |
//! | `main_hooks().pre_init_calls`  | `emit.rs::main_c`    | statements before `MX_GPIO_Init()` |
//! | `main_hooks().post_init_calls` | `emit.rs::main_c`    | statements after `USER CODE 2` (the `MX_FREERTOS_Init(); osKernelStart();` slot); each entry is a full line |
//! | `main_hooks().callbacks_code`  | `emit.rs::main_c`    | code blocks after `USER CODE 4`, before `Error_Handler` |
//! | `it_hooks`               | `emit.rs::it_c` / `it_h`   | extra IRQ handlers (`OTG_FS_IRQHandler`) + their `extern` handle lines |
//! | `suppressed_it_handlers` | `emit.rs::it_c` / `it_h`   | Cortex system handlers to OMIT (FreeRTOS port owns `SVC_Handler`/`PendSV_Handler`, and `SysTick_Handler` under a TIM timebase — spec §2.4) |
//! | `diagnostics`            | `lib.rs::generate_project` | warning/info entries appended to the manifest diags (engine-side couplings a generator can detect but not enforce) |
//! | `copy_sources`           | `lib.rs::generate_project` | firmware library payload copy (`Middlewares/...`), returns copied rel paths for the manifest |
//!
//! The registry is EMPTY today; P5/P6 add `Box<FreertosGen>` /
//! `Box<UsbCdcGen>` here and implement the trait in their own modules.

pub mod freertos;
pub mod usb_device;

use crate::{GenCtx, GeneratedFile};
use std::collections::BTreeSet;
use std::path::Path;
use stm32ck_engine::diag::Diagnostic;

/// CMake build-description additions contributed by one middleware.
#[derive(Debug, Default, Clone)]
pub struct CmakeAdditions {
    /// Extra source files, project-relative (`Core/Src/freertos.c`,
    /// `Middlewares/Third_Party/FreeRTOS/Source/tasks.c`, ...).
    pub sources: Vec<String>,
    /// Extra include directories, project-relative.
    pub includes: Vec<String>,
    /// Extra compile definitions (rarely needed; the CMake flow adds none
    /// for FreeRTOS/USB — see middleware-gen-spec §4.5).
    pub defines: Vec<String>,
}

/// main.c integration points contributed by one middleware.
#[derive(Debug, Default, Clone)]
pub struct MainHooks {
    /// `#include "..."` header names (without quotes) emitted right after
    /// `#include "main.h"`.
    pub includes: Vec<String>,
    /// Prototype lines for main.c's "Private function prototypes" block
    /// (`void MX_FREERTOS_Init(void);`).
    pub prototypes: Vec<String>,
    /// Full statement lines emitted before `MX_GPIO_Init();`.
    pub pre_init_calls: Vec<String>,
    /// Full statement/comment lines emitted after `USER CODE 2`.
    pub post_init_calls: Vec<String>,
    /// Whole code blocks (functions) emitted after `USER CODE 4`, before
    /// `Error_Handler`.
    pub callbacks_code: Vec<String>,
}

/// One extra it.c IRQ handler contributed by a middleware.
#[derive(Debug, Default, Clone)]
pub struct ItHandler {
    /// "OTG_FS_IRQn" — anchors USER CODE tags and the prototype name.
    pub irqn: String,
    /// Doc-comment brief ("USB On The Go FS global interrupt.").
    pub brief: String,
    /// Handler body lines between the USER CODE anchors
    /// (`HAL_PCD_IRQHandler(&hpcd_USB_OTG_FS);`).
    pub body: Vec<String>,
    /// `extern` declarations required by the body
    /// (`PCD_HandleTypeDef hpcd_USB_OTG_FS`), without `extern`/`;`.
    pub externs: Vec<String>,
}

/// The P5/P6 contract. Every method except [`Self::applies`] has a no-op
/// default so a middleware only implements the surfaces it touches.
pub trait MiddlewareGen {
    /// Stable identifier ("freertos", "usb_device_cdc").
    fn name(&self) -> &'static str;
    /// Whether this middleware is active for the given document.
    fn applies(&self, ctx: &GenCtx<'_>) -> bool;
    /// Extra generated files (paths relative to the project root).
    fn files(&self, _ctx: &GenCtx<'_>) -> anyhow::Result<Vec<GeneratedFile>> {
        Ok(Vec::new())
    }
    /// CMake additions (see the module table for where each lands).
    fn cmake(&self, _ctx: &GenCtx<'_>) -> CmakeAdditions {
        CmakeAdditions::default()
    }
    /// Verbatim `#define`-style lines for `<fam>_hal_conf.h`.
    fn hal_conf_defines(&self, _ctx: &GenCtx<'_>) -> Vec<String> {
        Vec::new()
    }
    /// main.c integration.
    fn main_hooks(&self, _ctx: &GenCtx<'_>) -> MainHooks {
        MainHooks::default()
    }
    /// Extra it.c handlers.
    fn it_hooks(&self, _ctx: &GenCtx<'_>) -> Vec<ItHandler> {
        Vec::new()
    }
    /// Cortex system handler names (as spelled in `emit::CORTEX_HANDLERS`,
    /// e.g. `"SVC_Handler"`) that must NOT be emitted in it.c/it.h because
    /// this middleware owns the vector (FreeRTOS port aliases — spec §2.4).
    fn suppressed_it_handlers(&self, _ctx: &GenCtx<'_>) -> Vec<String> {
        Vec::new()
    }
    /// Warning/info diagnostics for couplings the generator can detect but
    /// not enforce (missing TIM timebase, non-GROUP_4 NVIC grouping, ...).
    /// Appended to `Manifest::diags` by `lib.rs::generate_project`.
    fn diagnostics(&self, _ctx: &GenCtx<'_>) -> Vec<Diagnostic> {
        Vec::new()
    }
    /// Peripheral instances whose init code this middleware OWNS (P7 fix:
    /// USB CDC returns `["USB_OTG_FS"]` — `HAL_PCD_Init` runs inside
    /// `USBD_LL_Init` and `HAL_PCD_MspInit` lives in usbd_conf.c, exactly
    /// like CubeMX). The core emitter then skips, for each owned instance:
    /// its per-IP family file pair (`pcd.c`/`pcd.h`), the main.c include and
    /// `MX_*_Init` call, and the CMake source entry. The instance stays in
    /// the RESOLVED model — its pins/NVIC/clock data feed the middleware's
    /// own files (usbd_conf.c) and the hal_conf/HAL-source/module wiring.
    fn owned_instances(&self, _ctx: &GenCtx<'_>) -> Vec<String> {
        Vec::new()
    }
    /// Copy middleware library sources from the firmware checkout `fw` into
    /// the project `out`; returns the `/`-separated rel paths copied.
    fn copy_sources(
        &self,
        _ctx: &GenCtx<'_>,
        _fw: &Path,
        _out: &Path,
    ) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }
}

/// All known middleware generators, deterministic order. EMPTY until P5/P6.
pub fn registry() -> Vec<Box<dyn MiddlewareGen>> {
    vec![
        Box::new(freertos::FreertosGen),
        Box::new(usb_device::UsbCdcGen),
    ]
}

/// The registry filtered to middlewares active for this document.
pub fn active(ctx: &GenCtx<'_>) -> Vec<Box<dyn MiddlewareGen>> {
    registry().into_iter().filter(|m| m.applies(ctx)).collect()
}

/// Aggregated main.c hooks across active middlewares (registry order).
pub fn main_hooks(ctx: &GenCtx<'_>) -> MainHooks {
    let mut out = MainHooks::default();
    for m in active(ctx) {
        let h = m.main_hooks(ctx);
        out.includes.extend(h.includes);
        out.prototypes.extend(h.prototypes);
        out.pre_init_calls.extend(h.pre_init_calls);
        out.post_init_calls.extend(h.post_init_calls);
        out.callbacks_code.extend(h.callbacks_code);
    }
    out
}

/// Aggregated hal_conf define lines across active middlewares.
pub fn hal_conf_defines(ctx: &GenCtx<'_>) -> Vec<String> {
    active(ctx).iter().flat_map(|m| m.hal_conf_defines(ctx)).collect()
}

/// Aggregated it.c handlers across active middlewares.
pub fn it_hooks(ctx: &GenCtx<'_>) -> Vec<ItHandler> {
    active(ctx).iter().flat_map(|m| m.it_hooks(ctx)).collect()
}

/// Aggregated set of Cortex system handlers to omit from it.c/it.h.
pub fn suppressed_it_handlers(ctx: &GenCtx<'_>) -> BTreeSet<String> {
    active(ctx)
        .iter()
        .flat_map(|m| m.suppressed_it_handlers(ctx))
        .collect()
}

/// Aggregated set of middleware-owned peripheral instances (the core
/// emitter and the CMake source list skip their per-IP surfaces).
pub fn owned_instances(ctx: &GenCtx<'_>) -> BTreeSet<String> {
    active(ctx)
        .iter()
        .flat_map(|m| m.owned_instances(ctx))
        .collect()
}

/// Aggregated middleware diagnostics (registry order).
pub fn diagnostics(ctx: &GenCtx<'_>) -> Vec<Diagnostic> {
    active(ctx).iter().flat_map(|m| m.diagnostics(ctx)).collect()
}

/// Aggregated CMake additions across active middlewares.
pub fn cmake_additions(ctx: &GenCtx<'_>) -> CmakeAdditions {
    let mut out = CmakeAdditions::default();
    for m in active(ctx) {
        let c = m.cmake(ctx);
        out.sources.extend(c.sources);
        out.includes.extend(c.includes);
        out.defines.extend(c.defines);
    }
    out
}
