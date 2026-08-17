//! C source emission: the [`Resolved`] model rendered into the CubeMX-shaped
//! `Core/Inc` + `Core/Src` file set (design §9).
//!
//! Everything printed here comes from the resolved model, the IR pack or the
//! config document — no HAL enum value is invented. Structural C (function
//! shapes, USER CODE anchors, `RCC_OSCILLATORTYPE_*` / `RCC_PERIPHCLK_*`
//! composition macros) replicates the CubeMX template furniture verbatim.
//!
//! Determinism: peripherals arrive in `BTreeMap` (document) order, every
//! grouping below uses `BTreeMap`/sorted `Vec`, and all values are strings
//! already fixed by the engine.

use crate::{GenCtx, GeneratedFile};
use std::collections::{BTreeMap, BTreeSet};
use stm32ck_engine::dma::ResolvedDma;
use stm32ck_engine::env::Env;
use stm32ck_engine::eval::{eval_condition, EvalTrace};
use stm32ck_engine::modes::{bind_condition, bind_ident};
use stm32ck_engine::params::resolve_param_bound;
use stm32ck_engine::session::ResolvedPeriph;
use stm32ck_ir::model::{GpioIp, MethodArgument};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn emit_all(ctx: &GenCtx<'_>) -> anyhow::Result<Vec<GeneratedFile>> {
    let fam = fam_lower(ctx); // "stm32f1xx"
    let periphs: Vec<PeriphGen<'_>> = ctx
        .resolved
        .periphs
        .iter()
        .map(|p| PeriphGen::build(ctx, p))
        .collect();
    // Per-peripheral file split (middleware-gen-spec §1, default ON):
    // instances grouped into CubeMX family files (tim.c holds ALL TIMs,
    // usart.c holds UART4 + USARTs, ...). Middleware-owned instances (P7:
    // USB_OTG_FS under the USB Device stack) get NO family file — their
    // init/MSP lives in the middleware's own files (usbd_conf.c).
    let owned = crate::middleware::owned_instances(ctx);
    let groups = file_groups(&periphs, &owned);

    let mut out = vec![
        gf("Core/Inc/main.h", main_h(ctx, &periphs)),
        gf("Core/Src/main.c", main_c(ctx, &periphs, &groups)),
        gf("Core/Inc/gpio.h", gpio_h(ctx)),
        gf("Core/Src/gpio.c", gpio_c(ctx)),
    ];
    if !ctx.resolved.dma.is_empty() {
        out.push(gf("Core/Inc/dma.h", dma_h(ctx)));
        out.push(gf("Core/Src/dma.c", dma_c(ctx)));
    }
    for (stem, idxs) in &groups {
        let members: Vec<&PeriphGen<'_>> = idxs.iter().map(|&i| &periphs[i]).collect();
        out.push(gf(
            &format!("Core/Inc/{stem}.h"),
            periph_h(ctx, stem, &members),
        ));
        out.push(gf(
            &format!("Core/Src/{stem}.c"),
            periph_c(ctx, stem, &members),
        ));
    }
    out.push(gf(&format!("Core/Src/{fam}_hal_msp.c"), msp_c(ctx)));
    out.push(gf(&format!("Core/Inc/{fam}_it.h"), it_h(ctx, &periphs)));
    out.push(gf(&format!("Core/Src/{fam}_it.c"), it_c(ctx, &periphs)));
    out.push(gf(
        &format!("Core/Inc/{fam}_hal_conf.h"),
        hal_conf_h(ctx, &periphs),
    ));
    if ctx.resolved.timebase.is_some() {
        out.push(gf(
            &format!("Core/Src/{fam}_hal_timebase_tim.c"),
            timebase_c(ctx),
        ));
    }
    // Static CubeMX templates (middleware-gen-spec §5), verbatim.
    out.push(gf(
        "Core/Src/syscalls.c",
        include_str!("templates/syscalls.c").to_string(),
    ));
    out.push(gf(
        "Core/Src/sysmem.c",
        include_str!("templates/sysmem.c").to_string(),
    ));
    Ok(out)
}

/// Group peripherals into CubeMX family files: stem -> indices into the
/// `periphs` slice, numeric-aware instance order within each file
/// (TIM2 before TIM13 — the reference tim.c body order). Instances in
/// `owned` (middleware-owned, P7) are excluded from the split entirely.
fn file_groups(
    periphs: &[PeriphGen<'_>],
    owned: &BTreeSet<String>,
) -> Vec<(String, Vec<usize>)> {
    let mut map: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, pg) in periphs.iter().enumerate() {
        if owned.contains(&pg.p.instance) {
            continue;
        }
        map.entry(crate::file_stem(pg.p)).or_default().push(i);
    }
    let mut out: Vec<(String, Vec<usize>)> = map.into_iter().collect();
    for (_, members) in &mut out {
        members.sort_by_key(|&i| {
            let inst = &periphs[i].p.instance;
            (
                inst.trim_end_matches(|c: char| c.is_ascii_digit()).to_string(),
                stm32ck_engine::modes::instance_index(inst),
            )
        });
    }
    out
}

fn gf(rel: &str, content: String) -> GeneratedFile {
    GeneratedFile {
        rel_path: rel.to_string(),
        content,
    }
}

// ---------------------------------------------------------------------------
// Small text-building helpers
// ---------------------------------------------------------------------------

struct Buf(String);

impl Buf {
    fn new() -> Self {
        Buf(String::new())
    }
    fn line(&mut self, s: impl AsRef<str>) {
        self.0.push_str(s.as_ref());
        self.0.push('\n');
    }
    fn blank(&mut self) {
        self.0.push('\n');
    }
    /// A `USER CODE BEGIN tag` .. `END tag` pair with one blank line inside.
    fn user(&mut self, tag: &str) {
        self.line(format!("  /* USER CODE BEGIN {tag} */"));
        self.blank();
        self.line(format!("  /* USER CODE END {tag} */"));
    }
    /// Same, at column 0 (file-scope anchors).
    fn user0(&mut self, tag: &str) {
        self.line(format!("/* USER CODE BEGIN {tag} */"));
        self.blank();
        self.line(format!("/* USER CODE END {tag} */"));
    }
    fn into_string(self) -> String {
        self.0
    }
}

fn fam_lower(ctx: &GenCtx<'_>) -> String {
    ctx.device_prefix()
}

fn is_f1(ctx: &GenCtx<'_>) -> bool {
    ctx.family() == "STM32F1"
}

fn header(ctx: &GenCtx<'_>, file: &str, brief: &str) -> String {
    format!(
        "/* USER CODE BEGIN Header */\n\
         /**\n\
        \x20 ******************************************************************************\n\
        \x20 * @file           : {file}\n\
        \x20 * @brief          : {brief}\n\
        \x20 ******************************************************************************\n\
        \x20 * @attention\n\
        \x20 *\n\
        \x20 * Generated by stm32kernel {} -- IR pack {} (CubeMX db {}).\n\
        \x20 * Regenerated files keep user code only inside USER CODE sections.\n\
        \x20 *\n\
        \x20 ******************************************************************************\n\
        \x20 */\n\
         /* USER CODE END Header */\n",
        ctx.kernel_version, ctx.pack.family, ctx.pack.db_version
    )
}

/// Instance index digits: TRAILING run only ("I2C1" -> "1", not "21").
fn digits(instance: &str) -> String {
    stm32ck_engine::modes::instance_index(instance).to_string()
}

// ---------------------------------------------------------------------------
// Pin / GPIO lookups
// ---------------------------------------------------------------------------

/// "PC13-TAMPER-RTC" -> "PC13".
fn base_pad(name: &str) -> &str {
    name.split(['-', '/']).next().unwrap_or(name)
}

#[derive(Debug, Clone)]
struct PinRef {
    /// "PC13"
    base: String,
    /// 'C'
    port_letter: char,
    /// 13
    bit: u32,
    /// "GPIO_PIN_13"
    pin_macro: String,
    /// "GPIOC"
    port_macro: String,
}

fn pin_ref(ctx: &GenCtx<'_>, pad: &str) -> PinRef {
    let gpio = ctx.pack.gpio.get(&ctx.resolved.gpio_version);
    let base = base_pad(pad).to_string();
    let bytes = base.as_bytes();
    let (port_letter, bit) = if bytes.len() >= 3 && bytes[0] == b'P' {
        (bytes[1] as char, base[2..].parse::<u32>().unwrap_or(0))
    } else {
        ('A', 0)
    };
    let pin_macro = gpio
        .and_then(|g| {
            g.pins
                .get(pad)
                .or_else(|| g.pins.get(base.as_str()))
                .or_else(|| {
                    g.pins
                        .iter()
                        .find(|(k, _)| base_pad(k) == base)
                        .map(|(_, v)| v)
                })
        })
        // A hit with an EMPTY macro is not a hit: 192 of the db's 9263 pads
        // (oscillator pads, JTAG-multiplexed pins) carry the entry but no
        // `GPIO_Pin` SpecificParameter. Falling back only on a *missing*
        // entry emitted `#define PC14_Pin` with no value at all.
        .map(|p| p.pin_macro.trim())
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("GPIO_PIN_{bit}"));
    PinRef {
        base,
        port_letter,
        bit,
        pin_macro,
        port_macro: format!("GPIO{port_letter}"),
    }
}

/// Port clock-enable macro from the GPIO IP data (fallback constructed).
fn port_clock_enable(ctx: &GenCtx<'_>, port_letter: char) -> String {
    ctx.pack
        .gpio
        .get(&ctx.resolved.gpio_version)
        .and_then(|g| g.ports.get(&format!("P{port_letter}")))
        .and_then(|p| p.clock_enable.first().cloned())
        .unwrap_or_else(|| format!("__HAL_RCC_GPIO{port_letter}_CLK_ENABLE"))
}

/// Electrical settings for one GPIO_InitTypeDef fill.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord)]
struct IoSettings {
    mode: Option<String>,
    pull: Option<String>,
    speed: Option<String>,
    alternate: Option<String>,
}

