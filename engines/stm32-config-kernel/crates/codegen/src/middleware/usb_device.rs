//! USB Device (CDC) middleware generator (P6). Spec:
//! docs/middleware-gen-spec.md §4, mining: docs/mining/mine-usb.md.
//!
//! v1 scope: class CDC on USB_OTG_FS (F4, Device_Only). The generator is
//! active when `middleware.usbDevice` is configured; it emits the CubeMX
//! 6.17-shaped glue for the USB Device Library v2.11.6 we ship under
//! `data/fw/MW/USB_Device` (verified against `Core/Inc/usbd_def.h` +
//! `Class/CDC/Inc/usbd_cdc.h`: `USBD_CDC_ItfTypeDef` carries
//! `TransmitCplt`, `USBD_CDC_SetTxBuffer` is the 3-arg non-composite
//! overload, and `pClassData` is still mirrored from `pClassDataCmsit`,
//! so `CDC_Transmit_FS`'s busy check works unchanged).
//!
//! Ownership split (mine-usb Q3/Q5): the middleware owns ALL USB init —
//! `HAL_PCD_Init` runs inside `USBD_LL_Init` and `HAL_PCD_MspInit` lives in
//! usbd_conf.c; CubeMX never emits an `MX_USB_OTG_FS_PCD_Init`. This module
//! therefore declares USB_OTG_FS as a middleware-owned instance
//! ([`MiddlewareGen::owned_instances`], P7): the core emitter skips the
//! per-IP file pair (`pcd.c`/`pcd.h`), the main.c include + MX call, and
//! the CMake entry for it, while the instance's pins/NVIC/clock data stay
//! in the resolved model and are consumed by usbd_conf.c below. File-set
//! parity with the CubeMX reference holds exactly.
//!
//! hal_conf: `HAL_PCD_MODULE_ENABLED` + `USE_HAL_PCD_REGISTER_CALLBACKS 0U`
//! (and the pcd/pcd_ex/ll_usb HAL sources) already flow from the
//! USB_OTG_FS peripheral's `HalMode="PCD"` through `crate::hal_module`, so
//! [`MiddlewareGen::hal_conf_defines`] stays the no-op default here —
//! adding the define again would double-define it.

use super::{CmakeAdditions, ItHandler, MainHooks, MiddlewareGen};
use crate::{GenCtx, GeneratedFile};
use std::path::Path;
use stm32ck_engine::config::UsbDeviceCfg;
use stm32ck_engine::diag::Diagnostic;
use stm32ck_engine::session::ResolvedPeriph;

/// The single peripheral instance backing the v1 CDC FS stack.
const USB_INSTANCE: &str = "USB_OTG_FS";
/// Its device-mode interrupt vector (the WKUP vector is EXTI-driven and not
/// part of the CDC glue).
const USB_IRQN: &str = "OTG_FS_IRQn";

pub struct UsbCdcGen;

// ---------------------------------------------------------------------------
// Document / resolved-model lookups
// ---------------------------------------------------------------------------

fn usb_cfg<'a>(ctx: &'a GenCtx<'_>) -> Option<&'a UsbDeviceCfg> {
    ctx.doc.middleware.as_ref()?.usb_device.as_ref()
}

fn usb_periph<'a, 'b>(ctx: &'a GenCtx<'b>) -> Option<&'a ResolvedPeriph<'b>> {
    ctx.resolved
        .periphs
        .iter()
        .find(|p| p.instance == USB_INSTANCE)
}

fn freertos_present(ctx: &GenCtx<'_>) -> bool {
    ctx.doc
        .middleware
        .as_ref()
        .is_some_and(|m| m.freertos.is_some())
}

/// All generation preconditions: CDC class + the USB_OTG_FS peripheral
/// resolved in PCD (device) mode. When not ready every hook emits nothing
/// (panic-free fallback) and [`UsbCdcGen::diagnostics`] says why.
fn ready(ctx: &GenCtx<'_>) -> bool {
    let Some(cfg) = usb_cfg(ctx) else { return false };
    if !cfg.class.eq_ignore_ascii_case("CDC") {
        return false;
    }
    usb_periph(ctx).is_some_and(|p| p.hal_mode.as_deref() == Some("PCD"))
}

/// (preemption, sub) priority for OTG_FS_IRQn: the resolved NVIC entry for
/// the exact vector wins, then any vector the engine attributed to
/// USB_OTG_FS (the `nvic` shorthand currently lands on OTG_FS_WKUP_IRQn —
/// engine gap, reported), then the doc shorthand, then (0, 0).
fn usb_irq_prio(ctx: &GenCtx<'_>) -> (u32, u32) {
    let owned: Vec<_> = ctx
        .resolved
        .nvic
        .iter()
        .filter(|i| i.owner == USB_INSTANCE)
        .collect();
    if let Some(i) = owned.iter().find(|i| i.irqn == USB_IRQN) {
        return (i.preemption_priority, i.sub_priority);
    }
    if let Some(i) = owned.first() {
        return (i.preemption_priority, i.sub_priority);
    }
    if let Some(n) = usb_periph(ctx).and_then(|p| p.nvic.as_ref()) {
        if n.enabled {
            return (n.preemption_priority, n.sub_priority);
        }
    }
    (0, 0)
}

/// True when the core it.c already generates an `OTG_FS_IRQHandler` (the
/// doc enabled the vector with `generateHandler` on) — this module must
/// then withhold its own handler or the file would define it twice.
fn core_owns_usb_irq(ctx: &GenCtx<'_>) -> bool {
    ctx.resolved
        .nvic
        .iter()
        .any(|i| i.irqn == USB_IRQN && i.generate_handler)
}

/// One DM/DP pin as placed by the engine.
struct UsbPin {
    /// "PA11"
    pad: String,
    /// 'A'
    port: char,
    /// 11
    bit: u32,
    /// "USB_OTG_FS_DM"
    signal: String,
    /// "GPIO_AF10_OTG_FS"
    af: String,
}

/// USB_OTG_FS pin placements sorted by (port, bit) — PA11 before PA12.
fn usb_pins(ctx: &GenCtx<'_>) -> Vec<UsbPin> {
    let prefix = format!("{USB_INSTANCE}_");
    let mut pins: Vec<UsbPin> = ctx
        .resolved
        .pin_plan
        .placements
        .iter()
        .filter(|pl| pl.signal.starts_with(&prefix))
        .map(|pl| {
            let base: String = pl
                .pin
                .split(['-', '/'])
                .next()
                .unwrap_or(&pl.pin)
                .to_string();
            let bytes = base.as_bytes();
            let (port, bit) = if bytes.len() >= 3 && bytes[0] == b'P' {
                (bytes[1] as char, base[2..].parse::<u32>().unwrap_or(0))
            } else {
                ('A', 0)
            };
            UsbPin {
                pad: base,
                port,
                bit,
                signal: pl.signal.clone(),
                af: pl
                    .af_macro
                    .clone()
                    .unwrap_or_else(|| "GPIO_AF10_OTG_FS".to_string()),
            }
        })
        .collect();
    pins.sort_by_key(|p| (p.port, p.bit));
    pins
}

/// One PCD `Init` field: the resolved peripheral parameter when the engine
/// produced it, else the db default CubeMX prints for CDC FS.
fn pcd_param<'a>(p: &'a ResolvedPeriph<'_>, name: &str, default: &'a str) -> &'a str {
    p.params.get(name).map(String::as_str).unwrap_or(default)
}

// ---------------------------------------------------------------------------
// Small text helpers (mirrors emit.rs's private Buf/header, which this
// module cannot reach)
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
    /// Verbatim multi-line block (raw template text), trimming exactly one
    /// leading newline so `r#"..."#` literals can start on their own line.
    fn raw(&mut self, s: &str) {
        self.0.push_str(s.strip_prefix('\n').unwrap_or(s));
    }
    fn user0(&mut self, tag: &str) {
        self.line(format!("/* USER CODE BEGIN {tag} */"));
        self.blank();
        self.line(format!("/* USER CODE END {tag} */"));
    }
    fn into_string(self) -> String {
        self.0
    }
}

