//! The user-facing configuration document — the single source of truth a
//! yoma/AI layer writes and the kernel validates (design §10). Serialized
//! as JSON; field names are camelCase on the wire.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigDoc {
    pub schema_version: u32,
    pub mcu: McuRef,
    #[serde(default)]
    pub power: Power,
    #[serde(default)]
    pub clock: ClockCfg,
    /// Peripheral instance name ("USART1") -> its configuration.
    #[serde(default)]
    pub peripherals: BTreeMap<String, PeriphCfg>,
    /// Plain GPIO pins: pad name ("PC13") -> pin config.
    #[serde(default)]
    pub gpio: BTreeMap<String, GpioPinCfg>,
    #[serde(default)]
    pub debug: DebugCfg,
    /// Fine-grained NVIC: priority grouping + Cortex system-handler
    /// priorities.
    // Origin: plan §P4 补充缺口.
    #[serde(default)]
    pub nvic: NvicDocCfg,
    /// Middleware stacks (FreeRTOS, USB Device...).
    // Generation is owned by `stm32ck-codegen::middleware`; the engine only
    // validates the shapes and the couplings they force (NVIC grouping,
    // timebase, USB clock).
    #[serde(default)]
    pub middleware: Option<MiddlewareCfg>,
    #[serde(default)]
    pub project: ProjectCfg,
}