/// Derive electrical settings from a GPIO RefMode preset name: pinned
/// parameter values win, then the GPIO RefParameter defaults (alternate
/// default parameters like `GPIO_ModeDefaultPP` carry their own defaults).
///
/// Speed (audit §二-4): a preset that pins GPIO_Speed (AF-PP-HighSpeed) or
/// pulls a `GPIO_Speed*Default*` RefParameter keeps that value; an
/// alternate-function preset that merely pulls the plain `GPIO_Speed` takes
/// the db's `GPIO_Speed_High_Default` default instead of the global LOW —
/// CubeMX gives AF pins the high-speed default (F1 SPI SCK: FREQ_HIGH).
fn io_settings(gpio: &GpioIp, preset: &str, af_high_speed: bool) -> IoSettings {
    let mut s = IoSettings::default();
    let mut speed_from_plain_default = false;
    let mut cursor = Some(preset.to_string());
    let mut guard = 0;
    while let Some(name) = cursor.take() {
        guard += 1;
        if guard > 8 {
            break;
        }
        let Some(rm) = gpio.ref_modes.iter().find(|m| m.name == name) else {
            break;
        };
        for mp in &rm.parameters {
            let pinned = mp.pinned_values.first().cloned();
            let value = pinned.clone().or_else(|| {
                gpio.ref_parameters
                    .iter()
                    .find(|rp| rp.name == mp.name)
                    .map(|rp| rp.default_value.clone())
            });
            let Some(v) = value else { continue };
            if v.is_empty() || v == "null" {
                continue;
            }
            let slot = if mp.name.starts_with("GPIO_Mode") {
                &mut s.mode
            } else if mp.name.starts_with("GPIO_PuPd") || mp.name == "GPIO_Pu" {
                &mut s.pull
            } else if mp.name.starts_with("GPIO_Speed") {
                &mut s.speed
            } else {
                continue; // GPIOx / GPIO_Pin / PinState / GPIO_AF handled elsewhere
            };
            if slot.is_none() {
                if mp.name.starts_with("GPIO_Speed") {
                    speed_from_plain_default = pinned.is_none() && mp.name == "GPIO_Speed";
                }
                *slot = Some(v);
            }
        }
        cursor = rm.base_mode.clone();
    }
    if speed_from_plain_default && af_high_speed && preset.starts_with("AlternateFunction") {
        if let Some(rp) = gpio
            .ref_parameters
            .iter()
            .find(|rp| rp.name == "GPIO_Speed_High_Default")
        {
            let d = rp.default_value.trim();
            if !d.is_empty() && d != "null" {
                s.speed = Some(d.to_string());
            }
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Peripheral generation model
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct HandleGen {
    /// "huart1"
    name: String,
    /// "UART_HandleTypeDef"
    c_type: String,
}

#[derive(Debug)]
struct CallGen {
    /// `huart1.Init.BaudRate = 115200;` lines, in LibMethod argument order.
    /// Field assignments already equal to the last emitted value for the
    /// same variable are elided (CubeMX `OptimizationCondition="equal"` —
    /// shared `sConfigOC` locals only re-assign changed fields).
    assigns: Vec<String>,
    /// `HAL_UART_Init(&huart1)`
    expr: String,
    /// Compare value for the `!= X -> Error_Handler()` guard.
    guard: Option<String>,
}

#[derive(Debug)]
struct PlacedPin {
    pin: PinRef,
    /// "USART1_TX"
    signal: String,
    settings: IoSettings,
    /// Sanitized label of the pad's user gpio entry when the pad is a
    /// stacked/shared pad (mine-core Q5): the MSP fill then uses the
    /// `<label>_Pin` / `<label>_GPIO_Port` macros — one identity per pad.
    label: Option<String>,
}

impl PlacedPin {
    /// `GPIO_1_Pin` on a labeled stacked pad, else `GPIO_PIN_0`.
    fn pin_token(&self) -> String {
        match &self.label {
            Some(l) => format!("{l}_Pin"),
            None => self.pin.pin_macro.clone(),
        }
    }
}

struct PeriphGen<'a> {
    p: &'a ResolvedPeriph<'a>,
    /// "MX_USART1_UART_Init"
    mx_name: String,
    handle: Option<HandleGen>,
    calls: Vec<CallGen>,
    /// Local config structs declared at the top of the MX init function
    /// (`TIM_OC_InitTypeDef sConfigOC = {0};`), in first-use order.
    locals: Vec<(String, String)>,
    /// "HAL_UART_MspInit" / "HAL_UART_MspDeInit" from the RefConfig
    /// callbacks (constructed from hal_mode when the data has none).
    msp_init: Option<String>,
    msp_deinit: Option<String>,
    /// "HAL_TIM_MspPostInit" when an active RefConfig implements it —
    /// output AF pins then move to the PostInit callback called at the end
    /// of the MX init function (CubeMX TIM convention).
    msp_post_init: Option<String>,
    /// Pins placed for this instance, sorted by signal name (MspInit set).
    pins: Vec<PlacedPin>,
    /// Pins deferred to HAL_TIM_MspPostInit (output-direction TIM pins).
    post_pins: Vec<PlacedPin>,
    /// Peripheral clock-enable macros (fallback `__HAL_RCC_<I>_CLK_ENABLE`).
    clock_enable: Vec<String>,
    /// Register-block name for `Instance` fields and the MSP dispatch
    /// guards — see [`base_address`]; equals the instance name except where
    /// the db overrides it (I2S drives the SPI block).
    base_address: String,
    /// F1 non-default remap macros to call in MspInit.
    remap_macros: Vec<String>,
}

/// CubeMX's canonical TIM block order inside one MX init function:
/// init blocks, MasterConfig, per-channel ConfigChannel (ascending),
/// BreakDeadTime, preload macros. Non-TIM block names all land in class 0
/// and keep their engine (chain) order.
fn block_class(name: &str) -> u8 {
    if name == "TIM_MasterConfigSynchronization" {
        1
    } else if name.contains("ConfigChannel") {
        2
    } else if name == "TIM_ConfigBreakDeadTime" {
        3
    } else if name.starts_with("setOC") {
        4
    } else {
        0
    }
}

/// Channel number of a ConfigChannel block: the owning RefMode's pinned
/// `Channel` value (`TIM_CHANNEL_3` -> 3), else trailing digits of the
/// block name (`IC_ConfigChannel_CH3` -> 3).
fn block_channel(p: &ResolvedPeriph<'_>, block: &stm32ck_engine::session::ConfigBlock) -> u32 {
    p.mode_params
        .get(&block.scope)
        .and_then(|m| m.get("Channel"))
        .and_then(|v| v.rsplit('_').next())
        .and_then(|d| d.parse().ok())
        .or_else(|| {
            let d: String = block
                .name
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            d.chars().rev().collect::<String>().parse().ok()
        })
        .unwrap_or(0)
}

impl<'a> PeriphGen<'a> {
    fn build(ctx: &GenCtx<'a>, p: &'a ResolvedPeriph<'a>) -> PeriphGen<'a> {
        let mut trace = EvalTrace::default();
        let env = scratch_env(ctx, p);
        let cfg = ctx.config_for(p);

        // MX_<inst>_<HALMODE>_Init when the hal mode is not already the
        // instance's own prefix (MX_USART1_UART_Init vs MX_SPI1_Init).
        let mx_name = match &p.hal_mode {
            Some(hm) => {
                let head = hm.split('_').next().unwrap_or(hm).to_ascii_uppercase();
                if p.instance.to_ascii_uppercase().starts_with(&head) {
                    format!("MX_{}_Init", p.instance)
                } else {
                    format!("MX_{}_{}_Init", p.instance, hm)
                }
            }
            None => format!("MX_{}_Init", p.instance),
        };

        let mut handle: Option<HandleGen> = None;
        let mut calls: Vec<CallGen> = Vec::new();
        let mut locals: Vec<(String, String)> = Vec::new();
        let mut msp_init = None;
        let mut msp_deinit = None;
        let mut msp_post_init = None;
        // Equal-value elision across the whole MX init function:
        // `path.field` -> last emitted value.
        let mut emitted: BTreeMap<String, String> = BTreeMap::new();

        // Blocks in CubeMX's canonical order (see block_class): stable sort
        // keeps the engine's chain order within each class.
        let mut blocks: Vec<&stm32ck_engine::session::ConfigBlock> =
            p.config_blocks.iter().collect();
        blocks.sort_by_key(|b| {
            let class = block_class(&b.name);
            let chan = if class == 2 { block_channel(p, b) } else { 0 };
            (class, chan)
        });

        let mut env = env;
        if let Some(cfg) = cfg {
            if std::env::var_os("STM32CK_DEBUG_BLOCKS").is_some() {
                eprintln!(
                    "DBG {} modes={:?} blocks={:?}",
                    p.instance,
                    p.active_modes,
                    blocks
                        .iter()
                        .map(|b| format!("{}@{}", b.name, b.scope))
                        .collect::<Vec<_>>()
                );
            }
            for blk in &blocks {
                let Some(rc) = cfg.ref_configs.get(&blk.name) else {
                    continue;
                };
                // Field lookups for this block resolve in the owning
                // chain's scope first (TIM per-channel Pulse/OCMode; ADC
                // per-rank `{i}#ChannelRegularConversion` clones).
                env.mode_scope = Some(blk.scope.clone());
                for cb in &rc.callbacks {
                    if cb.ends_with("MspPostInit") {
                        if msp_post_init.is_none() {
                            msp_post_init = Some(cb.clone());
                        }
                    } else if cb.ends_with("MspInit") && msp_init.is_none() {
                        msp_init = Some(cb.clone());
                    } else if cb.ends_with("MspDeInit") && msp_deinit.is_none() {
                        msp_deinit = Some(cb.clone());
                    }
                }
                for call in &rc.calls {
                    if let Some(cond) = &call.condition {
                        let bound = bind_condition(cond, &p.instance);
                        let cenv = env_with_condition_params(p, &env, &bound);
                        if !eval_condition(&bound, &cenv, &mut trace) {
                            continue;
                        }
                    }
                    let Some(lm) = cfg.lib_methods.get(&call.method) else {
                        continue;
                    };
                    let root = lm.arguments.iter().find(|a| {
                        a.generic_type == "struct" && a.context.contains("global")
                    });
                    let Some(root) = root else { continue };
                    let h = HandleGen {
                        name: format!("{}{}", root.name, digits(&p.instance)),
                        c_type: root
                            .type_name
                            .clone()
                            .unwrap_or_else(|| "void".to_string()),
                    };

                    // Elision state is speculative until the call is
                    // committed: a call dropped below (`!complete`, or no
                    // applicable config field) must not leave its paths in
                    // `emitted`, or it suppresses the identical assignments
                    // of the call that IS kept. H5 orders 18 inapplicable
                    // TIM_ConfigBreakInput calls — each carrying the whole
                    // htim root — ahead of PWM_Init, which then lost
                    // `htim3.Instance` and every `htim3.Init.*`.
                    let mut pending = emitted.clone();
                    let mut pending_locals: Vec<(String, String)> = Vec::new();

                    // Handle-struct assignments, document order. Simple
                    // fields directly on the handle (Channel/Lock/State/
                    // hdma) are runtime plumbing CubeMX never assigns —
                    // only baseaddress + nested structs are emitted.
                    let mut assigns: Vec<String> = Vec::new();
                    // CubeMX programs the handle's nested Init structs only in
                    // the call that initializes it — its template gates the
                    // recursion on the method name containing "Init"
                    // (common.ftl: `method.name?contains("Init")` beside the
                    // `fargument.context=="global"` test). Every RefConfig
                    // call takes the same handle and the db repeats the whole
                    // argument tree on each, but only the `*_Init` call
                    // carries the MethodArg bindings for those fields:
                    // re-walking the tree for `HAL_UARTEx_SetTxFifoThreshold`
                    // resolved the plain parameter instead and rewrote
                    // `huart1.Init.WordLength` with the un-prefixed
                    // `WORDLENGTH_8B` spelling.
                    let programs_handle = call.method.contains("Init");
                    for a in &root.children {
                        match a.generic_type.as_str() {
                            "baseaddress" => push_handle_assign(
                                &mut assigns,
                                &mut pending,
                                &format!("{}.{}", h.name, a.name),
                                &base_address(p, &env, &mut trace),
                            ),
                            "struct" if programs_handle => walk_struct(
                                ctx, p, &env, &mut trace, &call.arg_bindings, &a.children,
                                &format!("{}.{}", h.name, a.name), &mut assigns, &mut pending,
                            ),
                            _ => {}
                        }
                    }

                    // Call expression: &root plus the other top-level args.
                    // Non-global struct args become shared function locals
                    // (`sConfigOC`), declared once per distinct name.
                    let mut c_args: Vec<String> = Vec::new();
                    let mut complete = true;
                    let mut local_structs = 0usize;
                    let mut resolvable_local_fields = 0usize;
                    for a in &lm.arguments {
                        if std::ptr::eq(a, root) {
                            c_args.push(format!("&{}", h.name));
                            continue;
                        }
                        if a.generic_type == "struct" {
                            local_structs += 1;
                            let lname = call
                                .arg_bindings
                                .get(&a.name)
                                .cloned()
                                .unwrap_or_else(|| a.name.clone());
                            let ltype = a
                                .type_name
                                .clone()
                                .unwrap_or_else(|| "void".to_string());
                            // Count resolvable fields BEFORE elision — an
                            // all-`null` struct (TIM5 BreakDeadTime) drops
                            // the whole call, but an unchanged-since-last-
                            // call struct (sConfigOC on CH2/CH3) does not.
                            let mut fields: Vec<(String, String)> = Vec::new();
                            collect_struct_fields(
                                ctx, p, &env, &mut trace, &call.arg_bindings, &a.children,
                                &lname, &mut fields,
                            );
                            // ADC rank spelling is a template-side family
                            // branch in CubeMX (common.ftl Bz40086): every
                            // family EXCEPT F0/L0/F2/F4 wraps the integer in
                            // ADC_REGULAR_RANK_n / ADC_INJECTED_RANK_n; a
                            // value already starting with "ADC" stays as-is.
                            if matches!(
                                blk.name.as_str(),
                                "ADC_RegularChannelConfig" | "ADC_InjectedChannelConfig"
                            ) && !matches!(
                                ctx.family(),
                                "STM32F0" | "STM32L0" | "STM32F2" | "STM32F4"
                            ) {
                                for (path, v) in fields.iter_mut() {
                                    let macro_stem = if path.ends_with(".Rank") {
                                        "ADC_REGULAR_RANK_"
                                    } else if path.ends_with(".InjectedRank") {
                                        "ADC_INJECTED_RANK_"
                                    } else {
                                        continue;
                                    };
                                    if !v.is_empty()
                                        && v.chars().all(|c| c.is_ascii_digit())
                                    {
                                        *v = format!("{macro_stem}{v}");
                                    }
                                }
                            }
                            resolvable_local_fields += fields.len();
                            if !fields.is_empty() {
                                if !locals.iter().any(|(n, _)| *n == lname)
                                    && !pending_locals.iter().any(|(n, _)| *n == lname)
                                {
                                    pending_locals.push((lname.clone(), ltype));
                                }
                                for (path, v) in fields {
                                    push_assign(&mut assigns, &mut pending, &path, &v);
                                }
                            }
                            c_args.push(format!("&{lname}"));
                            continue;
                        }
                        match resolve_field(ctx, p, &env, &mut trace, &call.arg_bindings, &a.name)
                        {
                            FieldVal::Lit(v) => c_args.push(v),
                            // Explicit-zero only applies to struct fields;
                            // a valueless top-level argument leaves the call
                            // unemittable.
                            FieldVal::ZeroDefault | FieldVal::Missing => {
                                complete = false;
                                break;
                            }
                        }
                    }
                    if !complete {
                        continue;
                    }
                    // A call whose config structs carry no applicable field
                    // at all does not apply to this instance (plain timers
                    // have no BreakDeadTime/MasterConfig parameters).
                    if local_structs > 0 && resolvable_local_fields == 0 {
                        continue;
                    }
                    // `ReturnHAL="false"` is the db's only way to ask for a
                    // bare call; anything else — including no attribute at
                    // all — is guarded. That is CubeMX's own rule, and it is
                    // why the reference guards `HAL_UARTEx_SetTxFifoThreshold`
                    // and `HAL_ADC_ConfigChannel`, neither of which carries
                    // the attribute. Macros (`__HAL_*`) return nothing and are
                    // never guarded.
                    let guard = match lm.return_hal.as_deref() {
                        Some("false") => None,
                        _ if !call.method.starts_with("HAL_") => None,
                        Some("true") | None => Some("HAL_OK".to_string()),
                        Some(other) => Some(other.to_string()),
                    };
                    // Committed: the speculative elision state and the
                    // struct locals this call needs become visible.
                    emitted = pending;
                    locals.extend(pending_locals);
                    calls.push(CallGen {
                        assigns,
                        expr: format!("{}({})", call.method, c_args.join(", ")),
                        guard,
                    });
                    if handle.is_none() {
                        handle = Some(h);
                    }
                }
            }
            env.mode_scope = None;
        }

        // No fallback here on purpose. `<ImplementCallBack>` in the IP's
        // Configs is authoritative and complete: the 13 F4 IPs that declare
        // none (DMA, GPIO, RCC, SYS, IWDG, the middlewares) are exactly the
        // ones CubeMX emits no `HAL_*_MspInit` for — DMA and GPIO do their
        // clock enables inside `MX_*_Init`, RCC/SYS inside `HAL_MspInit`,
        // IWDG has no clock gate at all (`ClockEnableMode="none"`).
        // Synthesising a callback from the hal mode conjured an MSP for
        // IWDG, and with it `__HAL_RCC_IWDG_CLK_ENABLE()` — a macro no HAL
        // header defines, so the project stopped compiling.

        // Placements owned by this instance, with electrical presets.
        let prefix = format!("{}_", p.instance);
        let gpio = ctx.pack.gpio.get(&ctx.resolved.gpio_version);
        let f1 = is_f1(ctx);
        // CubeMX quirk: communication IPs push their AF pins to the
        // high-speed default, timers keep the plain LOW default (ODrive
        // reference: UART/SPI/CAN VERY_HIGH, TIM1/2/8 LOW).
        let af_high_speed = !p.ip.name.to_ascii_uppercase().starts_with("TIM");
        let mut pins: Vec<PlacedPin> = Vec::new();
        let mut post_pins: Vec<PlacedPin> = Vec::new();
        let mut remap_macros: Vec<String> = Vec::new();
        for pl in &ctx.resolved.pin_plan.placements {
            if !pl.signal.starts_with(&prefix) {
                continue;
            }
            let short = &pl.signal[prefix.len()..];
            let sig = p.signals.iter().find(|s| s.short == *short);
            let preset = sig.and_then(|s| s.io_mode.clone());
            let mut settings = match (gpio, &preset) {
                (Some(g), Some(name)) => io_settings(g, name, af_high_speed),
                _ => IoSettings::default(),
            };
            if f1 {
                // F1: af_macro is an AFIO remap *statement*, not a field.
                if let (Some(mac), Some(_)) = (&pl.af_macro, &pl.remap_block) {
                    if !remap_macros.contains(mac) {
                        remap_macros.push(mac.clone());
                    }
                }
            } else {
                settings.alternate = pl.af_macro.clone();
            }
            // Pin stacking (mine-core Q5): a pad shared with a user gpio
            // entry carries ONE GPIO config — the functional signal's io
            // settings merged with the gpio entry's pull, addressed via the
            // entry's label macros.
            let mut label = None;
            if let Some(gcfg) = ctx.doc.gpio.get(base_pad(&pl.pin)) {
                if gcfg.shared_with.contains(&pl.signal) {
                    use stm32ck_engine::config::GpioPull;
                    settings.pull = Some(
                        match gcfg.pull {
                            GpioPull::None => "GPIO_NOPULL",
                            GpioPull::Up => "GPIO_PULLUP",
                            GpioPull::Down => "GPIO_PULLDOWN",
                        }
                        .to_string(),
                    );
                    label = gcfg.label.as_ref().map(|l| sanitize_ident(l));
                }
            }
            let placed = PlacedPin {
                pin: pin_ref(ctx, &pl.pin),
                signal: pl.signal.clone(),
                settings,
                label,
            };
            // Output pins of a PostInit-capable peripheral defer to
            // HAL_TIM_MspPostInit (input-direction pins stay in MspInit —
            // TIM5 IC / TIM3 encoder pins vs TIM1/2/8 PWM outputs).
            let is_input = sig
                .and_then(|s| s.direction.as_deref())
                .is_some_and(|d| d.eq_ignore_ascii_case("input"));
            if msp_post_init.is_some() && !is_input {
                post_pins.push(placed);
            } else {
                pins.push(placed);
            }
        }
        pins.sort_by(|a, b| a.signal.cmp(&b.signal));
        post_pins.sort_by(|a, b| a.signal.cmp(&b.signal));
        // Only remaps the allocator actually chose (non-default groups).
        if !ctx.resolved.pin_plan.remaps.contains_key(&p.instance) {
            remap_macros.clear();
        }

        let clock_enable = if p.clock_enable.is_empty() {
            vec![format!("__HAL_RCC_{}_CLK_ENABLE", p.instance)]
        } else {
            p.clock_enable.clone()
        };

        PeriphGen {
            p,
            mx_name,
            handle,
            calls,
            locals,
            msp_init,
            msp_deinit,
            msp_post_init,
            pins,
            post_pins,
            clock_enable,
            base_address: base_address(p, &env, &mut trace),
            remap_macros,
        }
    }

    /// `uartHandle` / `tim_pwmHandle` — the MSP callback parameter name,
    /// derived from the callback the db names (`HAL_TIM_PWM_MspInit` ->
    /// `tim_pwmHandle`), falling back to the hal mode.
    fn msp_param(&self) -> String {
        self.msp_init
            .as_deref()
            .and_then(|cb| cb.strip_prefix("HAL_"))
            .and_then(|s| s.strip_suffix("_MspInit"))
            .map(|s| format!("{}Handle", s.to_ascii_lowercase()))
            .unwrap_or_else(|| match &self.p.hal_mode {
                Some(hm) => format!("{}Handle", hm.to_ascii_lowercase()),
                None => "handle".to_string(),
            })
    }
}

/// Clone of the resolved blackboard, scoped to `p`. The engine fixpoint
/// already put every final parameter value (defaults included) into the
/// scoped env and published the PossibleValue semaphores — codegen only
/// selects the instance scope.
fn scratch_env<'a>(ctx: &GenCtx<'a>, p: &ResolvedPeriph<'a>) -> Env {
    let mut env = ctx.resolved.env.clone();
    env.scope = Some(p.instance.clone());
    env
}

/// One leaf argument's resolution outcome.
enum FieldVal {
    /// A concrete C literal.
    Lit(String),
    /// A RefParameter backs the field but yields no value, and its type is
    /// integer/double — CubeMX emits an explicit `= 0;` for these struct
    /// fields (I2C OwnAddress1; audit §二-6).
    ZeroDefault,
    /// No parameter backs the field at all (handle plumbing like
    /// TxXferSize/Lock/State) — skipped.
    Missing,
}

/// The text backing parameter `name` for this peripheral: the block's RefMode
/// context first, then the flattened peripheral params, then the applicable
/// RefParameter default. `None` when nothing backs it or the default is the
/// db's "not applicable" spelling.
fn param_text(p: &ResolvedPeriph<'_>, env: &Env, name: &str) -> Option<String> {
    if let Some(v) = env
        .mode_scope
        .as_ref()
        .and_then(|m| p.mode_params.get(m))
        .and_then(|mv| mv.get(name))
    {
        return Some(v.clone());
    }
    if let Some(v) = p.params.get(name) {
        return Some(v.clone());
    }
    // Own trace: an unknown seen while chasing a computed default is not a
    // diagnostic of the field being resolved.
    let mut trace = EvalTrace::default();
    let rp = resolve_param_bound(p.ip, name, &p.instance, env, &mut trace)?;
    let d = rp.default_value.trim();
    (!d.is_empty() && !is_placeholder(d)).then(|| d.to_string())
}

/// Resolve `name` to the literal the db would substitute for it, following
/// the `=<expr>` and `+<param>` codegen indirections. No MethodArg binding is
/// involved — this is the plain "what is this parameter worth here" query.
fn param_value(p: &ResolvedPeriph<'_>, env: &Env, name: &str, depth: usize) -> Option<String> {
    if depth > 8 {
        return None; // cyclic indirection in the db
    }
    let text = param_text(p, env, name)?;
    let t = text.trim();
    if let Some(expr) = t.strip_prefix('=') {
        let expr = expr.trim();
        if let Some(n) = stm32ck_ir::expr::eval_arith(expr, &|n| param_text(p, env, n)) {
            return Some(if n.is_integer() {
                n.numer().to_string()
            } else {
                format!("{n}")
            });
        }
        if !expr.is_empty() && !expr.contains(|c: char| "()+*/,".contains(c)) {
            return Some(bind_ident(expr, &p.instance));
        }
        return None;
    }
    if let Some(fwd) = t.strip_prefix('+') {
        return param_value(p, env, fwd.trim(), depth + 1);
    }
    Some(bind_ident(t, &p.instance))
}

/// Publish, into a scratch blackboard, the parameters a call's `IFCondition`
/// reads but the engine never put there.
///
/// The db routinely guards a call on a *codegen-only* indirection parameter:
/// H5 emits `HAL_UARTEx_DisableFifoMode` under
/// `(UartFIFOMode=UART_FIFOMODE_DISABLE)`, and `UartFIFOMode` is declared as
/// `=FIFOMode` — it exists to spell the HAL macro, so it is never a value on
/// the blackboard. Left unresolved the identifier read as false and the call
/// silently disappeared.
fn env_with_condition_params(
    p: &ResolvedPeriph<'_>,
    env: &Env,
    cond: &stm32ck_ir::expr::Condition,
) -> Env {
    let mut out = env.clone();
    for name in cond.idents() {
        let name = bind_ident(&name, &p.instance);
        if env.get(&name).is_some() || env.semaphores.contains(&name) {
            continue;
        }
        if let Some(v) = param_value(p, env, &name, 0) {
            out.set_scoped(&p.instance, &name, stm32ck_engine::env::Value::Str(v));
        }
    }
    out
}

/// Values the db uses to mean "no value here", none of which may reach C.
/// `null` is the RefParameter spelling; `__NULL` is a CubeMX-internal token
/// that also appears as a real .ioc value (`MonitoredBy-1#... = __NULL`) and
/// as an ADC `NbrOfDiscConversion` default — it is not defined by any STM32
/// HAL header, so emitting it does not compile.
fn is_placeholder(v: &str) -> bool {
    matches!(v.trim(), "null" | "__NULL")
}

/// Resolve one leaf argument value: binding name first (`Mode -> UartMode`),
/// then the plain field name; each looked up in the current block's RefMode
/// context (`mode_params`, via `env.mode_scope`), then the flattened
/// peripheral params, then via condition-ordered instance-bound RefParameter
/// overloads on the scratch env. A `"null"` default means the field does not
/// exist on this instance (plain-timer DeadTime) — Missing, never zero.
fn resolve_field(
    ctx: &GenCtx<'_>,
    p: &ResolvedPeriph<'_>,
    env: &Env,
    trace: &mut EvalTrace,
    bindings: &BTreeMap<String, String>,
    field: &str,
) -> FieldVal {
    let _ = ctx;
    let bound = bindings.get(field).map(String::as_str);
    let mut names: Vec<&str> = Vec::new();
    if let Some(b) = bound {
        names.push(b);
    }
    if !names.contains(&field) {
        names.push(field);
    }
    let mode_vals = env
        .mode_scope
        .as_ref()
        .and_then(|m| p.mode_params.get(m));
    let mut numeric_empty = false;
    for name in names {
        if let Some(v) = mode_vals.and_then(|mv| mv.get(name)) {
            if is_placeholder(v) {
                return FieldVal::Missing;
            }
            return FieldVal::Lit(v.clone());
        }
        if let Some(v) = p.params.get(name) {
            if is_placeholder(v) {
                return FieldVal::Missing;
            }
            return FieldVal::Lit(v.clone());
        }
        if let Some(rp) = resolve_param_bound(p.ip, name, &p.instance, env, trace) {
            let d = rp.default_value.trim();
            if is_placeholder(d) {
                // The db's MethodArg binding is authoritative: a bound
                // parameter that resolves to `null` says the field does not
                // apply here, and must NOT fall through to the plain field
                // name. H5 binds `Channel <- ClearChannel__1`, whose
                // unselected overload is `null`; falling through found the
                // mode's own pinned `Channel` and emitted six bogus
                // HAL_TIM_ConfigOCrefClear calls per timer.
                if Some(name) == bound {
                    return FieldVal::Missing;
                }
                continue; // field not applicable to this instance
            }
            // `=<expr>` is a *computed* default, not a literal: H5 defines
            // `Period` as `=PeriodNoDither` and `Pulse_Channel_1` as
            // `=PulseNoDither_1` (and their dither twins as
            // `=((Integer_PeriodDither*16)+Fractionnal_PeriodDither)`).
            // Dropping the form left every PWM period and pulse at 0.
            // A bare enum token (`=RCC_HSE_ON`) is not arithmetic and stays
            // verbatim, which is the older reading of this prefix.
            if let Some(expr) = d.strip_prefix('=') {
                let expr = expr.trim();
                if let Some(n) =
                    stm32ck_ir::expr::eval_arith(expr, &|n| param_text(p, env, n))
                {
                    return FieldVal::Lit(if n.is_integer() {
                        n.numer().to_string()
                    } else {
                        format!("{n}")
                    });
                }
                if !expr.is_empty() && !expr.contains(|c: char| "()+*/,".contains(c)) {
                    return FieldVal::Lit(bind_ident(expr, &p.instance));
                }
            } else if !d.is_empty() && !d.starts_with('+') {
                return FieldVal::Lit(bind_ident(d, &p.instance));
            }
            if matches!(rp.param_type.as_str(), "integer" | "double") {
                numeric_empty = true;
            }
        }
    }
    if numeric_empty {
        FieldVal::ZeroDefault
    } else {
        FieldVal::Missing
    }
}

/// Append `path = value;` unless the exact same value was already emitted
/// for `path` earlier in this function (CubeMX equal-value elision).
fn push_assign(
    out: &mut Vec<String>,
    emitted: &mut BTreeMap<String, String>,
    path: &str,
    value: &str,
) {
    if emitted.get(path).map(String::as_str) == Some(value) {
        return;
    }
    emitted.insert(path.to_string(), value.to_string());
    out.push(format!("{path} = {value};"));
}

/// The `Instance` field's value: the name of the peripheral's register
/// block, which is NOT always the instance name. I2S is the case that
/// matters on F1/F4 — it has no register block of its own, it drives the SPI
/// one, so the db gives instance `I2S2` an `Instance` RefParameter of
/// `SPI$Index`. Writing `hi2s2.Instance = I2S2;` names a macro no CMSIS
/// header defines. 40 IPs in range carry such an override; everything else
/// has no `Instance` parameter and keeps the instance name.
fn base_address(p: &ResolvedPeriph<'_>, env: &Env, trace: &mut EvalTrace) -> String {
    resolve_param_bound(p.ip, "Instance", &p.instance, env, trace)
        .map(|rp| rp.default_value.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(|d| bind_ident(&d, &p.instance))
        .unwrap_or_else(|| p.instance.clone())
}

/// Same, for a field of the *global handle* struct: written at most once per
/// MX init function, whatever the value.
///
/// Every call in a RefConfig takes the same handle, so the db repeats the
/// full `UART_HandleTypeDef` argument tree on `HAL_UARTEx_SetTxFifoThreshold`
/// as well as on `HAL_UART_Init` — but only the latter carries the
/// `WordLength <- UartWordLength` bindings. Re-walking the tree for the
/// later call resolves the plain parameter instead and rewrites
/// `huart1.Init.WordLength` with the un-prefixed `WORDLENGTH_8B` spelling.
/// The handle's Init struct is programmed by whichever call comes first;
/// later calls contribute only their own arguments.
fn push_handle_assign(
    out: &mut Vec<String>,
    emitted: &mut BTreeMap<String, String>,
    path: &str,
    value: &str,
) {
    if emitted.contains_key(path) {
        return;
    }
    emitted.insert(path.to_string(), value.to_string());
    out.push(format!("{path} = {value};"));
}

/// Recurse the *global handle*'s struct-argument tree into
/// `path.field = value;` lines, each field written at most once per function
/// (see [`push_handle_assign`]).
#[allow(clippy::too_many_arguments)]
fn walk_struct(
    ctx: &GenCtx<'_>,
    p: &ResolvedPeriph<'_>,
    env: &Env,
    trace: &mut EvalTrace,
    bindings: &BTreeMap<String, String>,
    args: &[MethodArgument],
    path: &str,
    out: &mut Vec<String>,
    emitted: &mut BTreeMap<String, String>,
) {
    for a in args {
        match a.generic_type.as_str() {
            "baseaddress" => push_handle_assign(
                out,
                emitted,
                &format!("{path}.{}", a.name),
                &base_address(p, env, trace),
            ),
            "struct" => walk_struct(
                ctx, p, env, trace, bindings, &a.children,
                &format!("{path}.{}", a.name), out, emitted,
            ),
            _ => match resolve_field(ctx, p, env, trace, bindings, &a.name) {
                FieldVal::Lit(v) => {
                    push_handle_assign(out, emitted, &format!("{path}.{}", a.name), &v)
                }
                FieldVal::ZeroDefault => {
                    push_handle_assign(out, emitted, &format!("{path}.{}", a.name), "0")
                }
                FieldVal::Missing => {}
            },
        }
    }
}

/// Resolve every simple field of a local config struct into
/// `("{local}.{field}", value)` pairs — no elision here; the caller uses the
/// count to decide whether the call applies to this instance at all.
#[allow(clippy::too_many_arguments)]
fn collect_struct_fields(
    ctx: &GenCtx<'_>,
    p: &ResolvedPeriph<'_>,
    env: &Env,
    trace: &mut EvalTrace,
    bindings: &BTreeMap<String, String>,
    args: &[MethodArgument],
    path: &str,
    out: &mut Vec<(String, String)>,
) {
    for a in args {
        match a.generic_type.as_str() {
            "struct" => collect_struct_fields(
                ctx, p, env, trace, bindings, &a.children,
                &format!("{path}.{}", a.name), out,
            ),
            "baseaddress" => {}
            _ => match resolve_field(ctx, p, env, trace, bindings, &a.name) {
                FieldVal::Lit(v) => out.push((format!("{path}.{}", a.name), v)),
                FieldVal::ZeroDefault => out.push((format!("{path}.{}", a.name), "0".into())),
                FieldVal::Missing => {}
            },
        }
    }
}

// ---------------------------------------------------------------------------
// User GPIO pins (doc.gpio) — shared by gpio.c and main.h
// ---------------------------------------------------------------------------

struct UserPin {
    pin: PinRef,
    cfg: stm32ck_engine::config::GpioPinCfg,
    /// Sanitized label, if any.
    label: Option<String>,
}

fn user_pins(ctx: &GenCtx<'_>) -> Vec<UserPin> {
    ctx.doc
        .gpio
        .iter()
        .map(|(pad, cfg)| UserPin {
            pin: pin_ref(ctx, pad),
            cfg: cfg.clone(),
            label: cfg.label.as_ref().map(|l| sanitize_ident(l)),
        })
        .collect()
}

fn sanitize_ident(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

impl UserPin {
    fn pin_token(&self) -> String {
        match &self.label {
            Some(l) => format!("{l}_Pin"),
            None => self.pin.pin_macro.clone(),
        }
    }
    fn port_token(&self) -> String {
        match &self.label {
            Some(l) => format!("{l}_GPIO_Port"),
            None => self.pin.port_macro.clone(),
        }
    }
    fn mode_macro(&self) -> &'static str {
        use stm32ck_engine::config::{ExtiTrigger, GpioMode};
        match self.cfg.mode {
            GpioMode::Input => "GPIO_MODE_INPUT",
            GpioMode::Analog => "GPIO_MODE_ANALOG",
            GpioMode::Output => {
                if self.cfg.open_drain {
                    "GPIO_MODE_OUTPUT_OD"
                } else {
                    "GPIO_MODE_OUTPUT_PP"
                }
            }
            GpioMode::Exti => match self.cfg.trigger {
                ExtiTrigger::Rising => "GPIO_MODE_IT_RISING",
                ExtiTrigger::Falling => "GPIO_MODE_IT_FALLING",
                ExtiTrigger::Both => "GPIO_MODE_IT_RISING_FALLING",
            },
        }
    }
    fn pull_macro(&self) -> &'static str {
        use stm32ck_engine::config::GpioPull;
        match self.cfg.pull {
            GpioPull::None => "GPIO_NOPULL",
            GpioPull::Up => "GPIO_PULLUP",
            GpioPull::Down => "GPIO_PULLDOWN",
        }
    }
    fn speed_macro(&self, f1: bool) -> &'static str {
        use stm32ck_engine::config::GpioSpeed;
        match self.cfg.speed {
            GpioSpeed::Low => "GPIO_SPEED_FREQ_LOW",
            GpioSpeed::Medium => "GPIO_SPEED_FREQ_MEDIUM",
            GpioSpeed::High => "GPIO_SPEED_FREQ_HIGH",
            GpioSpeed::VeryHigh => {
                if f1 {
                    "GPIO_SPEED_FREQ_HIGH" // F1 has no VERY_HIGH grade
                } else {
                    "GPIO_SPEED_FREQ_VERY_HIGH"
                }
            }
        }
    }
    fn is_output(&self) -> bool {
        matches!(self.cfg.mode, stm32ck_engine::config::GpioMode::Output)
    }
    fn is_exti(&self) -> bool {
        matches!(self.cfg.mode, stm32ck_engine::config::GpioMode::Exti)
    }
}

/// EXTI line IRQ name for a pin bit (F1/F4 vector layout).
fn exti_irqn(bit: u32) -> String {
    match bit {
        0..=4 => format!("EXTI{bit}_IRQn"),
        5..=9 => "EXTI9_5_IRQn".to_string(),
        _ => "EXTI15_10_IRQn".to_string(),
    }
}

/// A ResolvedIrq raised by a doc.gpio EXTI pin (engine owner "EXTI<line>").
fn is_exti_irq(irq: &stm32ck_engine::session::ResolvedIrq) -> bool {
    irq.owner
        .strip_prefix("EXTI")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

// ---------------------------------------------------------------------------
// DMA (plan §P3) — MX_DMA_Init, MSP hdma fill + LINKDMA, it.c handlers
// ---------------------------------------------------------------------------

/// DMA requests owned by one peripheral instance, resolution (doc) order.
fn dma_of<'a>(ctx: &'a GenCtx<'_>, instance: &str) -> Vec<&'a ResolvedDma> {
    ctx.resolved
        .dma
        .iter()
        .filter(|d| d.owner_instance == instance)
        .collect()
}

/// All resolved requests sorted by (controller, flow index) — the
/// MX_DMA_Init NVIC row / it.c handler order CubeMX emits.
fn dma_by_stream<'a>(ctx: &'a GenCtx<'_>) -> Vec<&'a ResolvedDma> {
    let mut v: Vec<&ResolvedDma> = ctx.resolved.dma.iter().collect();
    v.sort_by(|a, b| {
        (a.controller.as_str(), a.stream_index()).cmp(&(b.controller.as_str(), b.stream_index()))
    });
    v
}

/// HAL_DMA_Init `Init`-struct field order from the DMA ConfigDef's
/// LibMethod (doc order), falling back to the engine's canonical order.
fn dma_init_field_order(ctx: &GenCtx<'_>) -> Vec<String> {
    let fallback = || -> Vec<String> {
        [
            "Channel", "Direction", "PeriphInc", "MemInc", "PeriphDataAlignment",
            "MemDataAlignment", "Mode", "Priority", "FIFOMode", "FIFOThreshold",
            "MemBurst", "PeriphBurst",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    };
    let Some(cf) = ctx
        .resolved
        .part
        .ip_instances
        .iter()
        .find(|i| i.instance == "DMA")
        .and_then(|i| i.config_file.clone())
    else {
        return fallback();
    };
    let Some(lm) = ctx
        .pack
        .configs
        .get(&cf)
        .and_then(|c| c.lib_methods.get("HAL_DMA_Init"))
    else {
        return fallback();
    };
    let Some(init) = lm
        .arguments
        .first()
        .and_then(|root| root.children.iter().find(|a| a.name == "Init"))
    else {
        return fallback();
    };
    init.children.iter().map(|a| a.name.clone()).collect()
}

/// "DMA1_Stream2" -> "DMA1 stream2" (handler doc comment).
fn dma_stream_brief(stream: &str) -> String {
    stream
        .replace("_Stream", " stream")
        .replace("_Channel", " channel")
}

/// The `hdma_x.Instance/.Init.* = ...` fill + guarded HAL_DMA_Init +
/// LINKDMA for every request of `inst`, at MSP indentation. `param` is the
/// MSP callback parameter name (`uartHandle`).
fn msp_dma_init(ctx: &GenCtx<'_>, inst: &str, param: &str, b: &mut Buf) {
    let dmas = dma_of(ctx, inst);
    if dmas.is_empty() {
        return;
    }
    let order = dma_init_field_order(ctx);
    b.line(format!("    /* {inst} DMA Init */"));
    for d in &dmas {
        b.line(format!("    /* {} Init */", d.request));
        b.line(format!("    {}.Instance = {};", d.handle_name, d.stream));
        for field in &order {
            if let Some(v) = d.params.get(field) {
                b.line(format!("    {}.Init.{field} = {v};", d.handle_name));
            }
        }
        b.line(format!("    if (HAL_DMA_Init(&{}) != HAL_OK)", d.handle_name));
        b.line("    {");
        b.line("      Error_Handler();");
        b.line("    }");
        b.blank();
        b.line(format!(
            "    __HAL_LINKDMA({param},{},{});",
            d.link_field, d.handle_name
        ));
        b.blank();
    }
}

/// `Core/Inc/dma.h` (spec §1.2 + the memory-to-memory comment quirk).
fn dma_h(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(
        ctx,
        "dma.h",
        "This file contains all the function prototypes for the dma.c file",
    ));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line("#ifndef __DMA_H__");
    b.line("#define __DMA_H__");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    b.blank();
    b.line("/* DMA memory to memory transfer handles -------------------------------------*/");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.user0("Private defines");
    b.blank();
    b.line("void MX_DMA_Init(void);");
    b.blank();
    b.user0("Prototypes");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line("#endif /* __DMA_H__ */");
    b.into_string()
}

/// `Core/Src/dma.c`: ONLY `MX_DMA_Init` (controller clocks + stream NVIC);
/// the hdma handles live in their owners' files (spec §1 DMA ownership).
fn dma_c(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(
        ctx,
        "dma.c",
        "This file provides code for the configuration of all the requested memory to memory DMA transfers.",
    ));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"dma.h\"");
    b.blank();
    b.user0("0");
    b.blank();
    b.line("/*----------------------------------------------------------------------------*/");
    b.line("/* Configure DMA                                                              */");
    b.line("/*----------------------------------------------------------------------------*/");
    b.blank();
    b.user0("1");
    b.blank();
    mx_dma_init_fn(ctx, &mut b);
    b.user0("2");
    b.blank();
    b.into_string()
}