/// "stm32f4xx"
fn fam_lower(ctx: &GenCtx<'_>) -> String {
    ctx.device_prefix()
}

/// File header comment in the same shape the core emitter stamps (no
/// timestamps — determinism).
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

// ---------------------------------------------------------------------------
// Core/Inc/usb_device.h + Core/Src/usb_device.c (spec §4.1)
// ---------------------------------------------------------------------------

fn usb_device_h(ctx: &GenCtx<'_>) -> String {
    let fam = fam_lower(ctx);
    let mut b = Buf::new();
    b.line(header(ctx, "usb_device.h", "Header for usb_device.c file."));
    b.blank();
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line("#ifndef __USB_DEVICE__H__");
    b.line("#define __USB_DEVICE__H__");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line(" extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line(format!("#include \"{fam}.h\""));
    b.line(format!("#include \"{fam}_hal.h\""));
    b.line("#include \"usbd_def.h\"");
    b.blank();
    b.user0("INCLUDE");
    b.blank();
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.user0("PV");
    b.blank();
    b.line("/* Private function prototypes -----------------------------------------------*/");
    b.user0("PFP");
    b.blank();
    b.user0("VARIABLES");
    b.blank();
    b.line("/** USB Device initialization function. */");
    b.line("void MX_USB_DEVICE_Init(void);");
    b.blank();
    b.user0("FD");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line("#endif /* __USB_DEVICE__H__ */");
    b.into_string()
}

fn usb_device_c(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(ctx, "usb_device.c", "This file implements the USB Device"));
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.blank();
    b.line("#include \"usb_device.h\"");
    b.line("#include \"usbd_core.h\"");
    b.line("#include \"usbd_desc.h\"");
    b.line("#include \"usbd_cdc.h\"");
    b.line("#include \"usbd_cdc_if.h\"");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.user0("PV");
    b.blank();
    b.user0("PFP");
    b.blank();
    b.line("/* USB Device Core handle declaration. */");
    b.line("USBD_HandleTypeDef hUsbDeviceFS;");
    b.blank();
    b.user0("0");
    b.blank();
    b.user0("1");
    b.blank();
    b.raw(
        r#"
/**
  * Init USB device Library, add supported class and start the library
  * @retval None
  */
void MX_USB_DEVICE_Init(void)
{
  /* USER CODE BEGIN USB_DEVICE_Init_PreTreatment */

  /* USER CODE END USB_DEVICE_Init_PreTreatment */

  /* Init Device Library, add supported class and start the library. */
  if (USBD_Init(&hUsbDeviceFS, &FS_Desc, DEVICE_FS) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_RegisterClass(&hUsbDeviceFS, &USBD_CDC) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_CDC_RegisterInterface(&hUsbDeviceFS, &USBD_Interface_fops_FS) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_Start(&hUsbDeviceFS) != USBD_OK)
  {
    Error_Handler();
  }

  /* USER CODE BEGIN USB_DEVICE_Init_PostTreatment */

  /* USER CODE END USB_DEVICE_Init_PostTreatment */
}
"#,
    );
    b.into_string()
}

// ---------------------------------------------------------------------------
// Core/Inc/usbd_conf.h + Core/Src/usbd_conf.c (spec §4.3)
// ---------------------------------------------------------------------------

fn usbd_conf_h(ctx: &GenCtx<'_>) -> String {
    let fam = fam_lower(ctx);
    let mut b = Buf::new();
    b.line(header(ctx, "usbd_conf.h", "Header for usbd_conf.c file."));
    b.blank();
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.line("#ifndef __USBD_CONF__H__");
    b.line("#define __USBD_CONF__H__");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line(" extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include <stdio.h>");
    b.line("#include <stdlib.h>");
    b.line("#include <string.h>");
    b.line("#include \"main.h\"");
    b.line(format!("#include \"{fam}.h\""));
    b.line(format!("#include \"{fam}_hal.h\""));
    b.blank();
    b.user0("INCLUDE");
    b.blank();
    b.raw(
        r#"
/*---------- -----------*/
#define USBD_MAX_NUM_INTERFACES     1U
/*---------- -----------*/
#define USBD_MAX_NUM_CONFIGURATION     1U
/*---------- -----------*/
#define USBD_MAX_STR_DESC_SIZ     512U
/*---------- -----------*/
#define USBD_DEBUG_LEVEL     0U
/*---------- -----------*/
#define USBD_LPM_ENABLED     0U
/*---------- -----------*/
#define USBD_SELF_POWERED     1U

/****************************************/
/* #define for FS and HS identification */
#define DEVICE_FS 		0
#define DEVICE_HS 		1

/* Memory management macros make sure to use static memory allocation */
/** Alias for memory allocation. */

#define USBD_malloc         (void *)USBD_static_malloc

/** Alias for memory release. */
#define USBD_free           USBD_static_free

/** Alias for memory set. */
#define USBD_memset         memset

/** Alias for memory copy. */
#define USBD_memcpy         memcpy

/** Alias for delay. */
#define USBD_Delay          HAL_Delay

/* DEBUG macros */

#if (USBD_DEBUG_LEVEL > 0)
#define USBD_UsrLog(...)    printf(__VA_ARGS__);\
                            printf("\n");
#else
#define USBD_UsrLog(...)
#endif /* (USBD_DEBUG_LEVEL > 0U) */

#if (USBD_DEBUG_LEVEL > 1)

#define USBD_ErrLog(...)    printf("ERROR: ");\
                            printf(__VA_ARGS__);\
                            printf("\n");
#else
#define USBD_ErrLog(...)
#endif /* (USBD_DEBUG_LEVEL > 1U) */

#if (USBD_DEBUG_LEVEL > 2)
#define USBD_DbgLog(...)    printf("DEBUG : ");\
                            printf(__VA_ARGS__);\
                            printf("\n");
#else
#define USBD_DbgLog(...)
#endif /* (USBD_DEBUG_LEVEL > 2U) */

/* Exported functions -------------------------------------------------------*/
void *USBD_static_malloc(uint32_t size);
void USBD_static_free(void *p);

#ifdef __cplusplus
}
#endif

#endif /* __USBD_CONF__H__ */
"#,
    );
    b.into_string()
}