/// Top-level NVIC document section.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NvicDocCfg {
    /// "NVIC_PRIORITYGROUP_0".."_4". None = HAL default GROUP_4; a
    /// non-default value emits HAL_NVIC_SetPriorityGrouping right after
    /// HAL_Init().
    // GROUP_4 is what HAL_Init itself sets; the grouping call lands in
    // main.c.
    #[serde(default)]
    pub priority_group: Option<String>,
    /// Cortex system handlers ("PendSV", "SysTick", "SVCall", faults...) ->
    /// priority config, emitted in HAL_MspInit (SVCall/SysTick get no
    /// SetPriority call — CubeMX quirk).
    // Lands where CubeMX puts it: `HAL_MspInit()`'s "System interrupt init"
    // block; the SVCall/SysTick skip is mine spec §2.5.
    #[serde(default)]
    pub system_handlers: BTreeMap<String, NvicCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McuRef {
    /// Sales part number ("STM32F103C8Tx") or db RefName group.
    pub part: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Power {
    /// Supply voltage in millivolts (db conditions compare volts).
    pub vdd_mv: u32,
}

impl Default for Power {
    fn default() -> Self {
        Self { vdd_mv: 3300 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockCfg {
    /// "HSE" / "LSE" -> source description. HSI/LSI need no declaration.
    #[serde(default)]
    pub sources: BTreeMap<String, ClockSource>,
    /// Target name (element id, RefParameter name, or shorthand like
    /// "SYSCLK") -> requested frequency; solved by solve-clock.
    #[serde(default)]
    pub targets: BTreeMap<String, ClockTarget>,
    /// Explicit clock-tree parameter assignments (mux selectors, dividers,
    /// multipliers): "SYSCLKSource" -> "RCC_SYSCLKSOURCE_PLLCLK",
    /// "PLLMUL" -> "RCC_PLL_MUL9", "PLLN" -> 336.
    #[serde(default)]
    pub assignments: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockSource {
    pub kind: ClockSourceKind,
    pub freq_hz: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ClockSourceKind {
    Crystal,
    Bypass,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockTarget {
    pub hz: u64,
    #[serde(default)]
    pub kind: ClockTargetKind,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ClockTargetKind {
    #[default]
    Exact,
    AtMost,
    AtLeast,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeriphCfg {
    /// Leaf mode name(s) from the IP's mode tree ("Asynchronous";
    /// USART flow control is a second concurrent mode: ["Asynchronous",
    /// "CTS_Only"]).
    #[serde(default)]
    pub mode: ModeSel,
    /// IP parameter overrides: "BaudRate" -> 115200,
    /// "WordLength" -> "WORDLENGTH_8B". Unset params take db defaults.
    /// Channel/mode-scoped params take a suffix: "-CH<n>" binds a channel
    /// ("OCMode_PWM-CH1"), "-<RefMode>" binds a named config block
    /// ("Mode-Asynchronous").
    #[serde(default)]
    pub params: BTreeMap<String, serde_json::Value>,
    /// Signal pin hints: short signal name -> pad ("TX" -> "PA9").
    /// Unhinted signals are auto-placed deterministically.
    #[serde(default)]
    pub pins: BTreeMap<String, String>,
    #[serde(default)]
    pub nvic: Option<NvicCfg>,
    /// DMA requests, keyed by the FULL db request name ("UART4_RX",
    /// "SPI3_TX"; whole-instance requests use the bare instance name,
    /// "ADC1").
    // Bare-instance-name keying: plan §P3 补充缺口 decision.
    #[serde(default)]
    pub dma: BTreeMap<String, DmaReqCfg>,
    /// Per-vector NVIC for multi-vector IPs: IRQn name ("CAN1_TX_IRQn") ->
    /// config. Wins over `nvic` (the one-vector shorthand) for that vector;
    /// vectors must belong to this instance.
    // Multi-vector examples: CAN's TX/RX0/RX1/SCE, TIM's shared vectors.
    #[serde(default)]
    pub interrupts: BTreeMap<String, NvicCfg>,
}

/// One DMA request. The db pins most HAL_DMA_Init fields per request;
/// these optional overrides mirror the ioc `Dma.<REQ>.<n>.*` keys and
/// win over db defaults.
// The db RefMode single-pins Direction, PeriphInc, the F4 Channel per
// request; overrides never beat single-pinned values.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DmaReqCfg {
    /// Explicit stream/channel ("DMA1_Stream2" / F1 "DMA1_Channel7").
    /// None = auto-pick first free compatible flow.
    // Auto-pick scans in (controller, stream) order.
    #[serde(default)]
    pub instance: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub periph_inc: Option<String>,
    #[serde(default)]
    pub mem_inc: Option<String>,
    #[serde(default)]
    pub periph_data_alignment: Option<String>,
    #[serde(default)]
    pub mem_data_alignment: Option<String>,
    /// DMA_NORMAL / DMA_CIRCULAR / DMA_PFCTRL.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub fifo_mode: Option<String>,
    /// Stream IRQ enable + priorities. None = enabled at (0,0), matching
    /// CubeMX.
    // CubeMX forces DMA vectors on whenever a request is added.
    #[serde(default)]
    pub nvic: Option<NvicCfg>,
    /// DEPRECATED alias for `nvic.generateHandler` (v1 documents); that
    /// field wins when both are set.
    // Effective value: nvic.generateHandler, else this, else true. Emits
    // the DMAx_Streamn_IRQHandler in it.c calling HAL_DMA_IRQHandler;
    // separable from nvic.enabled (the ODrive reference NVIC-enables
    // DMA2_Stream0 but generates no handler).
    #[serde(default)]
    pub generate_handler: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ModeSel {
    One(String),
    Many(Vec<String>),
}

impl Default for ModeSel {
    fn default() -> Self {
        ModeSel::Many(Vec::new())
    }
}

impl ModeSel {
    pub fn as_vec(&self) -> Vec<String> {
        match self {
            ModeSel::One(s) => vec![s.clone()],
            ModeSel::Many(v) => v.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NvicCfg {
    pub enabled: bool,
    #[serde(default)]
    pub preemption_priority: u32,
    #[serde(default)]
    pub sub_priority: u32,
    /// Emit the `<IRQn>Handler` function in it.c. None = true. `false`
    /// keeps HAL_NVIC_SetPriority/EnableIRQ in MspInit but emits no
    /// handler (vector falls to Default_Handler unless provided
    /// elsewhere).
    // CubeMX NVIC checkbox column 3, mine-core Q3. Handler-less enabled
    // vectors in the wild: ODrive's TIM1_UP_TIM10 / TIM8_UP_TIM13 /
    // DMA2_Stream0.
    #[serde(default)]
    pub generate_handler: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpioPinCfg {
    pub mode: GpioMode,
    #[serde(default)]
    pub pull: GpioPull,
    #[serde(default)]
    pub speed: GpioSpeed,
    /// Output only: initial level high.
    #[serde(default)]
    pub init_high: bool,
    /// Output only: open drain instead of push-pull.
    #[serde(default)]
    pub open_drain: bool,
    /// EXTI only: trigger edge.
    #[serde(default)]
    pub trigger: ExtiTrigger,
    /// EXTI only: NVIC enable + priorities for the pin's EXTI vector.
    #[serde(default)]
    pub nvic: Option<NvicCfg>,
    /// User label emitted as a #define in main.h.
    #[serde(default)]
    pub label: Option<String>,
    /// Pin stacking whitelist: full signal names allowed to co-occupy this
    /// pad ("UART4_TX"). The functional (AF) signal owns the merged GPIO
    /// config; analog signals share implicitly. Double-booking without a
    /// whitelist is PIN_CONFLICT.
    // Origin: mine-core Q5, plan §P4. The pad carries ONE shared GPIO
    // config — the AF signal's io settings merged with this entry's
    // pull/label — and gpio.c emits nothing for it; analog (ADCx_INn)
    // pads never need the whitelist.
    #[serde(default)]
    pub shared_with: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GpioMode {
    Input,
    Output,
    Analog,
    Exti,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GpioPull {
    #[default]
    None,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GpioSpeed {
    #[default]
    Low,
    Medium,
    High,
    VeryHigh,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExtiTrigger {
    #[default]
    Rising,
    Falling,
    Both,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DebugCfg {
    #[default]
    Swd,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCfg {
    #[serde(default = "default_project_name")]
    pub name: String,
    /// Linker: minimum heap/stack (C-style hex or decimal string).
    #[serde(default = "default_heap")]
    pub min_heap_size: String,
    #[serde(default = "default_stack")]
    pub min_stack_size: String,
    /// User constants: name -> C expression, emitted as `#define`s in
    /// main.h; peripheral params may reference the names as opaque
    /// symbolic values.
    // The ioc's `Mcu.UserConstants` mechanism — ODrive's
    // `TIM_1_8_PERIOD_CLOCKS`.
    #[serde(default)]
    pub user_constants: BTreeMap<String, String>,
    /// HAL timebase timer ("TIM14") instead of SysTick; the named timer is
    /// reserved — also configuring it under `peripherals` is an error.
    /// Recommended with FreeRTOS.
    // Generates Core/Src/<fam>_hal_timebase_tim.c, the shared-vector it.c
    // handler, TICK_INT_PRIORITY 0U, and HAL_TIM_PeriodElapsedCallback in
    // main.c; the double-configuration error is TIMEBASE_CONFLICT.
    #[serde(default)]
    pub hal_timebase: Option<String>,
    /// Override of the `MX_*_Init` call order in main() (instance names).
    /// GPIO/DMA always first; unlisted configured instances append in
    /// sorted order; unknown names diagnose.
    // e.g. ["ADC1","CAN1","TIM1"]; unknown names -> INIT_ORDER_UNKNOWN;
    // empty = deterministic instance-sorted order.
    #[serde(default)]
    pub init_order: Vec<String>,
}

impl Default for ProjectCfg {
    fn default() -> Self {
        Self {
            name: default_project_name(),
            min_heap_size: default_heap(),
            min_stack_size: default_stack(),
            user_constants: BTreeMap::new(),
            hal_timebase: None,
            init_order: Vec::new(),
        }
    }
}

fn default_project_name() -> String {
    "app".to_string()
}
fn default_heap() -> String {
    "0x200".to_string()
}
fn default_stack() -> String {
    "0x400".to_string()
}

// ---------------------------------------------------------------------------
// Middleware (frozen contract for the P5/P6 generators)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MiddlewareCfg {
    #[serde(default)]
    pub freertos: Option<FreertosCfg>,
    #[serde(default)]
    pub usb_device: Option<UsbDeviceCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FreertosCfg {
    /// "CMSIS_V1" | "CMSIS_V2".
    #[serde(default = "default_rtos_api")]
    pub api: String,
    /// configTOTAL_HEAP_SIZE in bytes.
    #[serde(default = "default_rtos_heap")]
    pub heap_size: u32,
    #[serde(default)]
    pub tasks: Vec<RtosTask>,
    /// Raw FreeRTOSConfig knobs (configUSE_IDLE_HOOK, INCLUDE_* ...) merged
    /// over the generator's defaults; values are emitted as-is.
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RtosTask {
    pub name: String,
    /// osPriority as ioc integer offset (0 = osPriorityNormal).
    #[serde(default)]
    pub priority: i32,
    /// Stack size in WORDS (ioc convention).
    pub stack_size: u32,
    pub entry_function: String,
    /// "Default" (weak fn with USER CODE) | "As external" | "As weak".
    #[serde(default = "default_task_codegen")]
    pub code_generation: String,
    #[serde(default = "default_null")]
    pub parameter: String,
    /// "Dynamic" | "Static".
    #[serde(default = "default_task_alloc")]
    pub allocation: String,
    #[serde(default = "default_null")]
    pub buffer: String,
    #[serde(default = "default_null")]
    pub control_block: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsbDeviceCfg {
    /// Device class: v1 supports "CDC".
    pub class: String,
    #[serde(default = "default_vid")]
    pub vid: String,
    #[serde(default = "default_pid")]
    pub pid: String,
    #[serde(default = "default_mfg")]
    pub manufacturer_string: String,
    #[serde(default = "default_prod")]
    pub product_string: String,
    /// Ignored for CubeMX parity: serial derives from the 96-bit UID.
    // middleware-gen-spec §4; the field is kept for ioc doc fidelity.
    #[serde(default)]
    pub serial_number_string: Option<String>,
    #[serde(default = "default_usb_buf")]
    pub app_rx_data_size: u32,
    #[serde(default = "default_usb_buf")]
    pub app_tx_data_size: u32,
}

fn default_rtos_api() -> String {
    "CMSIS_V1".to_string()
}
fn default_rtos_heap() -> u32 {
    15360
}
fn default_task_codegen() -> String {
    "Default".to_string()
}
fn default_task_alloc() -> String {
    "Dynamic".to_string()
}
fn default_null() -> String {
    "NULL".to_string()
}
fn default_vid() -> String {
    "0x0483".to_string()
}
fn default_pid() -> String {
    "0x5740".to_string()
}
fn default_mfg() -> String {
    "STMicroelectronics".to_string()
}
fn default_prod() -> String {
    "STM32 Virtual ComPort".to_string()
}
fn default_usb_buf() -> u32 {
    64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_doc() {
        let doc: ConfigDoc = serde_json::from_str(
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
                  "nvic": { "enabled": true }
                }
              },
              "gpio": { "PC13": { "mode": "output", "initHigh": true, "label": "LED" } }
            }"#,
        )
        .unwrap();
        assert_eq!(doc.mcu.part, "STM32F103C8Tx");
        assert_eq!(doc.power.vdd_mv, 3300);
        assert_eq!(doc.peripherals["USART1"].mode.as_vec(), vec!["Asynchronous"]);
        assert_eq!(doc.gpio["PC13"].label.as_deref(), Some("LED"));
        assert!(doc.gpio["PC13"].init_high);
    }

    #[test]
    fn rejects_unknown_fields() {
        let r: Result<ConfigDoc, _> = serde_json::from_str(
            r#"{ "schemaVersion": 1, "mcu": { "part": "X" }, "typoField": 1 }"#,
        );
        assert!(r.is_err());
    }
}