/// `MX_DMA_Init`: controller clock enables (DMA1 before DMA2, used
/// controllers only) then per-flow NVIC rows in (controller, flow) order.
fn mx_dma_init_fn(ctx: &GenCtx<'_>, b: &mut Buf) {
    b.line("/**");
    b.line("  * Enable DMA controller clock");
    b.line("  */");
    b.line("void MX_DMA_Init(void)");
    b.line("{");
    b.blank();
    b.line("  /* DMA controller clock enable */");
    // `ClockEnableMode` is a `;`-separated list of macro NAMES, not one name:
    // the request-mux families gate the mux and the controller separately
    // (G4 pins `__HAL_RCC_DMAMUX1_CLK_ENABLE;__HAL_RCC_DMA1_CLK_ENABLE`).
    // Each element needs its own call parentheses.
    let clocks: BTreeSet<String> = ctx
        .resolved
        .dma
        .iter()
        .flat_map(|d| d.clock_enable.split(';'))
        .map(|m| m.trim().trim_end_matches("()").to_string())
        .filter(|m| !m.is_empty())
        .collect();
    for mac in &clocks {
        b.line(format!("  {mac}();"));
    }
    b.blank();
    b.line("  /* DMA interrupt init */");
    for d in dma_by_stream(ctx) {
        if !d.nvic.enabled {
            continue;
        }
        b.line(format!("  /* {} interrupt configuration */", d.irqn));
        b.line(format!(
            "  HAL_NVIC_SetPriority({}, {}, {});",
            d.irqn, d.nvic.preemption_priority, d.nvic.sub_priority
        ));
        b.line(format!("  HAL_NVIC_EnableIRQ({});", d.irqn));
    }
    b.blank();
    b.line("}");
    b.blank();
}

// ---------------------------------------------------------------------------
// main.h
// ---------------------------------------------------------------------------

fn main_h(ctx: &GenCtx<'_>, periphs: &[PeriphGen<'_>]) -> String {
    let fam = fam_lower(ctx);
    let mut b = Buf::new();
    b.line(header(ctx, "main.h", "Header for main.c file"));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line("#ifndef __MAIN_H");
    b.line("#define __MAIN_H");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line(format!("#include \"{fam}_hal.h\""));
    b.blank();
    b.line("/* Private includes ----------------------------------------------------------*/");
    b.user0("Includes");
    b.blank();
    b.line("/* Exported types ------------------------------------------------------------*/");
    b.user0("ET");
    b.blank();
    b.line("/* Exported constants --------------------------------------------------------*/");
    b.user0("EC");
    b.blank();
    b.line("/* Exported macro ------------------------------------------------------------*/");
    b.user0("EM");
    b.blank();
    b.line("/* Exported functions prototypes ---------------------------------------------*/");
    b.line("void Error_Handler(void);");
    b.blank();
    b.user0("EFP");
    b.blank();
    b.line("/* Private defines -----------------------------------------------------------*/");
    // Labeled user pins first (pad order), then peripheral placements
    // (signal order). Stacked pads (a placement sharing a labeled gpio
    // entry) keep only the label defines — the shared pad has ONE identity.
    for up in &user_pins(ctx) {
        if let Some(l) = &up.label {
            b.line(format!("#define {l}_Pin {}", up.pin.pin_macro));
            b.line(format!("#define {l}_GPIO_Port {}", up.pin.port_macro));
            if up.is_exti() {
                b.line(format!("#define {l}_EXTI_IRQn {}", exti_irqn(up.pin.bit)));
            }
        }
    }
    for pg in periphs {
        for pp in pg.pins.iter().chain(&pg.post_pins) {
            if pp.label.is_some() {
                continue; // stacked pad: label defines already emitted
            }
            let name = sanitize_ident(&pp.signal);
            b.line(format!("#define {name}_Pin {}", pp.pin.pin_macro));
            b.line(format!("#define {name}_GPIO_Port {}", pp.pin.port_macro));
        }
    }
    // project.userConstants: symbolic values referenced by peripheral
    // params (ioc Mcu.UserConstants — ODrive's TIM_1_8_PERIOD_CLOCKS).
    if !ctx.doc.project.user_constants.is_empty() {
        b.blank();
        for (name, expr) in &ctx.doc.project.user_constants {
            b.line(format!("#define {name} {expr}"));
        }
    }
    b.blank();
    b.user0("Private defines");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line("#endif /* __MAIN_H */");
    b.into_string()
}

// ---------------------------------------------------------------------------
// main.c
// ---------------------------------------------------------------------------