fn usbd_conf_c(ctx: &GenCtx<'_>, p: &ResolvedPeriph<'_>) -> String {
    let fam = fam_lower(ctx);
    let (prio, sub) = usb_irq_prio(ctx);
    let pins = usb_pins(ctx);
    let mut b = Buf::new();
    b.line(header(
        ctx,
        "usbd_conf.c",
        "This file implements the board support package for the USB device library",
    ));
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line(format!("#include \"{fam}.h\""));
    b.line(format!("#include \"{fam}_hal.h\""));
    b.line("#include \"usbd_def.h\"");
    b.line("#include \"usbd_core.h\"");
    b.blank();
    b.line("#include \"usbd_cdc.h\"");
    b.blank();
    b.user0("Includes");
    b.blank();
    b.line("/* Private typedef -----------------------------------------------------------*/");
    b.line("/* Private define ------------------------------------------------------------*/");
    b.line("/* Private macro -------------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE BEGIN PV */");
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE END PV */");
    b.blank();
    b.line("PCD_HandleTypeDef hpcd_USB_OTG_FS;");
    b.line("void Error_Handler(void);");
    b.blank();
    b.line("/* External functions --------------------------------------------------------*/");
    b.line("void SystemClock_Config(void);");
    b.blank();
    b.user0("0");
    b.blank();
    b.line("/* USER CODE BEGIN PFP */");
    b.line("/* Private function prototypes -----------------------------------------------*/");
    b.line("USBD_StatusTypeDef USBD_Get_USB_Status(HAL_StatusTypeDef hal_status);");
    b.blank();
    b.line("/* USER CODE END PFP */");
    b.blank();
    b.line("/* Private functions ---------------------------------------------------------*/");
    b.blank();
    b.user0("1");
    b.blank();
    b.line("/*******************************************************************************");
    b.line("                       LL Driver Callbacks (PCD -> USB Device Library)");
    b.line("*******************************************************************************/");
    b.line("/* MSP Init */");
    b.blank();

    // --- HAL_PCD_MspInit / MspDeInit — pins + clock + NVIC from the resolved
    //     USB_OTG_FS peripheral (spec §4.3).
    b.line("void HAL_PCD_MspInit(PCD_HandleTypeDef* pcdHandle)");
    b.line("{");
    b.line("  GPIO_InitTypeDef GPIO_InitStruct = {0};");
    b.line(format!("  if(pcdHandle->Instance=={USB_INSTANCE})"));
    b.line("  {");
    b.line(format!("  /* USER CODE BEGIN {USB_INSTANCE}_MspInit 0 */"));
    b.blank();
    b.line(format!("  /* USER CODE END {USB_INSTANCE}_MspInit 0 */"));
    b.blank();
    // Port clock enables + one HAL_GPIO_Init per port, placement order.
    let mut ports: Vec<char> = Vec::new();
    for pin in &pins {
        if !ports.contains(&pin.port) {
            ports.push(pin.port);
        }
    }
    for port in &ports {
        b.line(format!("    __HAL_RCC_GPIO{port}_CLK_ENABLE();"));
    }
    b.line(format!("    /**{USB_INSTANCE} GPIO Configuration"));
    for pin in &pins {
        b.line(format!("    {}     ------> {}", pin.pad, pin.signal));
    }
    b.line("    */");
    for port in &ports {
        let members: Vec<&UsbPin> = pins.iter().filter(|p| p.port == *port).collect();
        let or_expr = members
            .iter()
            .map(|p| format!("GPIO_PIN_{}", p.bit))
            .collect::<Vec<_>>()
            .join("|");
        let af = members
            .first()
            .map(|p| p.af.clone())
            .unwrap_or_else(|| "GPIO_AF10_OTG_FS".to_string());
        b.line(format!("    GPIO_InitStruct.Pin = {or_expr};"));
        b.line("    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;");
        b.line("    GPIO_InitStruct.Pull = GPIO_NOPULL;");
        b.line("    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;");
        b.line(format!("    GPIO_InitStruct.Alternate = {af};"));
        b.line(format!("    HAL_GPIO_Init(GPIO{port}, &GPIO_InitStruct);"));
        b.blank();
    }
    b.line("    /* Peripheral clock enable */");
    let clk = p
        .clock_enable
        .first()
        .cloned()
        .unwrap_or_else(|| format!("__HAL_RCC_{USB_INSTANCE}_CLK_ENABLE"));
    b.line(format!("    {clk}();"));
    b.blank();
    b.line("    /* Peripheral interrupt init */");
    b.line(format!("    HAL_NVIC_SetPriority({USB_IRQN}, {prio}, {sub});"));
    b.line(format!("    HAL_NVIC_EnableIRQ({USB_IRQN});"));
    b.line(format!("  /* USER CODE BEGIN {USB_INSTANCE}_MspInit 1 */"));
    b.blank();
    b.line(format!("  /* USER CODE END {USB_INSTANCE}_MspInit 1 */"));
    b.line("  }");
    b.line("}");
    b.blank();
    b.line("void HAL_PCD_MspDeInit(PCD_HandleTypeDef* pcdHandle)");
    b.line("{");
    b.line(format!("  if(pcdHandle->Instance=={USB_INSTANCE})"));
    b.line("  {");
    b.line(format!("  /* USER CODE BEGIN {USB_INSTANCE}_MspDeInit 0 */"));
    b.blank();
    b.line(format!("  /* USER CODE END {USB_INSTANCE}_MspDeInit 0 */"));
    b.line("    /* Peripheral clock disable */");
    b.line(format!("    {}();", clk.replace("_CLK_ENABLE", "_CLK_DISABLE")));
    b.blank();
    b.line(format!("    /**{USB_INSTANCE} GPIO Configuration"));
    for pin in &pins {
        b.line(format!("    {}     ------> {}", pin.pad, pin.signal));
    }
    b.line("    */");
    for port in &ports {
        let members: Vec<&UsbPin> = pins.iter().filter(|p| p.port == *port).collect();
        let or_expr = members
            .iter()
            .map(|p| format!("GPIO_PIN_{}", p.bit))
            .collect::<Vec<_>>()
            .join("|");
        b.line(format!("    HAL_GPIO_DeInit(GPIO{port}, {or_expr});"));
    }
    b.blank();
    b.line("    /* Peripheral interrupt Deinit*/");
    b.line(format!("    HAL_NVIC_DisableIRQ({USB_IRQN});"));
    b.line(format!("  /* USER CODE BEGIN {USB_INSTANCE}_MspDeInit 1 */"));
    b.blank();
    b.line(format!("  /* USER CODE END {USB_INSTANCE}_MspDeInit 1 */"));
    b.line("  }");
    b.line("}");

    // --- PCD -> USBD callback glue (fixed boilerplate, spec §4.3 table).
    b.raw(
        r#"

/**
  * @brief  Setup stage callback
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_SetupStageCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_SetupStageCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_SetupStage((USBD_HandleTypeDef*)hpcd->pData, (uint8_t *)hpcd->Setup);
}

/**
  * @brief  Data Out stage callback.
  * @param  hpcd: PCD handle
  * @param  epnum: Endpoint number
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_DataOutStageCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#else
void HAL_PCD_DataOutStageCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_DataOutStage((USBD_HandleTypeDef*)hpcd->pData, epnum, hpcd->OUT_ep[epnum].xfer_buff);
}

/**
  * @brief  Data In stage callback.
  * @param  hpcd: PCD handle
  * @param  epnum: Endpoint number
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_DataInStageCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#else
void HAL_PCD_DataInStageCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_DataInStage((USBD_HandleTypeDef*)hpcd->pData, epnum, hpcd->IN_ep[epnum].xfer_buff);
}

/**
  * @brief  SOF callback.
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_SOFCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_SOFCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_SOF((USBD_HandleTypeDef*)hpcd->pData);
}

/**
  * @brief  Reset callback.
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_ResetCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_ResetCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_SpeedTypeDef speed = USBD_SPEED_FULL;

  if ( hpcd->Init.speed == PCD_SPEED_HIGH)
  {
    speed = USBD_SPEED_HIGH;
  }
  else if ( hpcd->Init.speed == PCD_SPEED_FULL)
  {
    speed = USBD_SPEED_FULL;
  }
  else
  {
    Error_Handler();
  }
    /* Set Speed. */
  USBD_LL_SetSpeed((USBD_HandleTypeDef*)hpcd->pData, speed);

  /* Reset Device. */
  USBD_LL_Reset((USBD_HandleTypeDef*)hpcd->pData);
}

/**
  * @brief  Suspend callback.
  * When Low power mode is enabled the debug cannot be used (IAR, Keil doesn't support it)
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_SuspendCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_SuspendCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  /* Inform USB library that core enters in suspend Mode. */
  USBD_LL_Suspend((USBD_HandleTypeDef*)hpcd->pData);
  __HAL_PCD_GATE_PHYCLOCK(hpcd);
  /* Enter in STOP mode. */
  /* USER CODE BEGIN 2 */
  if (hpcd->Init.low_power_enable)
  {
    /* Set SLEEPDEEP bit and SleepOnExit of Cortex System Control Register. */
    SCB->SCR |= (uint32_t)((uint32_t)(SCB_SCR_SLEEPDEEP_Msk | SCB_SCR_SLEEPONEXIT_Msk));
  }
  /* USER CODE END 2 */
}

/**
  * @brief  Resume callback.
  * When Low power mode is enabled the debug cannot be used (IAR, Keil doesn't support it)
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_ResumeCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_ResumeCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  /* USER CODE BEGIN 3 */

  /* USER CODE END 3 */
  USBD_LL_Resume((USBD_HandleTypeDef*)hpcd->pData);
}