fn main_c(
    ctx: &GenCtx<'_>,
    periphs: &[PeriphGen<'_>],
    groups: &[(String, Vec<usize>)],
) -> String {
    let hooks = crate::middleware::main_hooks(ctx);
    let mut b = Buf::new();
    b.line(header(ctx, "main.c", "Main program body"));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    // Middleware headers (cmsis_os.h slot), then the coupled per-IP
    // headers alphabetically, gpio.h ALWAYS LAST (spec §1.3).
    for inc in &hooks.includes {
        b.line(format!("#include \"{inc}\""));
    }
    let mut coupled: Vec<String> = groups.iter().map(|(s, _)| s.clone()).collect();
    if !ctx.resolved.dma.is_empty() {
        coupled.push("dma".to_string());
    }
    coupled.sort();
    for stem in &coupled {
        b.line(format!("#include \"{stem}.h\""));
    }
    b.line("#include \"gpio.h\"");
    b.blank();
    b.line("/* Private includes ----------------------------------------------------------*/");
    b.user0("Includes");
    b.blank();
    b.line("/* Private typedef -----------------------------------------------------------*/");
    b.user0("PTD");
    b.blank();
    b.line("/* Private define ------------------------------------------------------------*/");
    b.user0("PD");
    b.blank();
    b.line("/* Private macro -------------------------------------------------------------*/");
    b.user0("PM");
    b.blank();
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.user0("PV");
    b.blank();
    b.line("/* Private function prototypes -----------------------------------------------*/");
    b.line("void SystemClock_Config(void);");
    for proto in &hooks.prototypes {
        b.line(proto);
    }
    b.user0("PFP");
    b.blank();
    b.line("/* Private user code ---------------------------------------------------------*/");
    b.user0("0");
    b.blank();
    b.line("/**");
    b.line("  * @brief  The application entry point.");
    b.line("  * @retval int");
    b.line("  */");
    b.line("int main(void)");
    b.line("{");
    b.blank();
    b.user("1");
    b.blank();
    b.line("  /* MCU Configuration--------------------------------------------------------*/");
    b.blank();
    b.line("  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */");
    b.line("  HAL_Init();");
    // Non-default priority grouping only: HAL_Init already programs
    // NVIC_PRIORITYGROUP_4 (the reference main.c has no call).
    if let Some(pg) = ctx.doc.nvic.priority_group.as_deref() {
        if pg != "NVIC_PRIORITYGROUP_4" {
            b.blank();
            b.line(format!("  HAL_NVIC_SetPriorityGrouping({pg});"));
        }
    }
    b.blank();
    b.user("Init");
    b.blank();
    b.line("  /* Configure the system clock */");
    b.line("  SystemClock_Config();");
    b.blank();
    b.user("SysInit");
    b.blank();
    b.line("  /* Initialize all configured peripherals */");
    for call in &hooks.pre_init_calls {
        b.line(format!("  {call}"));
    }
    b.line("  MX_GPIO_Init();");
    // CubeMX calls MX_DMA_Init before every peripheral init (the MSP
    // HAL_DMA_Init calls need the controller clocks; reference main.c
    // order: MX_GPIO_Init, MX_DMA_Init, peripherals).
    if !ctx.resolved.dma.is_empty() {
        b.line("  MX_DMA_Init();");
    }
    for pg in ordered_for_init(ctx, periphs) {
        b.line(format!("  {}();", pg.mx_name));
    }
    b.user("2");
    b.blank();
    for call in &hooks.post_init_calls {
        b.line(call);
    }
    if !hooks.post_init_calls.is_empty() {
        b.blank();
    }
    b.line("  /* Infinite loop */");
    b.line("  /* USER CODE BEGIN WHILE */");
    b.line("  while (1)");
    b.line("  {");
    b.line("    /* USER CODE END WHILE */");
    b.blank();
    b.line("    /* USER CODE BEGIN 3 */");
    b.line("  }");
    b.line("  /* USER CODE END 3 */");
    b.line("}");
    b.blank();
    system_clock_config(ctx, &mut b);
    b.line("/* USER CODE BEGIN 4 */");
    b.blank();
    b.line("/* USER CODE END 4 */");
    b.blank();
    // HAL timebase: the tick increment lives in main.c (spec §3.2).
    if let Some(tb) = &ctx.resolved.timebase {
        b.line("/**");
        b.line("  * @brief  Period elapsed callback in non blocking mode");
        b.line(format!(
            "  * @note   This function is called  when {} interrupt took place, inside",
            tb.tim
        ));
        b.line("  * HAL_TIM_IRQHandler(). It makes a direct call to HAL_IncTick() to increment");
        b.line("  * a global variable \"uwTick\" used as application time base.");
        b.line("  * @param  htim : TIM handle");
        b.line("  * @retval None");
        b.line("  */");
        b.line("void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)");
        b.line("{");
        b.line("  /* USER CODE BEGIN Callback 0 */");
        b.blank();
        b.line("  /* USER CODE END Callback 0 */");
        b.line(format!("  if (htim->Instance == {})", tb.tim));
        b.line("  {");
        b.line("    HAL_IncTick();");
        b.line("  }");
        b.line("  /* USER CODE BEGIN Callback 1 */");
        b.blank();
        b.line("  /* USER CODE END Callback 1 */");
        b.line("}");
        b.blank();
    }
    for code in &hooks.callbacks_code {
        b.line(code);
        b.blank();
    }
    b.line("/**");
    b.line("  * @brief  This function is executed in case of error occurrence.");
    b.line("  * @retval None");
    b.line("  */");
    b.line("void Error_Handler(void)");
    b.line("{");
    b.line("  /* USER CODE BEGIN Error_Handler_Debug */");
    b.line("  /* User can add his own implementation to report the HAL error return state */");
    b.line("  __disable_irq();");
    b.line("  while (1)");
    b.line("  {");
    b.line("  }");
    b.line("  /* USER CODE END Error_Handler_Debug */");
    b.line("}");
    b.blank();
    b.line("#ifdef  USE_FULL_ASSERT");
    b.line("/**");
    b.line("  * @brief  Reports the name of the source file and the source line number");
    b.line("  *         where the assert_param error has occurred.");
    b.line("  * @param  file: pointer to the source file name");
    b.line("  * @param  line: assert_param error line source number");
    b.line("  * @retval None");
    b.line("  */");
    b.line("void assert_failed(uint8_t *file, uint32_t line)");
    b.line("{");
    b.line("  /* USER CODE BEGIN 6 */");
    b.line("  /* User can add his own implementation to report the file name and line number,");
    b.line("     ex: printf(\"Wrong parameters value: file %s on line %d\\r\\n\", file, line) */");
    b.line("  /* USER CODE END 6 */");
    b.line("}");
    b.line("#endif /* USE_FULL_ASSERT */");
    b.into_string()
}

/// main() peripheral init-call order: `project.initOrder` names first (in
/// list order), then every remaining instance in deterministic (sorted)
/// document order. Unknown names were already diagnosed by the engine.
/// Middleware-owned instances (P7) get no `MX_*_Init` call — the
/// middleware's own init path covers them (`USBD_LL_Init`).
fn ordered_for_init<'a, 'b>(
    ctx: &GenCtx<'_>,
    periphs: &'b [PeriphGen<'a>],
) -> Vec<&'b PeriphGen<'a>> {
    let owned = crate::middleware::owned_instances(ctx);
    let mut out: Vec<&PeriphGen<'_>> = Vec::new();
    let mut taken: BTreeSet<&str> = BTreeSet::new();
    for name in &ctx.doc.project.init_order {
        if let Some(pg) = periphs.iter().find(|pg| pg.p.instance == *name) {
            if !owned.contains(&pg.p.instance) && taken.insert(pg.p.instance.as_str()) {
                out.push(pg);
            }
        }
    }
    for pg in periphs {
        if !owned.contains(&pg.p.instance) && !taken.contains(pg.p.instance.as_str()) {
            out.push(pg);
        }
    }
    out
}

/// One `MX_<...>_Init` body from the resolved call model. Non-static since
/// the file split (declared in the owning family header).
fn mx_init_fn(pg: &PeriphGen<'_>, b: &mut Buf) {
    let inst = &pg.p.instance;
    b.line(format!("/* {inst} init function */"));
    b.line(format!("void {}(void)", pg.mx_name));
    b.line("{");
    b.blank();
    b.user(&format!("{inst}_Init 0"));
    b.blank();
    if !pg.locals.is_empty() {
        for (name, ty) in &pg.locals {
            b.line(format!("  {ty} {name} = {{0}};"));
        }
        b.blank();
    }
    b.user(&format!("{inst}_Init 1"));
    for call in &pg.calls {
        for a in &call.assigns {
            b.line(format!("  {a}"));
        }
        match &call.guard {
            Some(cmp) => {
                b.line(format!("  if ({} != {cmp})", call.expr));
                b.line("  {");
                b.line("    Error_Handler();");
                b.line("  }");
            }
            None => b.line(format!("  {};", call.expr)),
        }
    }
    b.user(&format!("{inst}_Init 2"));
    // CubeMX defers TIM AF output pins to HAL_TIM_MspPostInit, called at
    // the very end of the MX init function.
    if let (Some(cb), Some(h), false) = (&pg.msp_post_init, &pg.handle, pg.post_pins.is_empty()) {
        b.line(format!("  {cb}(&{});", h.name));
    }
    b.blank();
    b.line("}");
    b.blank();
}

// ---------------------------------------------------------------------------
// SystemClock_Config
// ---------------------------------------------------------------------------

/// Global (unscoped) parameter lookup on the resolved blackboard.
fn envp(ctx: &GenCtx<'_>, name: &str) -> Option<String> {
    ctx.resolved.env.params.get(name).map(|v| v.as_str())
}

/// The part's RCC IP definition — the source of oscillator inventory and of
/// the `*ARG` indirection parameters codegen resolves.
fn rcc_ip<'a>(ctx: &GenCtx<'a>) -> Option<&'a stm32ck_ir::model::IpDef> {
    ctx.resolved
        .part
        .ip_instances
        .iter()
        .find(|i| i.name == "RCC")
        .and_then(|i| ctx.pack.ips.get(&format!("{}-{}", i.name, i.version)))
}

/// The RCC codegen definition (`RCC-STM32H7xx`), which carries the
/// `HAL_RCC_OscConfig` / `HAL_RCC_ClockConfig` struct shapes and the
/// field -> parameter bindings.
///
/// Most-specific first: a sub-line whose RCC IP version names its own
/// definition wins over the family default. H7RS parts live in the H7 pack
/// but carry `STM32H7RS_rcc_v1_0` and a genuinely different oscillator
/// struct, so `RCC-STM32H7RSxx` is the right shape for them and
/// `RCC-STM32H7xx` is the wrong one.
fn rcc_config<'a>(ctx: &GenCtx<'a>) -> Option<&'a stm32ck_ir::model::ConfigDef> {
    let by_version = ctx
        .resolved
        .part
        .ip_instances
        .iter()
        .find(|i| i.name == "RCC")
        .and_then(|i| i.version.split('_').next())
        .filter(|prefix| prefix.starts_with("STM32"))
        .and_then(|prefix| ctx.pack.configs.get(&format!("RCC-{prefix}xx")));
    by_version.or_else(|| ctx.pack.configs.get(&format!("RCC-{}xx", ctx.family())))
}

/// Resolve one RefParameter name to a literal through the db's codegen
/// indirections. `DefaultValue` forms:
///
/// * `+Other`            -> the value of `Other` (recursively);
/// * `=LITERAL`          -> that literal verbatim;
/// * `+A+|B+|C`          -> concatenation: split on `+`, each chunk is an
///   optional literal prefix plus a parameter name (`+|B` = `"|"` + B's
///   value). This is how H7 spells the six-way `ClockType` OR-list.
/// * anything else       -> the value itself.
///
/// `null` / empty anywhere means "this field does not apply to this device",
/// and the caller omits the assignment — which is exactly how a shared struct
/// shape is specialized per part (an F405 has no `PLLR`, so `PLLRARG`
/// resolves to `null`).
fn resolve_rcc_value(ctx: &GenCtx<'_>, ip: &stm32ck_ir::model::IpDef, name: &str) -> Option<String> {
    fn go(
        ctx: &GenCtx<'_>,
        ip: &stm32ck_ir::model::IpDef,
        name: &str,
        depth: usize,
    ) -> Option<String> {
        if depth > 8 {
            return None; // cyclic indirection in the db; give up quietly
        }
        // A live value (solver assignment / propagated default) wins.
        if let Some(v) = envp(ctx, name) {
            if !v.is_empty() && v != "null" && !v.starts_with('+') && !v.starts_with('=') {
                return Some(v);
            }
        }
        // A guard the device satisfies is authoritative, value or not. The
        // db uses an empty/`null` value under a satisfied guard to say "this
        // field does not exist on this device": WBA52 matches
        // `(STM32WBAx4|STM32WBAx2|STM32WBAx0)` on an empty `SupplySource`
        // because its PWR has no selectable supply, and STM32WLE5 clears
        // `ClockTypeHCLK2` the same way (that domain belongs to the dual-core
        // WL55). Emitting the family's other spelling does not compile.
        //
        // With no guard satisfied, fall back to the first overload that
        // carries a value — NOT the first whose condition holds. The `*ARG`
        // parameters exist purely to gate a field, on CubeMX-internal "is
        // this domain on the dialog" flags (`HCLKtoConfigure`,
        // `SysClkToConfigure`) that this engine does not model; taking their
        // `null` fallback would drop every prescaler. The real gate there is
        // whether the parameter they forward to has a value at all — an F405
        // has no `PLLR`, so `PLLRARG` yields nothing and the field is omitted
        // exactly as CubeMX omits it.
        let mut trace = stm32ck_engine::eval::EvalTrace::default();
        let overloads = stm32ck_engine::params::overloads_of(ip, name);
        let satisfied = overloads.iter().find(|rp| {
            rp.condition.as_ref().is_some_and(|c| {
                stm32ck_engine::eval::eval_condition(&c.condition, &ctx.resolved.env, &mut trace)
            })
        });
        let unconditional = overloads.iter().find(|rp| rp.condition.is_none());
        let dv = match (satisfied, unconditional) {
            (Some(rp), _) => {
                let dv = rp.default_value.trim();
                if dv.is_empty() || dv == "null" {
                    return None;
                }
                dv
            }
            // An unconditional *empty* default is the db's "not on this
            // device" (WLE5's `ClockTypeHCLK2`). An unconditional `null` is
            // the `*ARG` gate idiom instead, and falls through — its guard is
            // a CubeMX dialog flag this engine does not model, and taking the
            // `null` would drop H7's APB3/APB4 prescalers.
            (None, Some(rp)) if rp.default_value.trim().is_empty() => return None,
            (None, Some(rp)) if rp.default_value.trim() != "null" => rp.default_value.trim(),
            (None, _) => overloads
                .iter()
                .map(|rp| rp.default_value.trim())
                .find(|dv| !dv.is_empty() && *dv != "null")?,
        };
        if let Some(lit) = dv.strip_prefix('=') {
            return Some(lit.to_string());
        }
        if !dv.starts_with('+') {
            return Some(dv.to_string());
        }
        // Concatenation of `+<literal?><param>` chunks.
        let mut out = String::new();
        for chunk in dv.split('+').skip(1) {
            let split = chunk
                .find(|c: char| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(chunk.len());
            let (literal, param) = chunk.split_at(split);
            out.push_str(literal);
            if param.is_empty() {
                continue;
            }
            match go(ctx, ip, param, depth + 1) {
                Some(v) => out.push_str(&v),
                // A dark member of a concatenation drops the whole chunk,
                // including the separator it brought.
                None => out.truncate(out.len() - literal.len()),
            }
        }
        (!out.is_empty()).then_some(out)
    }
    go(ctx, ip, name, 0)
}

/// Value for one struct field of an RCC call, following the RefConfig's
/// `field -> parameter` binding and then the indirection chain.
fn rcc_field_value(
    ctx: &GenCtx<'_>,
    ip: &stm32ck_ir::model::IpDef,
    bindings: &std::collections::BTreeMap<String, String>,
    field: &str,
) -> Option<String> {
    let bound = bindings.get(field).map(String::as_str).unwrap_or(field);
    if let Some(lit) = bound.strip_prefix('=') {
        return Some(lit.to_string());
    }
    resolve_rcc_value(ctx, ip, bound)
}

/// Field names of one call's struct argument, in db document order — the
/// order CubeMX assigns them in. `path` selects a nested sub-struct
/// (`Some("PLL")` -> the PLL members); `None` -> the top-level members,
/// sub-structs excluded.
fn rcc_struct_fields(
    cfg: &stm32ck_ir::model::ConfigDef,
    method: &str,
    path: Option<&str>,
) -> Vec<String> {
    let Some(lm) = cfg.lib_methods.get(method) else {
        return Vec::new();
    };
    // The struct argument is the first `struct`-typed argument of the method.
    let Some(root) = lm.arguments.iter().find(|a| a.generic_type == "struct") else {
        return Vec::new();
    };
    let members = match path {
        None => &root.children,
        Some(p) => match root.children.iter().find(|a| a.name == p) {
            Some(sub) => &sub.children,
            None => return Vec::new(),
        },
    };
    members
        .iter()
        .filter(|a| a.generic_type != "struct")
        .map(|a| a.name.clone())
        .collect()
}

/// The PLL sub-struct of an RCC call's struct argument: its member name and
/// its fields, in db document order.
///
/// The name is family data, not a constant: F1..U5 spell it `PLL`, the
/// multi-PLL trees (N6, WBA6) spell it `PLL1`, and the families with no PLL
/// at all (C0, WB0, WL3) have no such member — for those, emitting
/// `RCC_OscInitStruct.PLL.PLLState = RCC_PLL_NONE` does not compile.
fn rcc_pll_substruct(
    cfg: &stm32ck_ir::model::ConfigDef,
    method: &str,
) -> Option<(String, Vec<String>)> {
    let lm = cfg.lib_methods.get(method)?;
    let root = lm.arguments.iter().find(|a| a.generic_type == "struct")?;
    let sub = root
        .children
        .iter()
        .find(|a| a.generic_type == "struct" && a.name.starts_with("PLL"))?;
    let fields = sub
        .children
        .iter()
        .filter(|a| a.generic_type != "struct")
        .map(|a| a.name.clone())
        .collect();
    Some((sub.name.clone(), fields))
}

/// Bindings of the single `method` call inside `ref_config`, merged in call
/// order (H7's `RCC_ConfigVoltageScaling` lists the same method twice under
/// different IFConditions; the first binding wins).
fn rcc_bindings(
    cfg: &stm32ck_ir::model::ConfigDef,
    ref_config: &str,
    method: &str,
) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    if let Some(rc) = cfg.ref_configs.get(ref_config) {
        for call in rc.calls.iter().filter(|c| c.method == method) {
            for (k, v) in &call.arg_bindings {
                out.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
    }
    out
}

/// The RefConfig that calls `method`, and the field->parameter bindings of
/// that call.
///
/// The RefConfig name is not fixed: H7 puts `HAL_RCCEx_PeriphCLKConfig` in
/// `RCC_PeriphClockConfig`, F1 hangs it off `RCC_ClockConfig`. Names
/// containing `Common` are the dual-core *shared* variant (H7's
/// `C_`-prefixed parameter set) and lose to the plain one, which is what a
/// single-context project wants.
type CallSite<'a> = (&'a str, std::collections::BTreeMap<String, String>);

fn rcc_call_site<'a>(
    cfg: &'a stm32ck_ir::model::ConfigDef,
    method: &str,
) -> Option<CallSite<'a>> {
    let mut hits: Vec<&str> = cfg
        .ref_configs
        .iter()
        .filter(|(_, rc)| rc.calls.iter().any(|c| c.method == method))
        .map(|(name, _)| name.as_str())
        .collect();
    hits.sort_by_key(|n| (n.contains("Common"), *n));
    let name = hits.first().copied()?;
    Some((name, rcc_bindings(cfg, name, method)))
}

/// OR-join of every satisfied overload of `name`.
///
/// `PeriphClockSelectionARG` is not a first-match parameter: it has 144
/// overloads on H7, each guarded by one `<IP>Used_ForRCC` and each
/// contributing a single `RCC_PERIPHCLK_*` flag. CubeMX collects all of them;
/// taking only the first would program one peripheral's kernel clock and
/// silently drop the rest.
fn resolve_rcc_accumulated(
    ctx: &GenCtx<'_>,
    ip: &stm32ck_ir::model::IpDef,
    name: &str,
) -> Vec<String> {
    let mut trace = stm32ck_engine::eval::EvalTrace::default();
    let mut out: Vec<String> = Vec::new();
    for rp in stm32ck_engine::params::overloads_of(ip, name) {
        let holds = rp.condition.as_ref().is_some_and(|c| {
            stm32ck_engine::eval::eval_condition(&c.condition, &ctx.resolved.env, &mut trace)
        });
        if !holds {
            continue;
        }
        let dv = rp.default_value.trim();
        if dv.is_empty() || dv == "null" {
            continue;
        }
        // Overloads may forward (`+Other`) just like anywhere else.
        let value = if dv.starts_with('+') || dv.starts_with('=') {
            match resolve_rcc_value(ctx, ip, name) {
                Some(v) => v,
                None => continue,
            }
        } else {
            dv.to_string()
        };
        for term in value.split('|').map(str::trim).filter(|t| !t.is_empty()) {
            if !out.iter().any(|e| e == term) {
                out.push(term.to_string());
            }
        }
    }
    out
}

/// Value for one `HAL_RCCEx_PeriphCLKConfig` struct field, emitted only when
/// the db says this peripheral is actually in use.
///
/// Every field of that struct binds to an `*ARG` parameter guarded by
/// `<IP>Used_ForRCC` — a semaphore the engine really does model, unlike the
/// dialog flags behind the `HAL_RCC_ClockConfig` prescaler ARGs. So here an
/// unsatisfied guard means "this peripheral is not configured", and the field
/// must be left out rather than falling back to the first valued overload.
fn periph_field_value(
    ctx: &GenCtx<'_>,
    ip: &stm32ck_ir::model::IpDef,
    bindings: &std::collections::BTreeMap<String, String>,
    field: &str,
) -> Option<String> {
    let bound = bindings.get(field)?;
    if bound.is_empty() {
        return None;
    }
    if let Some(lit) = bound.strip_prefix('=') {
        return Some(lit.to_string());
    }
    let mut trace = stm32ck_engine::eval::EvalTrace::default();
    let satisfied = stm32ck_engine::params::overloads_of(ip, bound)
        .into_iter()
        .any(|rp| {
            rp.condition.as_ref().is_some_and(|c| {
                stm32ck_engine::eval::eval_condition(&c.condition, &ctx.resolved.env, &mut trace)
            })
        });
    if !satisfied {
        return None;
    }
    resolve_rcc_value(ctx, ip, bound)
}

/// Whether `ref_config` calls `method` at all under a guard this
/// configuration satisfies. H7 reaches `HAL_PWREx_ConfigSupply`
/// unconditionally; WBA lists it only for dies whose HAL has the function.
fn rcc_calls_method(
    ctx: &GenCtx<'_>,
    cfg: &stm32ck_ir::model::ConfigDef,
    ref_config: &str,
    method: &str,
) -> bool {
    let Some(rc) = cfg.ref_configs.get(ref_config) else {
        return false;
    };
    let mut trace = stm32ck_engine::eval::EvalTrace::default();
    rc.calls
        .iter()
        .filter(|c| c.method == method)
        .any(|c| match &c.condition {
            None => true,
            Some(cond) => {
                stm32ck_engine::eval::eval_condition(cond, &ctx.resolved.env, &mut trace)
            }
        })
}

/// Oscillator-value macros this family needs on top of the four the fixed
/// hal_conf block emits (HSE/HSI/LSI/LSE, plus EXTERNAL_CLOCK outside F1).
///
/// An RCC RefParameter named `<X>_VALUE` is the db saying "this device has
/// oscillator X". `*Freq*` parameters are excluded: those are propagated
/// frequencies (`SYSCLKFreq_VALUE`), not hal_conf inputs. `VDD_VALUE` has its
/// own emission below in millivolts.
///
/// Returns `(macro, value)` pairs, name-sorted for determinism.
fn extra_oscillator_values(ctx: &GenCtx<'_>, f1: bool) -> Vec<(String, String)> {
    let mut already: BTreeSet<&str> =
        ["HSE_VALUE", "HSI_VALUE", "LSI_VALUE", "LSE_VALUE", "VDD_VALUE"]
            .into_iter()
            .collect();
    if !f1 {
        already.insert("EXTERNAL_CLOCK_VALUE");
    }
    let Some(rcc) = ctx
        .resolved
        .part
        .ip_instances
        .iter()
        .find(|i| i.name == "RCC")
        .and_then(|i| ctx.pack.ips.get(&format!("{}-{}", i.name, i.version)))
    else {
        return Vec::new();
    };
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for rp in &rcc.ref_parameters {
        if !rp.name.ends_with("_VALUE")
            || rp.name.contains("Freq")
            || already.contains(rp.name.as_str())
        {
            continue;
        }
        // Live value first (a user may have configured it), else the db
        // default. Non-numeric defaults are indirections, not frequencies.
        let value = envp(ctx, &rp.name).unwrap_or_else(|| rp.default_value.trim().to_string());
        if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        out.entry(rp.name.clone()).or_insert(value);
    }
    out.into_iter().collect()
}

/// Macros ST's hal_conf template declares that nothing else in this file
/// emits, restricted to the ones this project's enabled modules read.
/// Sorted for determinism.
fn template_only_values(
    ctx: &GenCtx<'_>,
    f1: bool,
    enabled: &BTreeSet<String>,
) -> Vec<(String, String)> {
    let Some(fw) = ctx.fw.as_ref() else {
        return Vec::new();
    };
    // Everything the fixed blocks of this file already emit.
    let mut emitted: BTreeSet<String> = [
        "HSE_VALUE",
        "HSI_VALUE",
        "LSI_VALUE",
        "LSE_VALUE",
        "VDD_VALUE",
        "HSE_STARTUP_TIMEOUT",
        "LSE_STARTUP_TIMEOUT",
        "TICK_INT_PRIORITY",
        "PREFETCH_ENABLE",
        "INSTRUCTION_CACHE_ENABLE",
        "DATA_CACHE_ENABLE",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if !f1 {
        emitted.insert("EXTERNAL_CLOCK_VALUE".to_string());
    }
    emitted.extend(extra_oscillator_values(ctx, f1).into_iter().map(|(n, _)| n));
    fw.hal_conf_values
        .iter()
        .filter(|(name, _)| !emitted.contains(name.as_str()))
        // No module tag = read by the always-compiled core. Otherwise the
        // macro is only needed when one of its readers is enabled.
        .filter(|(_, m)| m.modules.is_empty() || m.modules.iter().any(|x| enabled.contains(x)))
        .map(|(n, m)| (n.clone(), m.value.clone()))
        .collect()
}

/// The oscillator an `RCC_OscInitTypeDef` member belongs to, matched
/// longest-prefix-first so `HSI48State` is HSI48 and not HSI.
fn osc_of(field: &str) -> Option<&'static str> {
    const OSCILLATORS: [&str; 10] = [
        "HSI48", "MSIK", "MSIS", "HSI16", "SHSI", "HSE", "HSI", "LSE", "LSI", "CSI",
    ];
    OSCILLATORS.into_iter().find(|o| field.starts_with(o))
}

fn system_clock_config(ctx: &GenCtx<'_>, b: &mut Buf) {
    let f1 = is_f1(ctx);
    let derived = &ctx.resolved.clock.derived;
    let has_hse = ctx.doc.clock.sources.contains_key("HSE");
    let has_lse = ctx.doc.clock.sources.contains_key("LSE");
    let lsi_on = envp(ctx, "LSIState").as_deref() == Some("RCC_LSI_ON");
    let sysclk_src = envp(ctx, "SYSCLKSource").unwrap_or_default();
    let pll_src = envp(ctx, "PLLSourceVirtual").unwrap_or_default();
    let pll_used = sysclk_src.contains("PLL");
    let hsi_used = pll_src.contains("HSI") || sysclk_src.contains("HSI");

    // Peripheral kernel clocks, entirely from the db: the RefConfig that
    // calls HAL_RCCEx_PeriphCLKConfig, the OR-list of domains to program, and
    // the per-domain selection fields. Empty list = nothing to configure and
    // no call at all.
    let periph = periph_clk_block(ctx);

    b.line("/**");
    b.line("  * @brief System Clock Configuration");
    b.line("  * @retval None");
    b.line("  */");
    b.line("void SystemClock_Config(void)");
    b.line("{");
    b.line("  RCC_OscInitTypeDef RCC_OscInitStruct = {0};");
    b.line("  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};");
    if periph.is_some() {
        b.line("  RCC_PeriphCLKInitTypeDef PeriphClkInit = {0};");
    }
    b.blank();

    // Power preamble, driven by the family's RCC_ConfigVoltageScaling /
    // RCC_MODIFY_REG call lists rather than a family switch: F1 has neither
    // and gets nothing; F4 gates the PWR clock then sets the scale; H5/H7
    // have no PWR clock gate at all (the macro does not exist in their HAL)
    // and must instead wait for VOSRDY, with H7 additionally selecting its
    // supply source.
    let cfg = rcc_config(ctx);
    if let (Some(cfg), Some(ip)) = (cfg, rcc_ip(ctx)) {
        let supply = rcc_bindings(cfg, "RCC_MODIFY_REG", "HAL_PWREx_ConfigSupply");
        // No resolvable supply source = this die has no selectable supply
        // (WBA52's PWR has no REGSEL, and its HAL declares the function only
        // `#if defined(PWR_CR3_REGSEL)`), so the call must not be emitted.
        let src = rcc_field_value(ctx, ip, &supply, "SupplySource");
        if let Some(src) = src {
            if rcc_calls_method(ctx, cfg, "RCC_MODIFY_REG", "HAL_PWREx_ConfigSupply") {
                b.line("  /** Supply configuration update enable");
                b.line("  */");
                b.line(format!("  HAL_PWREx_ConfigSupply({src});"));
                b.blank();
            }
        }
    }
    let scaling: Vec<&stm32ck_ir::model::ConfigCall> = cfg
        .and_then(|c| c.ref_configs.get("RCC_ConfigVoltageScaling"))
        .map(|rc| rc.calls.iter().collect())
        .unwrap_or_default();
    if !scaling.is_empty() {
        b.line("  /** Configure the main internal regulator output voltage");
        b.line("  */");
        let scale = derived
            .get("PWR_Regulator_Voltage_Scale")
            .cloned()
            .unwrap_or_default();
        for call in &scaling {
            // A HardCode call is the db shipping a statement no HAL function
            // covers — H7's VOSRDY spin-wait. Families that need it say so;
            // L0/L1/WB/WL do not, and their HAL has no PWR_FLAG_VOSRDY.
            if let Some(text) = &call.hard_code {
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    b.line(line);
                }
                continue;
            }
            match call.method.as_str() {
                "__HAL_RCC_PWR_CLK_ENABLE" => b.line("  __HAL_RCC_PWR_CLK_ENABLE();"),
                "__HAL_PWR_VOLTAGESCALING_CONFIG" if !scale.is_empty() => {
                    b.line(format!("  __HAL_PWR_VOLTAGESCALING_CONFIG({scale});"))
                }
                // U5/WBA replaced the macro with a checked function.
                "HAL_PWREx_ControlVoltageScaling" if !scale.is_empty() => {
                    b.line(format!(
                        "  if (HAL_PWREx_ControlVoltageScaling({scale}) != HAL_OK)"
                    ));
                    b.line("  {");
                    b.line("    Error_Handler();");
                    b.line("  }");
                }
                _ => {}
            }
        }
        b.blank();
    }

    b.line("  /** Initializes the RCC Oscillators according to the specified parameters");
    b.line("  * in the RCC_OscInitTypeDef structure.");
    b.line("  */");
    // Oscillator selection: HSE/LSE when configured, HSI always (CubeMX F1
    // convention; harmless on F4), LSI when the tree turned it on.
    let mut osc: Vec<&str> = Vec::new();
    if has_hse {
        osc.push("RCC_OSCILLATORTYPE_HSE");
    }
    osc.push("RCC_OSCILLATORTYPE_HSI");
    if has_lse {
        osc.push("RCC_OSCILLATORTYPE_LSE");
    }
    if lsi_on {
        osc.push("RCC_OSCILLATORTYPE_LSI");
    }
    // Oscillator members walk the db's own field list, in its document order.
    // The presence-gated ones keep their derived values; every other member
    // the db declares resolves through the `*ARG` indirection exactly like the
    // PLL members do. Emitting only a hand-picked set silently dropped H5's
    // `HSIDiv` and `HSI48State` — a config asking for `RCC_HSI_DIV1` still ran
    // the HSI through the reset /2 divider, at half the intended SYSCLK.
    let osc_fields = match rcc_config(ctx) {
        Some(cfg) => rcc_struct_fields(cfg, "HAL_RCC_OscConfig", None),
        None => Vec::new(),
    };
    let osc_fields = if osc_fields.is_empty() {
        ["OscillatorType", "HSEState", "LSEState", "HSIState",
         "HSICalibrationValue", "LSIState"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        osc_fields
    };
    let osc_bindings = match rcc_config(ctx) {
        Some(cfg) => rcc_bindings(cfg, "RCC_OSCConfig", "HAL_RCC_OscConfig"),
        None => BTreeMap::new(),
    };
    let osc_mask: BTreeSet<&str> = osc
        .iter()
        .map(|s| s.trim_start_matches("RCC_OSCILLATORTYPE_"))
        .collect();
    for field in &osc_fields {
        match field.as_str() {
            "OscillatorType" => b.line(format!(
                "  RCC_OscInitStruct.OscillatorType = {};",
                osc.join("|")
            )),
            "HSEState" if has_hse => {
                let hse_state =
                    envp(ctx, "HSEState").unwrap_or_else(|| "RCC_HSE_ON".to_string());
                b.line(format!("  RCC_OscInitStruct.HSEState = {hse_state};"));
            }
            "HSEPredivValue" if has_hse && f1 => {
                if let Some(prediv) = envp(ctx, "HSEDivPLL") {
                    b.line(format!("  RCC_OscInitStruct.HSEPredivValue = {prediv};"));
                }
            }
            "LSEState" if has_lse => {
                let lse_state =
                    envp(ctx, "LSEState").unwrap_or_else(|| "RCC_LSE_ON".to_string());
                b.line(format!("  RCC_OscInitStruct.LSEState = {lse_state};"));
            }
            "HSIState" => b.line("  RCC_OscInitStruct.HSIState = RCC_HSI_ON;"),
            "HSICalibrationValue" if hsi_used => {
                if let Some(cal) = envp(ctx, "HSICalibrationValue") {
                    b.line(format!("  RCC_OscInitStruct.HSICalibrationValue = {cal};"));
                }
            }
            "LSIState" if lsi_on => b.line("  RCC_OscInitStruct.LSIState = RCC_LSI_ON;"),
            // The presence-gated members above are the only ones whose value
            // does not come from the db; when their gate is closed the field
            // is absent, not defaulted.
            "HSEState" | "HSEPredivValue" | "LSEState" | "HSICalibrationValue"
            | "LSIState" => {}
            // A member belonging to an oscillator this configuration does not
            // switch on is not part of the request: `OscillatorType` is the
            // mask HAL_RCC_OscConfig acts on, and CubeMX leaves the others
            // out entirely rather than spelling their OFF state.
            _ if osc_of(field).is_some_and(|o| !osc_mask.contains(o)) => {}
            _ => {
                if let Some(ip) = rcc_ip(ctx) {
                    if let Some(v) = rcc_field_value(ctx, ip, &osc_bindings, field) {
                        b.line(format!("  RCC_OscInitStruct.{field} = {v};"));
                    }
                }
            }
        }
    }
    // Name and members of the PLL sub-struct come from the db's own struct
    // shape. A family with no PLL (C0, WB0, WL3) has no such member, and the
    // HAL struct has none either — emitting `PLL.PLLState = RCC_PLL_NONE`
    // for those is a compile error, not a harmless extra line. With no config
    // def at all, keep the historical `PLL` shape.
    let substruct = rcc_config(ctx).map(|cfg| rcc_pll_substruct(cfg, "HAL_RCC_OscConfig"));
    let pll_member = match &substruct {
        Some(None) => None,
        Some(Some((name, _))) => Some(name.clone()),
        None => Some("PLL".to_string()),
    };
    if let Some(member) = pll_member {
        if pll_used {
            let pll_state = envp(ctx, "PLLState").unwrap_or_else(|| "RCC_PLL_ON".to_string());
            b.line(format!("  RCC_OscInitStruct.{member}.PLLState = {pll_state};"));
            b.line(format!("  RCC_OscInitStruct.{member}.PLLSource = {pll_src};"));
            // Remaining PLL members in db document order: F1's single PLLMUL,
            // F4's M/N/P/Q(/R), H5+H7's M/N/P/Q/R plus RGE, VCOSEL and FRACN.
            // A member that does not apply to this part resolves to `null`
            // and is omitted, which is how one shape serves a whole family.
            if let (Some(cfg), Some(ip)) = (rcc_config(ctx), rcc_ip(ctx)) {
                let bindings = rcc_bindings(cfg, "RCC_OSCConfig", "HAL_RCC_OscConfig");
                for field in rcc_struct_fields(cfg, "HAL_RCC_OscConfig", Some(member.as_str())) {
                    if field == "PLLState" || field == "PLLSource" {
                        continue;
                    }
                    if let Some(v) = rcc_field_value(ctx, ip, &bindings, &field) {
                        b.line(format!("  RCC_OscInitStruct.{member}.{field} = {v};"));
                    }
                }
            }
        } else {
            let none = envp(ctx, "PLLStateARG").unwrap_or_else(|| "RCC_PLL_NONE".to_string());
            b.line(format!("  RCC_OscInitStruct.{member}.PLLState = {none};"));
        }
    }
    b.line("  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)");
    b.line("  {");
    b.line("    Error_Handler();");
    b.line("  }");
    b.blank();

    b.line("  /** Initializes the CPU, AHB and APB buses clocks");
    b.line("  */");
    // ClockType is the OR-list of domains HAL_RCC_ClockConfig must program.
    // The db spells it as a concatenation parameter, so an H7 naturally gets
    // its six domains (…|D3PCLK1|D1PCLK1) where an F1/F4 gets four.
    // CubeMX prints two terms per line; keep that.
    let ct = |k: &str, fb: &str| envp(ctx, k).unwrap_or_else(|| fb.to_string());
    // The struct is not universal: WB0 and WL3 drive their clock tree through
    // dedicated fields and have neither `ClockType` nor `SYSCLKSource`.
    let clk_fields: BTreeSet<String> = rcc_config(ctx)
        .map(|cfg| {
            rcc_struct_fields(cfg, "HAL_RCC_ClockConfig", None)
                .into_iter()
                .collect()
        })
        .unwrap_or_default();
    let has = |f: &str| clk_fields.is_empty() || clk_fields.contains(f);
    if has("ClockType") {
        let domains: Vec<String> =
            match rcc_ip(ctx).and_then(|ip| resolve_rcc_value(ctx, ip, "ClockType")) {
                Some(list) => list.split('|').map(|s| s.trim().to_string()).collect(),
                None => vec![
                    ct("ClockTypeHCLK", "RCC_CLOCKTYPE_HCLK"),
                    ct("ClockTypeSysClk", "RCC_CLOCKTYPE_SYSCLK"),
                    ct("ClockTypePCLK1", "RCC_CLOCKTYPE_PCLK1"),
                    ct("ClockTypePCLK2", "RCC_CLOCKTYPE_PCLK2"),
                ],
            };
        for (i, pair) in domains.chunks(2).enumerate() {
            let terms = pair.join("|");
            let last = (i + 1) * 2 >= domains.len();
            let semi = if last { ";" } else { "" };
            if i == 0 {
                b.line(format!("  RCC_ClkInitStruct.ClockType = {terms}{semi}"));
            } else {
                b.line(format!("                              |{terms}{semi}"));
            }
        }
    }
    if !sysclk_src.is_empty() && has("SYSCLKSource") {
        b.line(format!("  RCC_ClkInitStruct.SYSCLKSource = {sysclk_src};"));
    }
    // Bus prescalers, again from the db's struct shape: H7 adds SYSCLKDivider
    // (D1CPRE) plus the APB3/APB4 domains its four-domain bus matrix needs.
    if let (Some(cfg), Some(ip)) = (rcc_config(ctx), rcc_ip(ctx)) {
        let bindings = rcc_bindings(cfg, "RCC_ClockConfig", "HAL_RCC_ClockConfig");
        for field in rcc_struct_fields(cfg, "HAL_RCC_ClockConfig", None) {
            if field == "ClockType" || field == "SYSCLKSource" || !ctx.rcc_knows(&field) {
                continue;
            }
            if let Some(v) = rcc_field_value(ctx, ip, &bindings, &field) {
                b.line(format!("  RCC_ClkInitStruct.{field} = {v};"));
            }
        }
    }
    b.blank();
    // Flash latency is a second argument on every family whose flash needs
    // wait states — but not on N6, which executes from external memory and
    // declares a one-argument `HAL_RCC_ClockConfig`. The db's method
    // signature is what says which.
    let takes_latency = rcc_config(ctx)
        .and_then(|cfg| cfg.lib_methods.get("HAL_RCC_ClockConfig"))
        .map(|lm| lm.arguments.iter().any(|a| a.generic_type != "struct"))
        .unwrap_or(true);
    if takes_latency {
        let flatency = derived
            .get("FLatency")
            .cloned()
            .or_else(|| envp(ctx, "FLatency"))
            .unwrap_or_else(|| "FLASH_LATENCY_0".to_string());
        b.line(format!(
            "  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, {flatency}) != HAL_OK)"
        ));
    } else {
        b.line("  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct) != HAL_OK)");
    }
    b.line("  {");
    b.line("    Error_Handler();");
    b.line("  }");

    // Flash programming delay: a separate RefConfig the db places right after
    // the bus clocks. It is not optional on the families that declare it —
    // FLASH_PROGRAMMING_DELAY encodes the wait states a *write* needs at this
    // voltage and frequency, and the reset value only covers the slowest bin.
    if let (Some(cfg), Some(ip)) = (rcc_config(ctx), rcc_ip(ctx)) {
        if let Some(rc) = cfg.ref_configs.get("RCC_SetProgramDelay") {
            let bindings = rcc_bindings(cfg, "RCC_SetProgramDelay", "__HAL_FLASH_SET_PROGRAM_DELAY");
            let mut lines: Vec<String> = Vec::new();
            for call in &rc.calls {
                let Some(lm) = cfg.lib_methods.get(&call.method) else {
                    continue;
                };
                let args: Vec<String> = lm
                    .arguments
                    .iter()
                    .filter_map(|a| rcc_field_value(ctx, ip, &bindings, &a.name))
                    .collect();
                if args.len() == lm.arguments.len() {
                    lines.push(format!("  {}({});", call.method, args.join(", ")));
                }
            }
            if !lines.is_empty() {
                b.blank();
                b.line("  /** Configure the programming delay");
                b.line("  */");
                for l in lines {
                    b.line(l);
                }
            }
        }
    }

    if let Some(p) = periph {
        b.blank();
        b.line("  /** Initializes the peripherals clock");
        b.line("  */");
        for (i, pair) in p.selection.chunks(2).enumerate() {
            let terms = pair.join("|");
            let last = (i + 1) * 2 >= p.selection.len();
            let semi = if last { ";" } else { "" };
            if i == 0 {
                b.line(format!(
                    "  PeriphClkInit.PeriphClockSelection = {terms}{semi}"
                ));
            } else {
                b.line(format!("                                    |{terms}{semi}"));
            }
        }
        for (field, value) in &p.fields {
            b.line(format!("  PeriphClkInit.{field} = {value};"));
        }
        b.line("  if (HAL_RCCEx_PeriphCLKConfig(&PeriphClkInit) != HAL_OK)");
        b.line("  {");
        b.line("    Error_Handler();");
        b.line("  }");
    }
    b.line("}");
    b.blank();
}