/**
  * @brief  ISOOUTIncomplete callback.
  * @param  hpcd: PCD handle
  * @param  epnum: Endpoint number
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_ISOOUTIncompleteCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#else
void HAL_PCD_ISOOUTIncompleteCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_IsoOUTIncomplete((USBD_HandleTypeDef*)hpcd->pData, epnum);
}

/**
  * @brief  ISOINIncomplete callback.
  * @param  hpcd: PCD handle
  * @param  epnum: Endpoint number
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_ISOINIncompleteCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#else
void HAL_PCD_ISOINIncompleteCallback(PCD_HandleTypeDef *hpcd, uint8_t epnum)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_IsoINIncomplete((USBD_HandleTypeDef*)hpcd->pData, epnum);
}

/**
  * @brief  Connect callback.
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_ConnectCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_ConnectCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_DevConnected((USBD_HandleTypeDef*)hpcd->pData);
}

/**
  * @brief  Disconnect callback.
  * @param  hpcd: PCD handle
  * @retval None
  */
#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
static void PCD_DisconnectCallback(PCD_HandleTypeDef *hpcd)
#else
void HAL_PCD_DisconnectCallback(PCD_HandleTypeDef *hpcd)
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
{
  USBD_LL_DevDisconnected((USBD_HandleTypeDef*)hpcd->pData);
}

/*******************************************************************************
                       LL Driver Interface (USB Device Library --> PCD)
*******************************************************************************/

/**
  * @brief  Initializes the low level portion of the device driver.
  * @param  pdev: Device handle
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_Init(USBD_HandleTypeDef *pdev)
{
  /* Init USB Ip. */
  if (pdev->id == DEVICE_FS) {
  /* Link the driver to the stack. */
  hpcd_USB_OTG_FS.pData = pdev;
  pdev->pData = &hpcd_USB_OTG_FS;

"#,
    );
    // Parameterized PCD Init fill (values from the resolved peripheral).
    b.line(format!("  hpcd_USB_OTG_FS.Instance = {USB_INSTANCE};"));
    for (field, default) in [
        ("dev_endpoints", "4"),
        ("speed", "PCD_SPEED_FULL"),
        ("dma_enable", "DISABLE"),
        ("phy_itface", "PCD_PHY_EMBEDDED"),
        ("Sof_enable", "DISABLE"),
        ("low_power_enable", "DISABLE"),
        ("lpm_enable", "DISABLE"),
        ("vbus_sensing_enable", "DISABLE"),
        ("use_dedicated_ep1", "DISABLE"),
    ] {
        // `speed` is exposed in the db as `DeviceSpeed` (MethodArg binding).
        let key = if field == "speed" { "DeviceSpeed" } else { field };
        b.line(format!(
            "  hpcd_USB_OTG_FS.Init.{field} = {};",
            pcd_param(p, key, default)
        ));
    }
    b.raw(
        r#"
  if (HAL_PCD_Init(&hpcd_USB_OTG_FS) != HAL_OK)
  {
    Error_Handler( );
  }

#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
  /* Register USB PCD CallBacks */
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_SOF_CB_ID, PCD_SOFCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_SETUPSTAGE_CB_ID, PCD_SetupStageCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_RESET_CB_ID, PCD_ResetCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_SUSPEND_CB_ID, PCD_SuspendCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_RESUME_CB_ID, PCD_ResumeCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_CONNECT_CB_ID, PCD_ConnectCallback);
  HAL_PCD_RegisterCallback(&hpcd_USB_OTG_FS, HAL_PCD_DISCONNECT_CB_ID, PCD_DisconnectCallback);

  HAL_PCD_RegisterDataOutStageCallback(&hpcd_USB_OTG_FS, PCD_DataOutStageCallback);
  HAL_PCD_RegisterDataInStageCallback(&hpcd_USB_OTG_FS, PCD_DataInStageCallback);
  HAL_PCD_RegisterIsoOutIncpltCallback(&hpcd_USB_OTG_FS, PCD_ISOOUTIncompleteCallback);
  HAL_PCD_RegisterIsoInIncpltCallback(&hpcd_USB_OTG_FS, PCD_ISOINIncompleteCallback);
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
  HAL_PCDEx_SetRxFiFo(&hpcd_USB_OTG_FS, 0x80);
  HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 0, 0x40);
  HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 1, 0x80);
  }
  return USBD_OK;
}

/**
  * @brief  De-Initializes the low level portion of the device driver.
  * @param  pdev: Device handle
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_DeInit(USBD_HandleTypeDef *pdev)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_DeInit(pdev->pData);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Starts the low level portion of the device driver.
  * @param  pdev: Device handle
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_Start(USBD_HandleTypeDef *pdev)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_Start(pdev->pData);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Stops the low level portion of the device driver.
  * @param  pdev: Device handle
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_Stop(USBD_HandleTypeDef *pdev)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_Stop(pdev->pData);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Opens an endpoint of the low level driver.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @param  ep_type: Endpoint type
  * @param  ep_mps: Endpoint max packet size
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_OpenEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr, uint8_t ep_type, uint16_t ep_mps)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_Open(pdev->pData, ep_addr, ep_mps, ep_type);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Closes an endpoint of the low level driver.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_CloseEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_Close(pdev->pData, ep_addr);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Flushes an endpoint of the Low Level Driver.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_FlushEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_Flush(pdev->pData, ep_addr);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Sets a Stall condition on an endpoint of the Low Level Driver.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_StallEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_SetStall(pdev->pData, ep_addr);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Clears a Stall condition on an endpoint of the Low Level Driver.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_ClearStallEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_ClrStall(pdev->pData, ep_addr);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Returns Stall condition.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval Stall (1: Yes, 0: No)
  */
uint8_t USBD_LL_IsStallEP(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  PCD_HandleTypeDef *hpcd = (PCD_HandleTypeDef*) pdev->pData;

  if((ep_addr & 0x80) == 0x80)
  {
    return hpcd->IN_ep[ep_addr & 0x7F].is_stall;
  }
  else
  {
    return hpcd->OUT_ep[ep_addr & 0x7F].is_stall;
  }
}

/**
  * @brief  Assigns a USB address to the device.
  * @param  pdev: Device handle
  * @param  dev_addr: Device address
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_SetUSBAddress(USBD_HandleTypeDef *pdev, uint8_t dev_addr)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_SetAddress(pdev->pData, dev_addr);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Transmits data over an endpoint.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @param  pbuf: Pointer to data to be sent
  * @param  size: Data size
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_Transmit(USBD_HandleTypeDef *pdev, uint8_t ep_addr, uint8_t *pbuf, uint32_t size)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_Transmit(pdev->pData, ep_addr, pbuf, size);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Prepares an endpoint for reception.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @param  pbuf: Pointer to data to be received
  * @param  size: Data size
  * @retval USBD status
  */
USBD_StatusTypeDef USBD_LL_PrepareReceive(USBD_HandleTypeDef *pdev, uint8_t ep_addr, uint8_t *pbuf, uint32_t size)
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = HAL_PCD_EP_Receive(pdev->pData, ep_addr, pbuf, size);

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}

/**
  * @brief  Returns the last transferred packet size.
  * @param  pdev: Device handle
  * @param  ep_addr: Endpoint number
  * @retval Received Data Size
  */
uint32_t USBD_LL_GetRxDataSize(USBD_HandleTypeDef *pdev, uint8_t ep_addr)
{
  return HAL_PCD_EP_GetRxCount((PCD_HandleTypeDef*) pdev->pData, ep_addr);
}

#ifdef USBD_HS_TESTMODE_ENABLE
/**
  * @brief  Set High speed Test mode.
  * @param  pdev: Device handle
  * @param  testmode: test mode
  * @retval USBD Status
  */
USBD_StatusTypeDef USBD_LL_SetTestMode(USBD_HandleTypeDef *pdev, uint8_t testmode)
{
  UNUSED(pdev);
  UNUSED(testmode);

  return USBD_OK;
}
#endif /* USBD_HS_TESTMODE_ENABLE */

/**
  * @brief  Static single allocation.
  * @param  size: Size of allocated memory
  * @retval None
  */
void *USBD_static_malloc(uint32_t size)
{
  static uint32_t mem[(sizeof(USBD_CDC_HandleTypeDef)/4)+1];/* On 32-bit boundary */
  return mem;
}

/**
  * @brief  Dummy memory free
  * @param  p: Pointer to allocated  memory address
  * @retval None
  */