/// What `HAL_RCCEx_PeriphCLKConfig` should program for this configuration.
struct PeriphClk {
    /// The `RCC_PERIPHCLK_*` domains, db order, deduplicated.
    selection: Vec<String>,
    /// `(struct field, value)` in the db's declaration order.
    fields: Vec<(String, String)>,
}

fn periph_clk_block(ctx: &GenCtx<'_>) -> Option<PeriphClk> {
    const METHOD: &str = "HAL_RCCEx_PeriphCLKConfig";
    let (cfg, ip) = (rcc_config(ctx)?, rcc_ip(ctx)?);
    let (_, bindings) = rcc_call_site(cfg, METHOD)?;
    let selection_param = bindings.get("PeriphClockSelection")?;
    let selection = resolve_rcc_accumulated(ctx, ip, selection_param);
    if selection.is_empty() {
        return None;
    }
    let fields: Vec<(String, String)> = rcc_struct_fields(cfg, METHOD, None)
        .into_iter()
        .filter(|f| f != "PeriphClockSelection" && ctx.rcc_knows(f))
        .filter_map(|f| periph_field_value(ctx, ip, &bindings, &f).map(|v| (f, v)))
        .collect();
    Some(PeriphClk { selection, fields })
}

// ---------------------------------------------------------------------------
// gpio.h / gpio.c
// ---------------------------------------------------------------------------

fn gpio_h(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(ctx, "gpio.h", "This file contains all the function prototypes for the gpio.c file"));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line("#ifndef __GPIO_H__");
    b.line("#define __GPIO_H__");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.user0("Private defines");
    b.blank();
    b.line("void MX_GPIO_Init(void);");
    b.blank();
    b.user0("Prototypes");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.line("#endif /*__ GPIO_H__ */");
    b.into_string()
}

/// Base pads whose user gpio entry is stacked under a placed functional
/// signal (sharedWith hit): the functional signal's MspInit owns the single
/// GPIO config, so gpio.c emits nothing for these pads.
fn stacked_pads(ctx: &GenCtx<'_>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for pl in &ctx.resolved.pin_plan.placements {
        let base = base_pad(&pl.pin);
        if let Some(g) = ctx.doc.gpio.get(base) {
            if g.shared_with.contains(&pl.signal) {
                out.insert(base.to_string());
            }
        }
    }
    out
}

fn gpio_c(ctx: &GenCtx<'_>) -> String {
    let f1 = is_f1(ctx);
    let stacked = stacked_pads(ctx);
    let pins: Vec<UserPin> = user_pins(ctx)
        .into_iter()
        .filter(|p| !stacked.contains(&p.pin.base))
        .collect();
    let mut b = Buf::new();
    b.line(header(ctx, "gpio.c", "This file provides code for the configuration of all used GPIO pins."));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"gpio.h\"");
    b.blank();
    b.user0("0");
    b.blank();
    b.line("/*----------------------------------------------------------------------------*/");
    b.line("/* Configure GPIO                                                             */");
    b.line("/*----------------------------------------------------------------------------*/");
    b.user0("1");
    b.blank();
    b.line("/** Configure pins");
    b.line("*/");
    b.line("void MX_GPIO_Init(void)");
    b.line("{");
    if !pins.is_empty() {
        b.line("  GPIO_InitTypeDef GPIO_InitStruct = {0};");
        b.blank();
    }
    // Port clock enables, sorted by port letter.
    let ports: BTreeSet<char> = pins.iter().map(|p| p.pin.port_letter).collect();
    if !ports.is_empty() {
        b.line("  /* GPIO Ports Clock Enable */");
        for port in &ports {
            b.line(format!("  {}();", port_clock_enable(ctx, *port)));
        }
        b.blank();
    }
    // Initial output levels, before init (CubeMX order).
    for up in pins.iter().filter(|p| p.is_output()) {
        b.line("  /*Configure GPIO pin Output Level */");
        b.line(format!(
            "  HAL_GPIO_WritePin({}, {}, {});",
            up.port_token(),
            up.pin_token(),
            if up.cfg.init_high {
                "GPIO_PIN_SET"
            } else {
                "GPIO_PIN_RESET"
            }
        ));
        b.blank();
    }
    for up in &pins {
        b.line(format!(
            "  /*Configure GPIO pin : {} */",
            up.label
                .clone()
                .map(|l| format!("{l}_Pin"))
                .unwrap_or_else(|| up.pin.base.clone())
        ));
        b.line(format!("  GPIO_InitStruct.Pin = {};", up.pin_token()));
        b.line(format!("  GPIO_InitStruct.Mode = {};", up.mode_macro()));
        use stm32ck_engine::config::GpioMode;
        match up.cfg.mode {
            GpioMode::Analog => {}
            GpioMode::Input | GpioMode::Exti => {
                b.line(format!("  GPIO_InitStruct.Pull = {};", up.pull_macro()));
            }
            GpioMode::Output => {
                b.line(format!("  GPIO_InitStruct.Pull = {};", up.pull_macro()));
                b.line(format!("  GPIO_InitStruct.Speed = {};", up.speed_macro(f1)));
            }
        }
        b.line(format!(
            "  HAL_GPIO_Init({}, &GPIO_InitStruct);",
            up.port_token()
        ));
        b.blank();
    }
    // NVIC enables for the resolved EXTI vectors (CubeMX convention: at the
    // end of MX_GPIO_Init, after the pin inits).
    let exti_irqs: Vec<_> = ctx
        .resolved
        .nvic
        .iter()
        .filter(|i| is_exti_irq(i))
        .collect();
    if !exti_irqs.is_empty() {
        b.line("  /* EXTI interrupt init*/");
        for irq in &exti_irqs {
            b.line(format!(
                "  HAL_NVIC_SetPriority({}, {}, {});",
                irq.irqn, irq.preemption_priority, irq.sub_priority
            ));
            b.line(format!("  HAL_NVIC_EnableIRQ({});", irq.irqn));
        }
        b.blank();
    }
    b.line("}");
    b.blank();
    b.user0("2");
    b.into_string()
}

// ---------------------------------------------------------------------------
// <fam>_hal_msp.c
// ---------------------------------------------------------------------------

fn msp_c(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{}_hal_msp.c", fam_lower(ctx)),
        "This file provides code for the MSP Initialization and de-Initialization codes.",
    ));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.user0("TD");
    b.blank();
    b.user0("Define");
    b.blank();
    b.user0("Macro");
    b.blank();
    b.user0("PV");
    b.blank();
    b.user0("PFP");
    b.blank();
    b.user0("ExternalFunctions");
    b.blank();
    b.user0("0");
    b.blank();

    // ---- HAL_MspInit (the file's only function since the split) -----------
    b.line("/**");
    b.line("  * Initializes the Global MSP.");
    b.line("  */");
    b.line("void HAL_MspInit(void)");
    b.line("{");
    b.blank();
    b.user("MspInit 0");
    b.blank();
    // SYS-instance clock enables (F1: AFIO+PWR, F4: SYSCFG+PWR) from the IR.
    let sys_enables: Vec<String> = ctx
        .resolved
        .part
        .ip_instances
        .iter()
        .find(|i| i.instance == "SYS")
        .map(|i| i.clock_enable.clone())
        .unwrap_or_default();
    for mac in &sys_enables {
        b.line(format!("  {mac}();"));
    }
    b.blank();
    b.line("  /* System interrupt init*/");
    // Cortex system-handler priorities (doc nvic.systemHandlers, spec §2.5):
    // SVCall and SysTick never get a SetPriority call (CubeMX quirk).
    for (name, nv) in &ctx.doc.nvic.system_handlers {
        if !nv.enabled || name == "SVCall" || name == "SysTick" {
            continue;
        }
        b.line(format!("  /* {name}_IRQn interrupt configuration */"));
        b.line(format!(
            "  HAL_NVIC_SetPriority({name}_IRQn, {}, {});",
            nv.preemption_priority, nv.sub_priority
        ));
    }
    b.blank();
    b.user("MspInit 1");
    b.blank();
    b.line("}");
    b.blank();
    b.user0("1");
    b.into_string()
}

// ---------------------------------------------------------------------------
// Per-peripheral family files (<stem>.c / <stem>.h) — spec §1
// ---------------------------------------------------------------------------

/// `Core/Inc/<stem>.h` per the spec §1.2 skeleton.
fn periph_h(ctx: &GenCtx<'_>, stem: &str, members: &[&PeriphGen<'_>]) -> String {
    let up = stem.to_ascii_uppercase();
    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{stem}.h"),
        &format!("This file contains all the function prototypes for the {stem}.c file"),
    ));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line(format!("#ifndef __{up}_H__"));
    b.line(format!("#define __{up}_H__"));
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    b.blank();
    b.user0("Includes");
    b.blank();
    // One extern per IP handle, blank line BETWEEN externs (spec §1.2).
    // DMA handles are NOT externed here — it.c re-declares them locally.
    let mut first = true;
    for pg in members {
        if let Some(h) = &pg.handle {
            if !first {
                b.blank();
            }
            b.line(format!("extern {} {};", h.c_type, h.name));
            first = false;
        }
    }
    if !first {
        b.blank();
    }
    b.user0("Private defines");
    b.blank();
    for pg in members {
        b.line(format!("void {}(void);", pg.mx_name));
    }
    b.blank();
    // HAL_TIM_MspPostInit prototype lives in tim.h ONLY (spec §1.2).
    let mut post_protos: BTreeSet<(String, String)> = BTreeSet::new();
    for pg in members {
        if pg.post_pins.is_empty() {
            continue;
        }
        if let (Some(cb), Some(h)) = (&pg.msp_post_init, &pg.handle) {
            post_protos.insert((cb.clone(), h.c_type.clone()));
        }
    }
    for (cb, ty) in &post_protos {
        b.line(format!("void {cb}({ty} *htim);"));
        b.blank();
    }
    b.user0("Prototypes");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line(format!("#endif /* __{up}_H__ */"));
    b.into_string()
}

/// `Core/Src/<stem>.c` per the spec §1.1 skeleton: handles (IP + owned
/// DMA), MX inits, MspInit/MspDeInit groups, (TIM) HAL_TIM_MspPostInit.
fn periph_c(ctx: &GenCtx<'_>, stem: &str, members: &[&PeriphGen<'_>]) -> String {
    let up = stem.to_ascii_uppercase();
    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{stem}.c"),
        &format!("This file provides code for the configuration of the {up} instances."),
    ));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line(format!("#include \"{stem}.h\""));
    b.blank();
    b.user0("0");
    b.blank();
    // Handles: one per instance, owned DMA handles right after their owner
    // (spec §1 DMA-handle ownership), no blank lines between.
    let mut any_handle = false;
    for pg in members {
        if let Some(h) = &pg.handle {
            b.line(format!("{} {};", h.c_type, h.name));
            any_handle = true;
        }
        for d in dma_of(ctx, &pg.p.instance) {
            b.line(format!("DMA_HandleTypeDef {};", d.handle_name));
            any_handle = true;
        }
    }
    if any_handle {
        b.blank();
    }
    for pg in members {
        mx_init_fn(pg, &mut b);
    }
    emit_msp_init_groups(ctx, members, &mut b);
    emit_msp_deinit_groups(ctx, members, &mut b);
    emit_msp_post_groups(ctx, members, &mut b);
    b.user0("1");
    b.into_string()
}