void USBD_static_free(void *p)
{

}

/**
  * @brief  Delays routine for the USB Device Library.
  * @param  Delay: Delay in ms
  * @retval None
  */
void USBD_LL_Delay(uint32_t Delay)
{
  HAL_Delay(Delay);
}

/**
  * @brief  Returns the USB status depending on the HAL status:
  * @param  hal_status: HAL status
  * @retval USB status
  */
USBD_StatusTypeDef USBD_Get_USB_Status(HAL_StatusTypeDef hal_status)
{
  USBD_StatusTypeDef usb_status = USBD_OK;

  switch (hal_status)
  {
    case HAL_OK :
      usb_status = USBD_OK;
    break;
    case HAL_ERROR :
      usb_status = USBD_FAIL;
    break;
    case HAL_BUSY :
      usb_status = USBD_BUSY;
    break;
    case HAL_TIMEOUT :
      usb_status = USBD_FAIL;
    break;
    default :
      usb_status = USBD_FAIL;
    break;
  }
  return usb_status;
}
"#,
    );
    b.into_string()
}

// ---------------------------------------------------------------------------
// Core/Inc/usbd_desc.h + Core/Src/usbd_desc.c (spec §4.2)
// ---------------------------------------------------------------------------

fn usbd_desc_h(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(ctx, "usbd_desc.c", "Header for usbd_conf.c file."));
    b.raw(
        r#"
/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __USBD_DESC__C__
#define __USBD_DESC__C__

#ifdef __cplusplus
 extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "usbd_def.h"

/* USER CODE BEGIN INCLUDE */

/* USER CODE END INCLUDE */

/*
 * User to provide a unique ID to define the USB device serial number
 * The use of UID_BASE register can be considered as an example
 */
#define         DEVICE_ID1          (UID_BASE)
#define         DEVICE_ID2          (UID_BASE + 0x4)
#define         DEVICE_ID3          (UID_BASE + 0x8)

#define  USB_SIZ_STRING_SERIAL       0x1A

/* USER CODE BEGIN EXPORTED_CONSTANTS */

/* USER CODE END EXPORTED_CONSTANTS */

/* USER CODE BEGIN EXPORTED_DEFINES */

/* USER CODE END EXPORTED_DEFINES */

/* USER CODE BEGIN EXPORTED_TYPES */

/* USER CODE END EXPORTED_TYPES */

/* USER CODE BEGIN EXPORTED_MACRO */

/* USER CODE END EXPORTED_MACRO */

/** Descriptor for the Usb device. */
extern USBD_DescriptorsTypeDef FS_Desc;

/* USER CODE BEGIN EXPORTED_VARIABLES */

/* USER CODE END EXPORTED_VARIABLES */

/* USER CODE BEGIN EXPORTED_FUNCTIONS */

/* USER CODE END EXPORTED_FUNCTIONS */

#ifdef __cplusplus
}
#endif

#endif /* __USBD_DESC__C__ */
"#,
    );
    b.into_string()
}

fn usbd_desc_c(ctx: &GenCtx<'_>, cfg: &UsbDeviceCfg) -> String {
    let mut b = Buf::new();
    b.line(header(
        ctx,
        "usbd_desc.c",
        "This file implements the USB device descriptors.",
    ));
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"usbd_core.h\"");
    b.line("#include \"usbd_desc.h\"");
    b.line("#include \"usbd_conf.h\"");
    b.blank();
    b.user0("INCLUDE");
    b.blank();
    b.line("/* Private typedef -----------------------------------------------------------*/");
    b.line("/* Private define ------------------------------------------------------------*/");
    b.line("/* Private macro -------------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE BEGIN PV */");
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE END PV */");
    b.blank();
    // Parameterized define block — vid/pid emitted verbatim (hex strings
    // from the doc); the SERIALNUMBER string is deliberately ignored
    // (spec §4.2: CubeMX derives the serial from the 96-bit UID).
    b.line(format!("#define USBD_VID     {}", cfg.vid));
    b.line("#define USBD_LANGID_STRING     1033");
    b.line(format!(
        "#define USBD_MANUFACTURER_STRING     \"{}\"",
        cfg.manufacturer_string
    ));
    b.line(format!("#define USBD_PID_FS     {}", cfg.pid));
    b.line(format!(
        "#define USBD_PRODUCT_STRING_FS     \"{}\"",
        cfg.product_string
    ));
    b.line("#define USBD_CONFIGURATION_STRING_FS     \"CDC Config\"");
    b.line("#define USBD_INTERFACE_STRING_FS     \"CDC Interface\"");
    b.blank();
    b.line("#define USB_SIZ_BOS_DESC            0x0C");
    b.blank();
    b.user0("PRIVATE_DEFINES");
    b.blank();
    b.user0("0");
    b.blank();
    b.user0("PRIVATE_MACRO");
    b.blank();
    b.raw(
        r#"
static void Get_SerialNum(void);
static void IntToUnicode(uint32_t value, uint8_t * pbuf, uint8_t len);

uint8_t * USBD_FS_DeviceDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_LangIDStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_ManufacturerStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_ProductStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_SerialStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_ConfigStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
uint8_t * USBD_FS_InterfaceStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
#if (USBD_LPM_ENABLED == 1)
uint8_t * USBD_FS_USR_BOSDescriptor(USBD_SpeedTypeDef speed, uint16_t *length);
#endif /* (USBD_LPM_ENABLED == 1) */

USBD_DescriptorsTypeDef FS_Desc =
{
  USBD_FS_DeviceDescriptor
, USBD_FS_LangIDStrDescriptor
, USBD_FS_ManufacturerStrDescriptor
, USBD_FS_ProductStrDescriptor
, USBD_FS_SerialStrDescriptor
, USBD_FS_ConfigStrDescriptor
, USBD_FS_InterfaceStrDescriptor
#if (USBD_LPM_ENABLED == 1)
, USBD_FS_USR_BOSDescriptor
#endif /* (USBD_LPM_ENABLED == 1) */
};

#if defined ( __ICCARM__ ) /* IAR Compiler */
  #pragma data_alignment=4
#endif /* defined ( __ICCARM__ ) */
/** USB standard device descriptor. */
__ALIGN_BEGIN uint8_t USBD_FS_DeviceDesc[USB_LEN_DEV_DESC] __ALIGN_END =
{
  0x12,                       /*bLength */
  USB_DESC_TYPE_DEVICE,       /*bDescriptorType*/
#if (USBD_LPM_ENABLED == 1)
  0x01,                       /*bcdUSB */ /* changed to USB version 2.01
                                             in order to support LPM L1 suspend
                                             resume test of USBCV3.0*/
#else
  0x00,                       /*bcdUSB */
#endif /* (USBD_LPM_ENABLED == 1) */
  0x02,
  0x02,                       /*bDeviceClass*/
  0x02,                       /*bDeviceSubClass*/
  0x00,                       /*bDeviceProtocol*/
  USB_MAX_EP0_SIZE,           /*bMaxPacketSize*/
  LOBYTE(USBD_VID),           /*idVendor*/
  HIBYTE(USBD_VID),           /*idVendor*/
  LOBYTE(USBD_PID_FS),        /*idProduct*/
  HIBYTE(USBD_PID_FS),        /*idProduct*/
  0x00,                       /*bcdDevice rel. 2.00*/
  0x02,
  USBD_IDX_MFC_STR,           /*Index of manufacturer  string*/
  USBD_IDX_PRODUCT_STR,       /*Index of product string*/
  USBD_IDX_SERIAL_STR,        /*Index of serial number string*/
  USBD_MAX_NUM_CONFIGURATION  /*bNumConfigurations*/
};

/* USB_DeviceDescriptor */
/** BOS descriptor. */
#if (USBD_LPM_ENABLED == 1)
#if defined ( __ICCARM__ ) /* IAR Compiler */
  #pragma data_alignment=4
#endif /* defined ( __ICCARM__ ) */
__ALIGN_BEGIN uint8_t USBD_FS_BOSDesc[USB_SIZ_BOS_DESC] __ALIGN_END =
{
  0x5,
  USB_DESC_TYPE_BOS,
  0xC,
  0x0,
  0x1,  /* 1 device capability*/
        /* device capability*/
  0x7,
  USB_DEVICE_CAPABITY_TYPE,
  0x2,
  0x2,  /* LPM capability bit set*/
  0x0,
  0x0,
  0x0
};
#endif /* (USBD_LPM_ENABLED == 1) */

#if defined ( __ICCARM__ ) /* IAR Compiler */
  #pragma data_alignment=4
#endif /* defined ( __ICCARM__ ) */

/** USB lang identifier descriptor. */
__ALIGN_BEGIN uint8_t USBD_LangIDDesc[USB_LEN_LANGID_STR_DESC] __ALIGN_END =
{
     USB_LEN_LANGID_STR_DESC,
     USB_DESC_TYPE_STRING,
     LOBYTE(USBD_LANGID_STRING),
     HIBYTE(USBD_LANGID_STRING)
};

#if defined ( __ICCARM__ ) /* IAR Compiler */
  #pragma data_alignment=4
#endif /* defined ( __ICCARM__ ) */
/* Internal string descriptor. */
__ALIGN_BEGIN uint8_t USBD_StrDesc[USBD_MAX_STR_DESC_SIZ] __ALIGN_END;

#if defined ( __ICCARM__ ) /*!< IAR Compiler */
  #pragma data_alignment=4
#endif
__ALIGN_BEGIN uint8_t USBD_StringSerial[USB_SIZ_STRING_SERIAL] __ALIGN_END = {
  USB_SIZ_STRING_SERIAL,
  USB_DESC_TYPE_STRING,
};

/**
  * @brief  Return the device descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_DeviceDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  UNUSED(speed);
  *length = sizeof(USBD_FS_DeviceDesc);
  return USBD_FS_DeviceDesc;
}

/**
  * @brief  Return the LangID string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_LangIDStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  UNUSED(speed);
  *length = sizeof(USBD_LangIDDesc);
  return USBD_LangIDDesc;
}

/**
  * @brief  Return the product string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_ProductStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  if(speed == 0)
  {
    USBD_GetString((uint8_t *)USBD_PRODUCT_STRING_FS, USBD_StrDesc, length);
  }
  else
  {
    USBD_GetString((uint8_t *)USBD_PRODUCT_STRING_FS, USBD_StrDesc, length);
  }
  return USBD_StrDesc;
}

/**
  * @brief  Return the manufacturer string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_ManufacturerStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  UNUSED(speed);
  USBD_GetString((uint8_t *)USBD_MANUFACTURER_STRING, USBD_StrDesc, length);
  return USBD_StrDesc;
}

/**
  * @brief  Return the serial number string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_SerialStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  UNUSED(speed);
  *length = USB_SIZ_STRING_SERIAL;

  /* Update the serial number string descriptor with the data from the unique
   * ID */
  Get_SerialNum();
  /* USER CODE BEGIN USBD_FS_SerialStrDescriptor */

  /* USER CODE END USBD_FS_SerialStrDescriptor */
  return (uint8_t *) USBD_StringSerial;
}

/**
  * @brief  Return the configuration string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_ConfigStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  if(speed == USBD_SPEED_HIGH)
  {
    USBD_GetString((uint8_t *)USBD_CONFIGURATION_STRING_FS, USBD_StrDesc, length);
  }
  else
  {
    USBD_GetString((uint8_t *)USBD_CONFIGURATION_STRING_FS, USBD_StrDesc, length);
  }
  return USBD_StrDesc;
}

/**
  * @brief  Return the interface string descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_InterfaceStrDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  if(speed == 0)
  {
    USBD_GetString((uint8_t *)USBD_INTERFACE_STRING_FS, USBD_StrDesc, length);
  }
  else
  {
    USBD_GetString((uint8_t *)USBD_INTERFACE_STRING_FS, USBD_StrDesc, length);
  }
  return USBD_StrDesc;
}

#if (USBD_LPM_ENABLED == 1)
/**
  * @brief  Return the BOS descriptor
  * @param  speed : Current device speed
  * @param  length : Pointer to data length variable
  * @retval Pointer to descriptor buffer
  */
uint8_t * USBD_FS_USR_BOSDescriptor(USBD_SpeedTypeDef speed, uint16_t *length)
{
  UNUSED(speed);
  *length = sizeof(USBD_FS_BOSDesc);
  return (uint8_t*)USBD_FS_BOSDesc;
}
#endif /* (USBD_LPM_ENABLED == 1) */

/**
  * @brief  Create the serial number string descriptor
  * @param  None
  * @retval None
  */
static void Get_SerialNum(void)
{
  uint32_t deviceserial0;
  uint32_t deviceserial1;
  uint32_t deviceserial2;

  deviceserial0 = *(uint32_t *) DEVICE_ID1;
  deviceserial1 = *(uint32_t *) DEVICE_ID2;
  deviceserial2 = *(uint32_t *) DEVICE_ID3;

  deviceserial0 += deviceserial2;

  if (deviceserial0 != 0)
  {
    IntToUnicode(deviceserial0, &USBD_StringSerial[2], 8);
    IntToUnicode(deviceserial1, &USBD_StringSerial[18], 4);
  }
}

/**
  * @brief  Convert Hex 32Bits value into char
  * @param  value: value to convert
  * @param  pbuf: pointer to the buffer
  * @param  len: buffer length
  * @retval None
  */
static void IntToUnicode(uint32_t value, uint8_t * pbuf, uint8_t len)
{
  uint8_t idx = 0;

  for (idx = 0; idx < len; idx++)
  {
    if (((value >> 28)) < 0xA)
    {
      pbuf[2 * idx] = (value >> 28) + '0';
    }
    else
    {
      pbuf[2 * idx] = (value >> 28) + 'A' - 10;
    }

    value = value << 4;

    pbuf[2 * idx + 1] = 0;
  }
}
"#,
    );
    b.into_string()
}

// ---------------------------------------------------------------------------
// Core/Inc/usbd_cdc_if.h + Core/Src/usbd_cdc_if.c (spec §4.4)
// ---------------------------------------------------------------------------

fn usbd_cdc_if_h(ctx: &GenCtx<'_>, cfg: &UsbDeviceCfg) -> String {
    let mut b = Buf::new();
    b.line(header(ctx, "usbd_cdc_if.h", "Header for usbd_cdc_if.c file."));
    b.blank();
    b.line("/* Define to prevent recursive inclusion -------------------------------------*/");
    b.blank();
    b.line("#ifndef __USBD_CDC_IF_H__");
    b.line("#define __USBD_CDC_IF_H__");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line(" extern \"C\" {");
    b.line("#endif");
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"usbd_cdc.h\"");
    b.blank();
    b.user0("INCLUDE");
    b.blank();
    b.line("/* Define size for the receive and transmit buffer over CDC */");
    b.line(format!("#define APP_RX_DATA_SIZE  {}", cfg.app_rx_data_size));
    b.line(format!("#define APP_TX_DATA_SIZE  {}", cfg.app_tx_data_size));
    b.user0("EXPORTED_DEFINES");
    b.blank();
    b.user0("EXPORTED_TYPES");
    b.blank();
    b.user0("EXPORTED_MACRO");
    b.blank();
    b.line("/** CDC Interface callback. */");
    b.line("extern USBD_CDC_ItfTypeDef USBD_Interface_fops_FS;");
    b.blank();
    b.user0("EXPORTED_VARIABLES");
    b.blank();
    b.line("uint8_t CDC_Transmit_FS(uint8_t* Buf, uint16_t Len);");
    b.blank();
    b.user0("EXPORTED_FUNCTIONS");
    b.blank();
    b.line("#ifdef __cplusplus");
    b.line("}");
    b.line("#endif");
    b.blank();
    b.line("#endif /* __USBD_CDC_IF_H__ */");
    b.into_string()
}