/// Pin fills grouped by (port, electrical settings): one GPIO_InitStruct
/// fill + HAL_GPIO_Init per group, pins joined with `|` in bit order.
/// Labeled (stacked) pads use their `<label>_Pin` macro; the port argument
/// uses `<label>_GPIO_Port` only for single-pin labeled fills.
fn emit_pin_fills(pins: &[PlacedPin], b: &mut Buf) {
    let mut fills: BTreeMap<(String, IoSettings), Vec<(u32, String, Option<String>)>> =
        BTreeMap::new();
    for pp in pins {
        fills
            .entry((pp.pin.port_macro.clone(), pp.settings.clone()))
            .or_default()
            .push((pp.pin.bit, pp.pin_token(), pp.label.clone()));
    }
    for ((port, st), group) in &mut fills {
        group.sort();
        let joined = group
            .iter()
            .map(|(_, t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join("|");
        b.line(format!("    GPIO_InitStruct.Pin = {joined};"));
        if let Some(m) = &st.mode {
            b.line(format!("    GPIO_InitStruct.Mode = {m};"));
        }
        if let Some(p) = &st.pull {
            b.line(format!("    GPIO_InitStruct.Pull = {p};"));
        }
        if let Some(s) = &st.speed {
            b.line(format!("    GPIO_InitStruct.Speed = {s};"));
        }
        if let Some(a) = &st.alternate {
            b.line(format!("    GPIO_InitStruct.Alternate = {a};"));
        }
        let port_arg = match group.as_slice() {
            [(_, _, Some(label))] => format!("{label}_GPIO_Port"),
            _ => port.clone(),
        };
        b.line(format!("    HAL_GPIO_Init({port_arg}, &GPIO_InitStruct);"));
        b.blank();
    }
}

/// The HAL_<IP>_MspInit function(s) for `members`, grouped by callback name
/// (HAL_TIM_Base_MspInit vs HAL_TIM_PWM_MspInit stay separate functions).
fn emit_msp_init_groups(ctx: &GenCtx<'_>, members: &[&PeriphGen<'_>], b: &mut Buf) {
    let f1 = is_f1(ctx);
    let mut groups: BTreeMap<String, Vec<&PeriphGen<'_>>> = BTreeMap::new();
    for pg in members {
        if let (Some(name), Some(_)) = (&pg.msp_init, &pg.handle) {
            groups.entry(name.clone()).or_default().push(pg);
        }
    }
    for (fn_name, members) in &groups {
        let first = members[0];
        let h_type = first
            .handle
            .as_ref()
            .map(|h| h.c_type.clone())
            .unwrap_or_else(|| "void".to_string());
        let param = first.msp_param();
        let any_pins = members.iter().any(|m| !m.pins.is_empty());

        b.line(format!("void {fn_name}({h_type}* {param})"));
        b.line("{");
        if any_pins {
            b.line("  GPIO_InitTypeDef GPIO_InitStruct = {0};");
        }
        for pg in members {
            let inst = &pg.base_address;
            b.line(format!("  if({param}->Instance=={inst})"));
            b.line("  {");
            b.user(&format!("{inst}_MspInit 0"));
            b.line(format!("    /* {inst} clock enable */"));
            for mac in &pg.clock_enable {
                b.line(format!("    {mac}();"));
            }
            b.blank();
            if !pg.pins.is_empty() {
                let ports: BTreeSet<char> =
                    pg.pins.iter().map(|p| p.pin.port_letter).collect();
                for port in &ports {
                    b.line(format!("    {}();", port_clock_enable(ctx, *port)));
                }
                b.line(format!("    /**{inst} GPIO Configuration"));
                for pp in &pg.pins {
                    b.line(format!("    {}     ------> {}", pp.pin.base, pp.signal));
                }
                b.line("    */");
                emit_pin_fills(&pg.pins, b);
            }
            if f1 && !pg.remap_macros.is_empty() {
                b.line("    __HAL_RCC_AFIO_CLK_ENABLE();");
                for mac in &pg.remap_macros {
                    b.line(format!("    {mac}();"));
                }
                b.blank();
            }
            // DMA handle fill + LINKDMA (reference order: clocks, GPIO,
            // DMA, then the peripheral's own interrupt init).
            msp_dma_init(ctx, inst, &param, b);
            let irqs: Vec<_> = ctx
                .resolved
                .nvic
                .iter()
                .filter(|i| i.owner == *inst)
                .collect();
            if !irqs.is_empty() {
                b.line(format!("    /* {inst} interrupt Init */"));
                for irq in &irqs {
                    b.line(format!(
                        "    HAL_NVIC_SetPriority({}, {}, {});",
                        irq.irqn, irq.preemption_priority, irq.sub_priority
                    ));
                    b.line(format!("    HAL_NVIC_EnableIRQ({});", irq.irqn));
                }
            }
            b.user(&format!("{inst}_MspInit 1"));
            b.line("  }");
        }
        b.line("}");
        b.blank();
    }
}

/// HAL_TIM_MspPostInit — AF output pins configured post-init (spec §1.4);
/// emitted at the end of the owning family file (tim.c).
fn emit_msp_post_groups(ctx: &GenCtx<'_>, members: &[&PeriphGen<'_>], b: &mut Buf) {
    let mut post_groups: BTreeMap<String, Vec<&PeriphGen<'_>>> = BTreeMap::new();
    for pg in members {
        if pg.post_pins.is_empty() {
            continue;
        }
        if let (Some(name), Some(_)) = (&pg.msp_post_init, &pg.handle) {
            post_groups.entry(name.clone()).or_default().push(pg);
        }
    }
    for (fn_name, members) in &post_groups {
        let first = members[0];
        let h_type = first
            .handle
            .as_ref()
            .map(|h| h.c_type.clone())
            .unwrap_or_else(|| "void".to_string());
        let param = fn_name
            .strip_prefix("HAL_")
            .and_then(|s| s.strip_suffix("_MspPostInit"))
            .map(|s| format!("{}Handle", s.to_ascii_lowercase()))
            .unwrap_or_else(|| "handle".to_string());
        b.line(format!("void {fn_name}({h_type}* {param})"));
        b.line("{");
        b.line("  GPIO_InitTypeDef GPIO_InitStruct = {0};");
        for pg in members {
            let inst = &pg.base_address;
            b.line(format!("  if({param}->Instance=={inst})"));
            b.line("  {");
            b.user(&format!("{inst}_MspPostInit 0"));
            let ports: BTreeSet<char> =
                pg.post_pins.iter().map(|p| p.pin.port_letter).collect();
            for port in &ports {
                b.line(format!("    {}();", port_clock_enable(ctx, *port)));
            }
            b.line(format!("    /**{inst} GPIO Configuration"));
            for pp in &pg.post_pins {
                b.line(format!("    {}     ------> {}", pp.pin.base, pp.signal));
            }
            b.line("    */");
            emit_pin_fills(&pg.post_pins, b);
            b.user(&format!("{inst}_MspPostInit 1"));
            b.line("  }");
        }
        b.line("}");
        b.blank();
    }
}

/// The HAL_<IP>_MspDeInit function(s) for `members`.
fn emit_msp_deinit_groups(ctx: &GenCtx<'_>, members: &[&PeriphGen<'_>], b: &mut Buf) {
    let mut degroups: BTreeMap<String, Vec<&PeriphGen<'_>>> = BTreeMap::new();
    for pg in members {
        if let (Some(name), Some(_)) = (&pg.msp_deinit, &pg.handle) {
            degroups.entry(name.clone()).or_default().push(pg);
        }
    }
    for (fn_name, members) in &degroups {
        let first = members[0];
        let h_type = first
            .handle
            .as_ref()
            .map(|h| h.c_type.clone())
            .unwrap_or_else(|| "void".to_string());
        let param = first.msp_param();
        b.line(format!("void {fn_name}({h_type}* {param})"));
        b.line("{");
        for pg in members {
            let inst = &pg.base_address;
            b.line(format!("  if({param}->Instance=={inst})"));
            b.line("  {");
            b.user(&format!("{inst}_MspDeInit 0"));
            b.line("    /* Peripheral clock disable */");
            for mac in &pg.clock_enable {
                b.line(format!("    {}();", disable_macro(mac)));
            }
            if !pg.pins.is_empty() {
                b.blank();
                let mut by_port: BTreeMap<String, Vec<(u32, String)>> = BTreeMap::new();
                for pp in &pg.pins {
                    by_port
                        .entry(pp.pin.port_macro.clone())
                        .or_default()
                        .push((pp.pin.bit, pp.pin_token()));
                }
                b.line(format!("    /**{inst} GPIO Configuration"));
                for pp in &pg.pins {
                    b.line(format!("    {}     ------> {}", pp.pin.base, pp.signal));
                }
                b.line("    */");
                for (port, pins) in &mut by_port {
                    pins.sort();
                    let joined = pins
                        .iter()
                        .map(|(_, m)| m.as_str())
                        .collect::<Vec<_>>()
                        .join("|");
                    b.line(format!("    HAL_GPIO_DeInit({port}, {joined});"));
                }
            }
            let dmas = dma_of(ctx, inst);
            if !dmas.is_empty() {
                b.blank();
                b.line(format!("    /* {inst} DMA DeInit */"));
                for d in &dmas {
                    b.line(format!("    HAL_DMA_DeInit({param}->{});", d.link_field));
                }
            }
            let irqs: Vec<_> = ctx
                .resolved
                .nvic
                .iter()
                .filter(|i| i.owner == *inst)
                .collect();
            if !irqs.is_empty() {
                b.blank();
                b.line(format!("    /* {inst} interrupt Deinit */"));
                for irq in &irqs {
                    b.line(format!("    HAL_NVIC_DisableIRQ({});", irq.irqn));
                }
            }
            b.user(&format!("{inst}_MspDeInit 1"));
            b.line("  }");
        }
        b.line("}");
        b.blank();
    }
}

/// `__HAL_RCC_USART1_CLK_ENABLE` -> `__HAL_RCC_USART1_CLK_DISABLE`.
fn disable_macro(enable: &str) -> String {
    if enable.contains("_CLK_ENABLE") {
        enable.replace("_CLK_ENABLE", "_CLK_DISABLE")
    } else {
        enable.replace("_ENABLE", "_DISABLE")
    }
}

// ---------------------------------------------------------------------------
// <fam>_it.h / <fam>_it.c
// ---------------------------------------------------------------------------

const CORTEX_HANDLERS: [(&str, &str); 9] = [
    ("NMI_Handler", "Non maskable interrupt."),
    ("HardFault_Handler", "Hard fault interrupt."),
    ("MemManage_Handler", "Memory management fault."),
    ("BusFault_Handler", "Pre-fetch fault, memory access fault."),
    ("UsageFault_Handler", "Undefined instruction or illegal state."),
    ("SVC_Handler", "System service call via SWI instruction."),
    ("DebugMon_Handler", "Debug monitor."),
    ("PendSV_Handler", "Pendable request for system service."),
    ("SysTick_Handler", "System tick timer."),
];

/// resolved.nvic deduplicated by IRQ name (document order preserved).
fn irq_list<'a>(ctx: &'a GenCtx<'_>) -> Vec<&'a stm32ck_engine::session::ResolvedIrq> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    ctx.resolved
        .nvic
        .iter()
        .filter(|i| seen.insert(i.irqn.as_str()))
        .collect()
}

fn it_h(ctx: &GenCtx<'_>, _periphs: &[PeriphGen<'_>]) -> String {
    let fam_up = ctx.device_prefix().to_ascii_uppercase();
    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{}_it.h", fam_lower(ctx)),
        "This file contains the headers of the interrupt handlers.",
    ));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line(format!("#ifndef __{fam_up}_IT_H"));
    b.line(format!("#define __{fam_up}_IT_H"));
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.user0("ET");
    b.blank();
    b.user0("EC");
    b.blank();
    b.user0("EM");
    b.blank();
    b.user0("EFP");
    b.blank();
    b.line("/* Exported functions prototypes ---------------------------------------------*/");
    // Middleware-owned system handlers disappear entirely (FreeRTOS port
    // aliases SVC/PendSV[/SysTick] — middleware seam, spec §2.4).
    let suppressed = crate::middleware::suppressed_it_handlers(ctx);
    for (name, _) in CORTEX_HANDLERS {
        if suppressed.contains(name) {
            continue;
        }
        b.line(format!("void {name}(void);"));
    }
    for d in dma_by_stream(ctx) {
        if d.nvic.enabled && d.generate_handler {
            b.line(format!("void {}_IRQHandler(void);", d.stream));
        }
    }
    // Timebase shared-vector handler when no enabled vector already emits it.
    if let Some(tb) = &ctx.resolved.timebase {
        if !ctx
            .resolved
            .nvic
            .iter()
            .any(|i| i.irqn == tb.irqn && i.generate_handler)
        {
            b.line(format!("void {}Handler(void);", irq_stem(&tb.irqn)));
        }
    }
    for irq in irq_list(ctx) {
        if !irq.generate_handler {
            continue;
        }
        b.line(format!("void {}Handler(void);", irq_stem(&irq.irqn)));
    }
    for h in crate::middleware::it_hooks(ctx) {
        b.line(format!("void {}Handler(void);", irq_stem(&h.irqn)));
    }
    b.user0("Prototypes");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line(format!("#endif /* __{fam_up}_IT_H */"));
    b.into_string()
}

/// "USART1_IRQn" -> "USART1_IRQ" (handler stem).
fn irq_stem(irqn: &str) -> String {
    format!("{}_IRQ", irqn.trim_end_matches("_IRQn"))
}

/// The HAL IRQ dispatch function for a peripheral: the db's own
/// `HAL_<module>_IRQHandler` LibMethod when the config file has one
/// (`HAL_TIM_IRQHandler` — NOT the per-hal-mode `HAL_TIM_Base_IRQHandler`,
/// which does not exist), else any `HAL_*_IRQHandler` it defines, else the
/// hal-mode construction.
fn irq_handler_fn(ctx: &GenCtx<'_>, pg: &PeriphGen<'_>) -> Option<String> {
    if let Some(cfg) = ctx.config_for(pg.p) {
        if let Some(m) = crate::hal_module(pg.p) {
            let want = format!("HAL_{m}_IRQHandler");
            if cfg.lib_methods.contains_key(&want) {
                return Some(want);
            }
        }
        if let Some(k) = cfg
            .lib_methods
            .keys()
            .find(|k| k.starts_with("HAL_") && k.ends_with("_IRQHandler"))
        {
            return Some(k.clone());
        }
    }
    pg.p.hal_mode.as_ref().map(|hm| format!("HAL_{hm}_IRQHandler"))
}

fn it_c(ctx: &GenCtx<'_>, periphs: &[PeriphGen<'_>]) -> String {
    let fam = fam_lower(ctx);
    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{fam}_it.c"),
        "Interrupt Service Routines.",
    ));
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"main.h\"");
    b.line(format!("#include \"{fam}_it.h\""));
    b.blank();
    b.line("/* Private includes ----------------------------------------------------------*/");
    b.user0("Includes");
    b.blank();
    b.line("/* Private typedef -----------------------------------------------------------*/");
    b.user0("TD");
    b.blank();
    b.line("/* Private define ------------------------------------------------------------*/");
    b.user0("PD");
    b.blank();
    b.line("/* Private macro -------------------------------------------------------------*/");
    b.user0("PM");
    b.blank();
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.user0("PV");
    b.blank();
    b.line("/* Private function prototypes -----------------------------------------------*/");
    b.user0("PFP");
    b.blank();
    b.line("/* Private user code ---------------------------------------------------------*/");
    b.user0("0");
    b.blank();

    // extern handles used by HAL_*_IRQHandler bodies (generated ones only).
    let irqs: Vec<_> = irq_list(ctx)
        .into_iter()
        .filter(|i| i.generate_handler)
        .collect();
    let dma_handlers: Vec<&ResolvedDma> = dma_by_stream(ctx)
        .into_iter()
        .filter(|d| d.nvic.enabled && d.generate_handler)
        .collect();
    let mw_handlers = crate::middleware::it_hooks(ctx);
    b.line("/* External variables --------------------------------------------------------*/");
    let mut externs: BTreeSet<String> = BTreeSet::new();
    for h in &mw_handlers {
        for e in &h.externs {
            if externs.insert(e.clone()) {
                b.line(format!("extern {e};"));
            }
        }
    }
    for d in &dma_handlers {
        if externs.insert(d.handle_name.clone()) {
            b.line(format!("extern DMA_HandleTypeDef {};", d.handle_name));
        }
    }
    for irq in &irqs {
        // Instances whose handles the handler body dereferences: the owner
        // (template-less and args-less templates) plus every configured
        // owner of a class-shorthand record ("ADC" + "ADC1,ADC2,ADC3").
        let mut insts: Vec<&str> = vec![irq.owner.as_str()];
        for a in irq.args.split(',') {
            let a = a.trim();
            if !a.is_empty() {
                insts.push(a);
            }
        }
        for inst in insts {
            if let Some(pg) = periphs.iter().find(|pg| pg.p.instance == inst) {
                if let Some(h) = &pg.handle {
                    if externs.insert(h.name.clone()) {
                        b.line(format!("extern {} {};", h.c_type, h.name));
                    }
                }
            }
        }
    }
    // The timebase handle is DEFINED in <fam>_hal_timebase_tim.c and only
    // externed here for the shared-vector dispatch (spec §3.3).
    let timebase = ctx.resolved.timebase.as_ref();
    if let Some(tb) = timebase {
        let hname = format!("htim{}", digits(&tb.tim));
        if externs.insert(hname.clone()) {
            b.line(format!("extern TIM_HandleTypeDef {hname};"));
        }
    }
    b.blank();
    b.user0("EV");
    b.blank();

    b.line("/******************************************************************************/");
    b.line("/*           Cortex Processor Interruption and Exception Handlers            */");
    b.line("/******************************************************************************/");
    // Middleware-owned system handlers are deleted from it.c (FreeRTOS port
    // provides SVC/PendSV[/SysTick] via its CMSIS-name aliases, spec §2.4).
    let suppressed = crate::middleware::suppressed_it_handlers(ctx);
    for (name, brief) in CORTEX_HANDLERS {
        if suppressed.contains(name) {
            continue;
        }
        let tag = format!("{}_IRQn", name.trim_end_matches("_Handler"));
        b.line("/**");
        b.line(format!("  * @brief This function handles {brief}"));
        b.line("  */");
        b.line(format!("void {name}(void)"));
        b.line("{");
        b.user(&format!("{tag} 0"));
        match name {
            // With a TIM timebase the tick comes from the timer; SysTick
            // stays a stub (spec §3.4 — no HAL_IncTick here).
            "SysTick_Handler" if timebase.is_none() => b.line("  HAL_IncTick();"),
            "SysTick_Handler" => {}
            "NMI_Handler" | "HardFault_Handler" | "MemManage_Handler" | "BusFault_Handler"
            | "UsageFault_Handler" => {
                b.line("  while (1)");
                b.line("  {");
                b.line(format!("    /* USER CODE BEGIN W1_{tag} 0 */"));
                b.line(format!("    /* USER CODE END W1_{tag} 0 */"));
                b.line("  }");
            }
            _ => {}
        }
        b.user(&format!("{tag} 1"));
        b.line("}");
        b.blank();
    }

    if !irqs.is_empty() || !dma_handlers.is_empty() || timebase.is_some() || !mw_handlers.is_empty()
    {
        b.line("/******************************************************************************/");
        b.line(format!(
            "/* {}xx Peripheral Interrupt Handlers                                    */",
            ctx.family().trim_start_matches("STM32")
        ));
        b.line("/* Add here the Interrupt Handlers for the used peripherals.                  */");
        b.line("/* For the available peripheral interrupt handler names,                      */");
        b.line(format!(
            "/* please refer to the startup file (startup_{}xx.s).                    */",
            ctx.family().to_ascii_lowercase()
        ));
        b.line("/******************************************************************************/");
    }
    // DMA stream/channel handlers first (reference it.c order); a request
    // whose `generateHandler` is false gets NVIC rows in MX_DMA_Init but no
    // handler here (ODrive DMA2_Stream0).
    for d in &dma_handlers {
        b.line("/**");
        b.line(format!(
            "  * @brief This function handles {} global interrupt.",
            dma_stream_brief(&d.stream)
        ));
        b.line("  */");
        b.line(format!("void {}_IRQHandler(void)", d.stream));
        b.line("{");
        b.user(&format!("{} 0", d.irqn));
        b.line(format!("  HAL_DMA_IRQHandler(&{});", d.handle_name));
        b.user(&format!("{} 1", d.irqn));
        b.line("}");
        b.blank();
    }
    for irq in &irqs {
        let stem = irq_stem(&irq.irqn);
        b.line("/**");
        b.line(format!(
            "  * @brief This function handles {} global interrupt.",
            irq.irqn.trim_end_matches("_IRQn")
        ));
        b.line("  */");
        b.line(format!("void {stem}Handler(void)"));
        b.line("{");
        b.user(&format!("{} 0", irq.irqn));
        if is_exti_irq(irq) {
            // One HAL dispatch per configured EXTI pin on this vector, in
            // pad order (user_pins iterates doc.gpio, a BTreeMap).
            for up in user_pins(ctx)
                .iter()
                .filter(|u| u.is_exti() && exti_irqn(u.pin.bit) == irq.irqn)
            {
                b.line(format!("  HAL_GPIO_EXTI_IRQHandler({});", up.pin_token()));
            }
        } else if !irq.handlers.is_empty() {
            let args: Vec<&str> = irq
                .args
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            for (i, h) in irq.handlers.iter().enumerate() {
                if !h.starts_with("HAL_") {
                    // Owner-class shorthand ("ADC" with args "ADC1,ADC2,
                    // ADC3"): one HAL dispatch per CONFIGURED owner.
                    let Some(inst) = args.get(i) else { continue };
                    if let Some(hd) = periphs
                        .iter()
                        .find(|pg| pg.p.instance == *inst)
                        .and_then(|pg| pg.handle.as_ref())
                    {
                        b.line(format!("  HAL_{h}_IRQHandler(&{});", hd.name));
                    }
                } else if args.is_empty() {
                    // Template without args dispatches on the owner handle
                    // (HAL_TIM_IRQHandler(&htim1)).
                    if let Some(hd) = periphs
                        .iter()
                        .find(|pg| pg.p.instance == irq.owner)
                        .and_then(|pg| pg.handle.as_ref())
                    {
                        b.line(format!("  {h}(&{});", hd.name));
                    }
                } else {
                    b.line(format!("  {h}({});", irq.args));
                }
            }
        } else if let Some(pg) = periphs.iter().find(|pg| pg.p.instance == irq.owner) {
            if let (Some(f), Some(h)) = (irq_handler_fn(ctx, pg), &pg.handle) {
                b.line(format!("  {f}(&{});", h.name));
            }
        }
        // Shared timebase vector: dispatch the timebase handle LAST
        // (reference: htim8 then htim14 — spec §3.3).
        if let Some(tb) = timebase {
            if irq.irqn == tb.irqn {
                b.line(format!("  HAL_TIM_IRQHandler(&htim{});", digits(&tb.tim)));
            }
        }
        b.user(&format!("{} 1", irq.irqn));
        b.line("}");
        b.blank();
    }
    // Timebase vector not covered by any generated handler above: emit the
    // standalone handler dispatching only the timebase handle.
    if let Some(tb) = timebase {
        if !irqs.iter().any(|i| i.irqn == tb.irqn) {
            let stem = irq_stem(&tb.irqn);
            b.line("/**");
            b.line(format!(
                "  * @brief This function handles {} global interrupt.",
                tb.irqn.trim_end_matches("_IRQn")
            ));
            b.line("  */");
            b.line(format!("void {stem}Handler(void)"));
            b.line("{");
            b.user(&format!("{} 0", tb.irqn));
            b.line(format!("  HAL_TIM_IRQHandler(&htim{});", digits(&tb.tim)));
            b.user(&format!("{} 1", tb.irqn));
            b.line("}");
            b.blank();
        }
    }
    // Middleware handlers (P6's OTG_FS_IRQHandler slot).
    for h in &mw_handlers {
        let stem = irq_stem(&h.irqn);
        b.line("/**");
        b.line(format!("  * @brief This function handles {}", h.brief));
        b.line("  */");
        b.line(format!("void {stem}Handler(void)"));
        b.line("{");
        b.user(&format!("{} 0", h.irqn));
        for line in &h.body {
            b.line(format!("  {line}"));
        }
        b.user(&format!("{} 1", h.irqn));
        b.line("}");
        b.blank();
    }
    b.user0("1");
    b.into_string()
}