fn usbd_cdc_if_c(ctx: &GenCtx<'_>) -> String {
    let mut b = Buf::new();
    b.line(header(ctx, "usbd_cdc_if.c", "Usb device for Virtual Com Port."));
    b.blank();
    b.line("/* Includes ------------------------------------------------------------------*/");
    b.line("#include \"usbd_cdc_if.h\"");
    b.blank();
    b.user0("INCLUDE");
    b.blank();
    b.line("/* Private typedef -----------------------------------------------------------*/");
    b.line("/* Private define ------------------------------------------------------------*/");
    b.line("/* Private macro -------------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE BEGIN PV */");
    b.line("/* Private variables ---------------------------------------------------------*/");
    b.blank();
    b.line("/* USER CODE END PV */");
    b.blank();
    b.line("/* USER CODE BEGIN PRIVATE_DEFINES */");
    b.line("/* USER CODE END PRIVATE_DEFINES */");
    b.blank();
    b.user0("PRIVATE_MACRO");
    b.blank();
    b.raw(
        r#"
/* Create buffer for reception and transmission           */
/* It's up to user to redefine and/or remove those define */
/** Received data over USB are stored in this buffer      */
uint8_t UserRxBufferFS[APP_RX_DATA_SIZE];

/** Data to send over USB CDC are stored in this buffer   */
uint8_t UserTxBufferFS[APP_TX_DATA_SIZE];

/* USER CODE BEGIN PRIVATE_VARIABLES */

/* USER CODE END PRIVATE_VARIABLES */

extern USBD_HandleTypeDef hUsbDeviceFS;

/* USER CODE BEGIN EXPORTED_VARIABLES */

/* USER CODE END EXPORTED_VARIABLES */

static int8_t CDC_Init_FS(void);
static int8_t CDC_DeInit_FS(void);
static int8_t CDC_Control_FS(uint8_t cmd, uint8_t* pbuf, uint16_t length);
static int8_t CDC_Receive_FS(uint8_t* pbuf, uint32_t *Len);
static int8_t CDC_TransmitCplt_FS(uint8_t *pbuf, uint32_t *Len, uint8_t epnum);

/* USER CODE BEGIN PRIVATE_FUNCTIONS_DECLARATION */

/* USER CODE END PRIVATE_FUNCTIONS_DECLARATION */

USBD_CDC_ItfTypeDef USBD_Interface_fops_FS =
{
  CDC_Init_FS,
  CDC_DeInit_FS,
  CDC_Control_FS,
  CDC_Receive_FS,
  CDC_TransmitCplt_FS
};

/* Private functions ---------------------------------------------------------*/
/**
  * @brief  Initializes the CDC media low layer over the FS USB IP
  * @retval USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Init_FS(void)
{
  /* USER CODE BEGIN 3 */
  /* Set Application Buffers */
  USBD_CDC_SetTxBuffer(&hUsbDeviceFS, UserTxBufferFS, 0);
  USBD_CDC_SetRxBuffer(&hUsbDeviceFS, UserRxBufferFS);
  return (USBD_OK);
  /* USER CODE END 3 */
}

/**
  * @brief  DeInitializes the CDC media low layer
  * @retval USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_DeInit_FS(void)
{
  /* USER CODE BEGIN 4 */
  return (USBD_OK);
  /* USER CODE END 4 */
}

/**
  * @brief  Manage the CDC class requests
  * @param  cmd: Command code
  * @param  pbuf: Buffer containing command data (request parameters)
  * @param  length: Number of data to be sent (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Control_FS(uint8_t cmd, uint8_t* pbuf, uint16_t length)
{
  /* USER CODE BEGIN 5 */
  switch(cmd)
  {
    case CDC_SEND_ENCAPSULATED_COMMAND:

    break;

    case CDC_GET_ENCAPSULATED_RESPONSE:

    break;

    case CDC_SET_COMM_FEATURE:

    break;

    case CDC_GET_COMM_FEATURE:

    break;

    case CDC_CLEAR_COMM_FEATURE:

    break;

  /*******************************************************************************/
  /* Line Coding Structure                                                       */
  /*-----------------------------------------------------------------------------*/
  /* Offset | Field       | Size | Value  | Description                          */
  /* 0      | dwDTERate   |   4  | Number |Data terminal rate, in bits per second*/
  /* 4      | bCharFormat |   1  | Number | Stop bits                            */
  /*                                        0 - 1 Stop bit                       */
  /*                                        1 - 1.5 Stop bits                    */
  /*                                        2 - 2 Stop bits                      */
  /* 5      | bParityType |  1   | Number | Parity                               */
  /*                                        0 - None                             */
  /*                                        1 - Odd                              */
  /*                                        2 - Even                             */
  /*                                        3 - Mark                             */
  /*                                        4 - Space                            */
  /* 6      | bDataBits  |   1   | Number Data bits (5, 6, 7, 8 or 16).          */
  /*******************************************************************************/
    case CDC_SET_LINE_CODING:

    break;

    case CDC_GET_LINE_CODING:

    break;

    case CDC_SET_CONTROL_LINE_STATE:

    break;

    case CDC_SEND_BREAK:

    break;

  default:
    break;
  }

  return (USBD_OK);
  /* USER CODE END 5 */
}

/**
  * @brief  Data received over USB OUT endpoint are sent over CDC interface
  *         through this function.
  *
  *         @note
  *         This function will issue a NAK packet on any OUT packet received on
  *         USB endpoint until exiting this function. If you exit this function
  *         before transfer is complete on CDC interface (ie. using DMA controller)
  *         it will result in receiving more data while previous ones are still
  *         not sent.
  *
  * @param  Buf: Buffer of data to be received
  * @param  Len: Number of data received (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_Receive_FS(uint8_t* Buf, uint32_t *Len)
{
  /* USER CODE BEGIN 6 */
  USBD_CDC_SetRxBuffer(&hUsbDeviceFS, &Buf[0]);
  USBD_CDC_ReceivePacket(&hUsbDeviceFS);
  return (USBD_OK);
  /* USER CODE END 6 */
}

/**
  * @brief  CDC_Transmit_FS
  *         Data to send over USB IN endpoint are sent over CDC interface
  *         through this function.
  *         @note
  *
  *
  * @param  Buf: Buffer of data to be sent
  * @param  Len: Number of data to be sent (in bytes)
  * @retval USBD_OK if all operations are OK else USBD_FAIL or USBD_BUSY
  */
uint8_t CDC_Transmit_FS(uint8_t* Buf, uint16_t Len)
{
  uint8_t result = USBD_OK;
  /* USER CODE BEGIN 7 */
  USBD_CDC_HandleTypeDef *hcdc = (USBD_CDC_HandleTypeDef*)hUsbDeviceFS.pClassData;
  if (hcdc->TxState != 0){
    return USBD_BUSY;
  }
  USBD_CDC_SetTxBuffer(&hUsbDeviceFS, Buf, Len);
  result = USBD_CDC_TransmitPacket(&hUsbDeviceFS);
  /* USER CODE END 7 */
  return result;
}

/**
  * @brief  CDC_TransmitCplt_FS
  *         Data transmitted callback
  *
  *         @note
  *         This function is IN transfer complete callback used to inform user that
  *         the submitted Data is successfully sent over USB.
  *
  * @param  Buf: Buffer of data to be received
  * @param  Len: Number of data received (in bytes)
  * @retval Result of the operation: USBD_OK if all operations are OK else USBD_FAIL
  */
static int8_t CDC_TransmitCplt_FS(uint8_t *Buf, uint32_t *Len, uint8_t epnum)
{
  uint8_t result = USBD_OK;
  /* USER CODE BEGIN 13 */
  UNUSED(Buf);
  UNUSED(Len);
  UNUSED(epnum);
  /* USER CODE END 13 */
  return result;
}

/* USER CODE BEGIN PRIVATE_FUNCTIONS_IMPLEMENTATION */

/* USER CODE END PRIVATE_FUNCTIONS_IMPLEMENTATION */
"#,
    );
    b.into_string()
}

// ---------------------------------------------------------------------------
// Trait implementation
// ---------------------------------------------------------------------------