// ---------------------------------------------------------------------------
// <fam>_hal_conf.h
// ---------------------------------------------------------------------------

/// hal_conf include order: handle-typedef dependencies require DMA (and the
/// other infrastructure headers) BEFORE the peripheral modules — e.g.
/// `SPI_HandleTypeDef.hdmarx` needs DMA_HandleTypeDef complete. Mirrors the
/// CubeMX conf-template ordering; modules not listed sort alphabetically
/// after the head.
const HAL_CONF_INCLUDE_HEAD: [&str; 5] = ["RCC", "GPIO", "EXTI", "DMA", "CORTEX"];

fn hal_conf_include_order(modules: &BTreeSet<String>) -> Vec<&String> {
    let mut ordered: Vec<&String> = Vec::new();
    for head in HAL_CONF_INCLUDE_HEAD {
        if let Some(m) = modules.get(head) {
            ordered.push(m);
        }
    }
    for m in modules {
        if !HAL_CONF_INCLUDE_HEAD.contains(&m.as_str()) {
            ordered.push(m);
        }
    }
    ordered
}

fn hal_conf_h(ctx: &GenCtx<'_>, periphs: &[PeriphGen<'_>]) -> String {
    let f1 = is_f1(ctx);
    let fam = fam_lower(ctx); // stm32f1xx
    let fam_up = fam.to_ascii_uppercase(); // STM32F1XX

    // Always-on infrastructure modules + one per used peripheral, derived by
    // the SAME function that picks the HAL sources for copy/CMake.
    let mut modules: BTreeSet<String> = ["CORTEX", "DMA", "EXTI", "FLASH", "GPIO", "PWR", "RCC"]
        .into_iter()
        .map(String::from)
        .collect();
    let mut used: BTreeSet<String> = BTreeSet::new();
    for pg in periphs {
        if let Some(m) = crate::hal_module(pg.p) {
            modules.insert(m.clone());
            used.insert(m);
        }
    }
    // The TIM timebase needs HAL_TIM even with no user TIM (spec §3.4).
    if ctx.resolved.timebase.is_some() {
        modules.insert("TIM".to_string());
    }
    // Not every family has every "always-on" module: N6 boots from external
    // flash and ships no `hal_flash`, so enabling it would #include a header
    // that is not there. Drop what the tree does not have.
    if let Some(have) = ctx.fw.as_ref().map(|f| &f.hal_modules) {
        modules.retain(|m| have.contains(m));
        used.retain(|m| have.contains(m));
    }

    let hse = ctx
        .doc
        .clock
        .sources
        .get("HSE")
        .map(|s| s.freq_hz)
        .unwrap_or(if f1 { 8_000_000 } else { 25_000_000 });
    let lse = ctx
        .doc
        .clock
        .sources
        .get("LSE")
        .map(|s| s.freq_hz)
        .unwrap_or(32_768);
    let hsi = envp(ctx, "HSI_VALUE").unwrap_or_else(|| {
        if f1 { "8000000" } else { "16000000" }.to_string()
    });
    let lsi = envp(ctx, "LSI_VALUE").unwrap_or_else(|| {
        if f1 { "40000" } else { "32000" }.to_string()
    });

    let mut b = Buf::new();
    b.line(header(
        ctx,
        &format!("{fam}_hal_conf.h"),
        "HAL configuration file.",
    ));
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line(format!("#ifndef __{fam_up}_HAL_CONF_H"));
    b.line(format!("#define __{fam_up}_HAL_CONF_H"));
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* ########################## Module Selection ############################## */");
    b.line("/**");
    b.line("  * @brief This is the list of modules to be used in the HAL driver");
    b.line("  */");
    b.line("#define HAL_MODULE_ENABLED");
    for m in &modules {
        b.line(format!("#define HAL_{m}_MODULE_ENABLED"));
    }
    // Middleware-required defines (HAL_PCD_MODULE_ENABLED & co) — verbatim
    // lines from the middleware seam.
    for line in crate::middleware::hal_conf_defines(ctx) {
        b.line(line);
    }
    b.blank();
    b.line("/* ########################## Oscillator Values adaptation ####################*/");
    b.line("/**");
    b.line("  * @brief Adjust the value of External High Speed oscillator (HSE) used in your application.");
    b.line("  *        This value is used by the RCC HAL module to compute the system frequency");
    b.line("  *        (when HSE is used as system clock source, directly or through the PLL).");
    b.line("  */");
    b.line("#if !defined  (HSE_VALUE)");
    b.line(format!(
        "#define HSE_VALUE    {hse}U /*!< Value of the External oscillator in Hz */"
    ));
    b.line("#endif /* HSE_VALUE */");
    b.blank();
    b.line("#if !defined  (HSE_STARTUP_TIMEOUT)");
    b.line("#define HSE_STARTUP_TIMEOUT    100U      /*!< Time out for HSE start up, in ms */");
    b.line("#endif /* HSE_STARTUP_TIMEOUT */");
    b.blank();
    b.line("/**");
    b.line("  * @brief Internal High Speed oscillator (HSI) value.");
    b.line("  */");
    b.line("#if !defined  (HSI_VALUE)");
    b.line(format!(
        "#define HSI_VALUE    {hsi}U /*!< Value of the Internal oscillator in Hz */"
    ));
    b.line("#endif /* HSI_VALUE */");
    b.blank();
    b.line("/**");
    b.line("  * @brief Internal Low Speed oscillator (LSI) value.");
    b.line("  */");
    b.line("#if !defined  (LSI_VALUE)");
    b.line(format!("#define LSI_VALUE    {lsi}U /*!< LSI Typical Value in Hz */"));
    b.line("#endif /* LSI_VALUE */");
    b.blank();
    b.line("/**");
    b.line("  * @brief External Low Speed oscillator (LSE) value.");
    b.line("  */");
    b.line("#if !defined  (LSE_VALUE)");
    b.line(format!(
        "#define LSE_VALUE    {lse}U /*!< Value of the External Low Speed oscillator in Hz */"
    ));
    b.line("#endif /* LSE_VALUE */");
    b.blank();
    b.line("#if !defined  (LSE_STARTUP_TIMEOUT)");
    b.line("#define LSE_STARTUP_TIMEOUT    5000U     /*!< Time out for LSE start up, in ms */");
    b.line("#endif /* LSE_STARTUP_TIMEOUT */");
    b.blank();
    if !f1 {
        b.line("/**");
        b.line("  * @brief External clock source for I2S peripheral");
        b.line("  */");
        b.line("#if !defined  (EXTERNAL_CLOCK_VALUE)");
        let ext = envp(ctx, "EXTERNAL_CLOCK_VALUE").unwrap_or_else(|| "12288000".to_string());
        b.line(format!(
            "#define EXTERNAL_CLOCK_VALUE    {ext}U /*!< Value of the External clock in Hz */"
        ));
        b.line("#endif /* EXTERNAL_CLOCK_VALUE */");
        b.blank();
    }
    // Oscillators beyond the four every family has. H7/H5 add CSI (and H5
    // HSI48); their HAL references those macros unconditionally, so a missing
    // one is a compile error, not a lost feature. Taken from the RCC def
    // rather than a per-family table: an `<osc>_VALUE` RefParameter *is* the
    // db's declaration that the family has that oscillator.
    for (name, value) in extra_oscillator_values(ctx, f1) {
        b.line(format!("#if !defined  ({name})"));
        b.line(format!(
            "#define {name}    {value}U /*!< Value of the {} oscillator in Hz */",
            name.trim_end_matches("_VALUE")
        ));
        b.line(format!("#endif /* {name} */"));
        b.blank();
    }
    // Anything else ST's own hal_conf template declares. The HAL sources
    // reference these unconditionally (L4/L5/U5 `EXTERNAL_SAI1_CLOCK_VALUE`,
    // WB `MSI_VALUE`), and no db parameter spells those names, so the
    // template's own default is the only correct value available.
    for (name, value) in template_only_values(ctx, f1, &modules) {
        b.line(format!("#if !defined  ({name})"));
        b.line(format!("#define {name}    {value}"));
        b.line(format!("#endif /* {name} */"));
        b.blank();
    }
    b.line("/* ########################### System Configuration ######################### */");
    b.line("/**");
    b.line("  * @brief This is the HAL system configuration section");
    b.line("  */");
    b.line(format!(
        "#define  VDD_VALUE                    {}U /*!< Value of VDD in mv */",
        ctx.doc.power.vdd_mv
    ));
    // TIM timebase pins the tick priority at 0 (spec §3.4); SysTick keeps
    // the lowest-priority default.
    if ctx.resolved.timebase.is_some() {
        b.line("#define  TICK_INT_PRIORITY            0U /*!< tick interrupt priority */");
    } else {
        b.line("#define  TICK_INT_PRIORITY            0x0FU /*!< tick interrupt priority */");
    }
    b.line("#define  USE_RTOS                     0U");
    b.line("#define  PREFETCH_ENABLE              1U");
    if !f1 {
        b.line("#define  INSTRUCTION_CACHE_ENABLE     1U");
        b.line("#define  DATA_CACHE_ENABLE            1U");
    }
    b.blank();
    // Register-callback switches only matter for enabled peripheral modules.
    for m in &used {
        b.line(format!(
            "#define  USE_HAL_{m}_REGISTER_CALLBACKS        0U /* {m} register callback disabled */"
        ));
    }
    if !used.is_empty() {
        b.blank();
    }
    if modules.contains("SPI") {
        b.line("/* ################## SPI peripheral configuration ########################## */");
        b.line("#define USE_SPI_CRC                     1U");
        b.blank();
    }
    b.line("/* ########################## Assert Selection ############################## */");
    b.line("/**");
    b.line("  * @brief Uncomment the line below to expanse the \"assert_param\" macro in the");
    b.line("  *        HAL drivers code");
    b.line("  */");
    b.line("/* #define USE_FULL_ASSERT    1U */");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("/**");
    b.line("  * @brief Include module's header file");
    b.line("  */");
    b.blank();
    for m in hal_conf_include_order(&modules) {
        let inc = m.to_ascii_lowercase();
        b.line(format!("#ifdef HAL_{m}_MODULE_ENABLED"));
        b.line(format!("#include \"{fam}_hal_{inc}.h\""));
        b.line(format!("#endif /* HAL_{m}_MODULE_ENABLED */"));
        b.blank();
    }
    b.line("/* Exported macro ------------------------------------------------------------*/");
    b.line("#ifdef  USE_FULL_ASSERT");
    b.line("/**");
    b.line("  * @brief  The assert_param macro is used for function's parameters check.");
    b.line("  * @param  expr If expr is false, it calls assert_failed function");
    b.line("  *         which reports the name of the source file and the source");
    b.line("  *         line number of the call that failed.");
    b.line("  *         If expr is true, it returns no value.");
    b.line("  * @retval None");
    b.line("  */");
    b.line("#define assert_param(expr) ((expr) ? (void)0U : assert_failed((uint8_t *)__FILE__, __LINE__))");
    b.line("/* Exported functions ------------------------------------------------------- */");
    b.line("void assert_failed(uint8_t* file, uint32_t line);");
    b.line("#else");
    b.line("#define assert_param(expr) ((void)0U)");
    b.line("#endif /* USE_FULL_ASSERT */");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line(format!("#endif /* __{fam_up}_HAL_CONF_H */"));
    b.into_string()
}

// ---------------------------------------------------------------------------
// <fam>_hal_timebase_tim.c (middleware-gen-spec §3.1 — verbatim anatomy)
// ---------------------------------------------------------------------------

/// The TIM-based HAL timebase file: overrides the three `__weak` tick
/// functions from `<fam>_hal.c`. Parameterized purely on the timer instance,
/// its RCC clock-enable macro, the shared IRQ vector, and the APB bus
/// (APB1CLKDivider/GetPCLK1Freq vs APB2...). Quirks preserved verbatim:
/// `HAL_NVIC_EnableIRQ` is called BEFORE `HAL_NVIC_SetPriority` (stock ST
/// template ordering), no period-elapsed callback here (it lives in main.c,
/// §3.2), no direct `uwTick` increment.
fn timebase_c(ctx: &GenCtx<'_>) -> String {
    let tb = ctx.resolved.timebase.as_ref().expect("caller checked");
    let fam = fam_lower(ctx);
    let tim = &tb.tim;
    let h = format!("htim{}", digits(tim));
    let irqn = &tb.irqn;
    let clk = &tb.clock_enable;
    let apb = if tb.apb2 { "APB2" } else { "APB1" };
    let pclk = if tb.apb2 { "2" } else { "1" };
    format!(
        r#"/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    {fam}_hal_timebase_tim.c
  * @brief   HAL time base based on the hardware TIM.
  ******************************************************************************
  * @attention
  *
  * Generated by stm32kernel {kver} -- IR pack {pack} (CubeMX db {db}).
  * Regenerated files keep user code only inside USER CODE sections.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "{fam}_hal.h"
#include "{fam}_hal_tim.h"

/* Private typedef -----------------------------------------------------------*/
/* Private define ------------------------------------------------------------*/
/* Private macro -------------------------------------------------------------*/
/* Private variables ---------------------------------------------------------*/
TIM_HandleTypeDef        {h};
/* Private function prototypes -----------------------------------------------*/
/* Private functions ---------------------------------------------------------*/

/**
  * @brief  This function configures the {tim} as a time base source.
  *         The time source is configured  to have 1ms time base with a dedicated
  *         Tick interrupt priority.
  * @note   This function is called  automatically at the beginning of program after
  *         reset by HAL_Init() or at any time when clock is configured, by HAL_RCC_ClockConfig().
  * @param  TickPriority: Tick interrupt priority.
  * @retval HAL status
  */
HAL_StatusTypeDef HAL_InitTick(uint32_t TickPriority)
{{
  RCC_ClkInitTypeDef    clkconfig;
  uint32_t              uwTimclock, uw{apb}Prescaler = 0U;

  uint32_t              uwPrescalerValue = 0U;
  uint32_t              pFLatency;

  HAL_StatusTypeDef     status;

  /* Enable {tim} clock */
  {clk}();

  /* Get clock configuration */
  HAL_RCC_GetClockConfig(&clkconfig, &pFLatency);

  /* Get {apb} prescaler */
  uw{apb}Prescaler = clkconfig.{apb}CLKDivider;
  /* Compute {tim} clock */
  if (uw{apb}Prescaler == RCC_HCLK_DIV1)
  {{
    uwTimclock = HAL_RCC_GetPCLK{pclk}Freq();
  }}
  else
  {{
    uwTimclock = 2UL * HAL_RCC_GetPCLK{pclk}Freq();
  }}

  /* Compute the prescaler value to have {tim} counter clock equal to 1MHz */
  uwPrescalerValue = (uint32_t) ((uwTimclock / 1000000U) - 1U);

  /* Initialize {tim} */
  {h}.Instance = {tim};

  /* Initialize TIMx peripheral as follow:

  + Period = [(TIM14CLK/1000) - 1]. to have a (1/1000) s time base.
  + Prescaler = (uwTimclock/1000000 - 1) to have a 1MHz counter clock.
  + ClockDivision = 0
  + Counter direction = Up
  */
  {h}.Init.Period = (1000000U / 1000U) - 1U;
  {h}.Init.Prescaler = uwPrescalerValue;
  {h}.Init.ClockDivision = 0;
  {h}.Init.CounterMode = TIM_COUNTERMODE_UP;
  {h}.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;

  status = HAL_TIM_Base_Init(&{h});
  if (status == HAL_OK)
  {{
    /* Start the TIM time Base generation in interrupt mode */
    status = HAL_TIM_Base_Start_IT(&{h});
    if (status == HAL_OK)
    {{
    /* Enable the {tim} global Interrupt */
        HAL_NVIC_EnableIRQ({irqn});
      /* Configure the SysTick IRQ priority */
      if (TickPriority < (1UL << __NVIC_PRIO_BITS))
      {{
        /* Configure the TIM IRQ priority */
        HAL_NVIC_SetPriority({irqn}, TickPriority, 0U);
        uwTickPrio = TickPriority;
      }}
      else
      {{
        status = HAL_ERROR;
      }}
    }}
  }}

 /* Return function status */
  return status;
}}

/**
  * @brief  Suspend Tick increment.
  * @note   Disable the tick increment by disabling {tim} update interrupt.
  * @param  None
  * @retval None
  */
void HAL_SuspendTick(void)
{{
  /* Disable {tim} update Interrupt */
  __HAL_TIM_DISABLE_IT(&{h}, TIM_IT_UPDATE);
}}

/**
  * @brief  Resume Tick increment.
  * @note   Enable the tick increment by Enabling {tim} update interrupt.
  * @param  None
  * @retval None
  */
void HAL_ResumeTick(void)
{{
  /* Enable {tim} Update interrupt */
  __HAL_TIM_ENABLE_IT(&{h}, TIM_IT_UPDATE);
}}
"#,
        kver = ctx.kernel_version,
        pack = ctx.pack.family,
        db = ctx.pack.db_version,
    )
}