impl MiddlewareGen for UsbCdcGen {
    fn name(&self) -> &'static str {
        "usb_device_cdc"
    }

    fn applies(&self, ctx: &GenCtx<'_>) -> bool {
        ctx.doc
            .middleware
            .as_ref()
            .is_some_and(|m| m.usb_device.is_some())
    }

    fn files(&self, ctx: &GenCtx<'_>) -> anyhow::Result<Vec<GeneratedFile>> {
        if !ready(ctx) {
            return Ok(Vec::new()); // misconfigured: emit nothing (see diagnostics)
        }
        let cfg = usb_cfg(ctx).expect("ready() checked");
        let p = usb_periph(ctx).expect("ready() checked");
        let gf = |rel: &str, content: String| GeneratedFile {
            rel_path: rel.to_string(),
            content,
        };
        Ok(vec![
            gf("Core/Inc/usb_device.h", usb_device_h(ctx)),
            gf("Core/Src/usb_device.c", usb_device_c(ctx)),
            gf("Core/Inc/usbd_conf.h", usbd_conf_h(ctx)),
            gf("Core/Src/usbd_conf.c", usbd_conf_c(ctx, p)),
            gf("Core/Inc/usbd_desc.h", usbd_desc_h(ctx)),
            gf("Core/Src/usbd_desc.c", usbd_desc_c(ctx, cfg)),
            gf("Core/Inc/usbd_cdc_if.h", usbd_cdc_if_h(ctx, cfg)),
            gf("Core/Src/usbd_cdc_if.c", usbd_cdc_if_c(ctx)),
        ])
    }

    /// The PCD is owned by the USB Device stack (module docs): suppress the
    /// core emitter's per-IP surfaces for USB_OTG_FS. Only when generation
    /// is actually ready — a misconfigured middleware must not silently
    /// swallow the core PCD init it would otherwise get.
    fn owned_instances(&self, ctx: &GenCtx<'_>) -> Vec<String> {
        if ready(ctx) {
            vec![USB_INSTANCE.to_string()]
        } else {
            Vec::new()
        }
    }

    fn cmake(&self, ctx: &GenCtx<'_>) -> CmakeAdditions {
        if !ready(ctx) {
            return CmakeAdditions::default();
        }
        const LIB: &str = "Middlewares/ST/STM32_USB_Device_Library";
        CmakeAdditions {
            sources: vec![
                "Core/Src/usb_device.c".into(),
                "Core/Src/usbd_conf.c".into(),
                "Core/Src/usbd_desc.c".into(),
                "Core/Src/usbd_cdc_if.c".into(),
                format!("{LIB}/Core/Src/usbd_core.c"),
                format!("{LIB}/Core/Src/usbd_ctlreq.c"),
                format!("{LIB}/Core/Src/usbd_ioreq.c"),
                format!("{LIB}/Class/CDC/Src/usbd_cdc.c"),
            ],
            includes: vec![
                format!("{LIB}/Core/Inc"),
                format!("{LIB}/Class/CDC/Inc"),
            ],
            defines: Vec::new(), // no USE_USB_FS in the CMake flow (spec §4.5)
        }
    }

    // hal_conf_defines: default (empty). HAL_PCD_MODULE_ENABLED and
    // USE_HAL_PCD_REGISTER_CALLBACKS 0U flow from the USB_OTG_FS
    // peripheral's HalMode="PCD" through the P1 hal-module machinery
    // (emit.rs::hal_conf_h); adding them here would double-define.

    fn main_hooks(&self, ctx: &GenCtx<'_>) -> MainHooks {
        if !ready(ctx) {
            return MainHooks::default();
        }
        let mut hooks = MainHooks {
            // main.c includes usb_device.h whether or not FreeRTOS defers
            // the init call to the default task (spec §1.3).
            includes: vec!["usb_device.h".to_string()],
            ..MainHooks::default()
        };
        // Standalone (no RTOS): CubeMX calls MX_USB_DEVICE_Init from
        // main(). With FreeRTOS present the call moves into
        // StartDefaultTask (P5's side of the handshake, spec §4.5).
        if !freertos_present(ctx) {
            hooks.post_init_calls.push("  MX_USB_DEVICE_Init();".to_string());
        }
        hooks
    }

    fn it_hooks(&self, ctx: &GenCtx<'_>) -> Vec<ItHandler> {
        if !ready(ctx) || core_owns_usb_irq(ctx) {
            // core_owns_usb_irq: the doc enabled OTG_FS_IRQn with handler
            // generation on — the core it.c already defines the function;
            // adding ours would redefine it (diagnosed, not duplicated).
            return Vec::new();
        }
        vec![ItHandler {
            irqn: USB_IRQN.to_string(),
            brief: "USB On The Go FS global interrupt.".to_string(),
            body: vec!["HAL_PCD_IRQHandler(&hpcd_USB_OTG_FS);".to_string()],
            externs: vec!["PCD_HandleTypeDef hpcd_USB_OTG_FS".to_string()],
        }]
    }

    fn copy_sources(
        &self,
        ctx: &GenCtx<'_>,
        fw: &Path,
        out: &Path,
    ) -> anyhow::Result<Vec<String>> {
        if !ready(ctx) {
            return Ok(Vec::new());
        }
        let src_root = fw.join("MW").join("USB_Device");
        anyhow::ensure!(
            src_root.is_dir(),
            "USB Device Library payload not found under {} (expected data/fw/MW/USB_Device)",
            src_root.display()
        );
        const DEST_ROOT: &str = "Middlewares/ST/STM32_USB_Device_Library";
        // Exactly the files CubeMX copies for CDC (mine-usb Q5).
        const FILES: [&str; 9] = [
            "Core/Inc/usbd_core.h",
            "Core/Inc/usbd_ctlreq.h",
            "Core/Inc/usbd_def.h",
            "Core/Inc/usbd_ioreq.h",
            "Core/Src/usbd_core.c",
            "Core/Src/usbd_ctlreq.c",
            "Core/Src/usbd_ioreq.c",
            "Class/CDC/Inc/usbd_cdc.h",
            "Class/CDC/Src/usbd_cdc.c",
        ];
        let mut copied = Vec::new();
        for rel in FILES {
            let from = src_root.join(rel);
            anyhow::ensure!(
                from.is_file(),
                "USB Device Library file missing: {}",
                from.display()
            );
            let dest_rel = format!("{DEST_ROOT}/{rel}");
            let dest = out.join(&dest_rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &dest)?;
            copied.push(dest_rel);
        }
        // License file ships alongside (v2.11.6 carries LICENSE.md).
        for lic in ["LICENSE.txt", "LICENSE.md"] {
            let from = src_root.join(lic);
            if from.is_file() {
                let dest_rel = format!("{DEST_ROOT}/{lic}");
                std::fs::copy(&from, out.join(&dest_rel))?;
                copied.push(dest_rel);
                break;
            }
        }
        copied.sort();
        Ok(copied)
    }

    fn diagnostics(&self, ctx: &GenCtx<'_>) -> Vec<Diagnostic> {
        let Some(cfg) = usb_cfg(ctx) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if !cfg.class.eq_ignore_ascii_case("CDC") {
            out.push(Diagnostic::error(
                "USB_CLASS_UNSUPPORTED",
                "/middleware/usbDevice/class",
                format!("USB device class `{}` is not supported (v1: CDC only)", cfg.class),
            ));
        }
        if !usb_periph(ctx).is_some_and(|p| p.hal_mode.as_deref() == Some("PCD")) {
            out.push(Diagnostic::error(
                "USB_PERIPH_MISSING",
                "/middleware/usbDevice",
                "middleware.usbDevice requires peripherals.USB_OTG_FS with mode \
                 \"Device_Only\"; no USB code was generated",
            ));
        }
        if ready(ctx) && core_owns_usb_irq(ctx) {
            out.push(Diagnostic::warning(
                "USB_IRQ_HANDLER_CONFLICT",
                "/peripherals/USB_OTG_FS/interrupts/OTG_FS_IRQn",
                "OTG_FS_IRQn has generateHandler enabled: the core it.c owns the \
                 handler and dispatches the core `hpcd` handle instead of the USB \
                 stack's hpcd_USB_OTG_FS — set generateHandler:false (the USB \
                 middleware provides the handler)",
            ));
        }
        out
    }
}
