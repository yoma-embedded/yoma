//! IR data model — a normalized, semantics-preserving projection of the
//! CubeMX database. All ordered collections preserve *document order*
//! (CubeMX resolves same-name overloads first-match-wins), all keyed
//! collections use BTreeMap for deterministic iteration.

use crate::expr::{Condition, Num};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Pack root
// ---------------------------------------------------------------------------

/// One distributable IR pack, currently one per family (e.g. STM32F1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrPack {
    pub schema_version: u32,
    /// e.g. "STM32F1"
    pub family: String,
    /// CubeMX db version string this pack was imported from (package.xml).
    pub db_version: String,
    /// RefName -> part definition (one per part-number-group + package,
    /// e.g. "STM32F103C(8-B)Tx").
    pub parts: BTreeMap<String, Part>,
    /// GPIO IP version -> pin/AF tables. Keyed by `<IP Version=...>`.
    pub gpio: BTreeMap<String, GpioIp>,
    /// `{Name}-{Version}` -> peripheral/service IP definition
    /// (USART, ADC, RCC, NVIC, DMA, ... all share this shape).
    pub ips: BTreeMap<String, IpDef>,
    /// ClockTree id (Mcu@ClockTree, e.g. "STM32F102") -> clock DAG.
    pub clock_trees: BTreeMap<String, ClockTree>,
    /// NVIC vector tables parsed out of NVIC IP defs. Keyed like `ips`.
    pub nvic_vectors: BTreeMap<String, Vec<NvicVector>>,
    /// ConfigFile name (Mcu IP @ConfigFile, e.g. "UART-STM32F1xx") ->
    /// HAL call-tree definitions from db/mcu/config/*_Configs.xml.
    pub configs: BTreeMap<String, ConfigDef>,
    /// Memory-map id (the `db/mcu/memory/*.xml` file stem, e.g.
    /// "STM32_DIE450_864_2048") -> address map. Referenced by
    /// [`Part::memory_maps`]. Only families whose parts declare
    /// `<MemoryMap>Available` have entries; older ones (F1/F4) are absent
    /// and fall back to a single-region layout in codegen.
    pub memory_maps: BTreeMap<String, Vec<MemoryRegion>>,
}

/// One addressable on-chip memory, straight out of the db's rzone map.
/// Contiguous same-kind regions are already merged by the importer, the way
/// CubeMX presents them (H5's SRAM1+2+3 -> one 640K SRAM; H7's three AHB
/// SRAMs -> one 288K bank).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryRegion {
    /// Linker-safe name derived from the db's `name`/`info` ("RAM_AXI").
    pub name: String,
    pub start: u64,
    pub size_bytes: u64,
    pub kind: MemoryKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryKind {
    Ram,
    Rom,
}

// ---------------------------------------------------------------------------
// Part (per-package MCU XML)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub ref_name: String,
    pub family: String,
    pub line: String,
    pub package: String,
    pub clock_tree: String,
    pub die: String,
    pub core: String,
    pub max_freq_mhz: u32,
    /// KB, one entry per flash variant covered by this RefName group.
    pub flash_kb: Vec<u32>,
    pub ram_kb: Vec<u32>,
    /// Flash size (KB) -> key into [`IrPack::memory_maps`]. The db keys its
    /// address maps by die *and* memory sizes, so one RefName group spanning
    /// two flash variants resolves to two maps. Empty when the db ships no
    /// map for this part.
    pub memory_maps: BTreeMap<u32, String>,
    pub io_count: u32,
    /// Core-coupled memory in KB, when the db declares `<CCMRam>`.
    ///
    /// Counted *outside* `ram_kb` (an F407 is `<Ram>128</Ram>` plus
    /// `<CCMRam>64</CCMRam>`), and the only place the pre-rzone families
    /// declare it at all. The db gives no address — that is architectural,
    /// see `project::memory_block`.
    #[serde(default)]
    pub ccm_ram_kb: Option<u32>,
    pub voltage_mv: Option<(u32, u32)>,
    /// Concrete sales part numbers expanded from the RefName group,
    /// e.g. ["STM32F103C8Tx", "STM32F103CBTx"].
    pub part_numbers: Vec<String>,
    pub pins: Vec<Pin>,
    pub ip_instances: Vec<IpInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pin {
    /// Full pad name, e.g. "PA0-WKUP", "VBAT", "NRST".
    pub name: String,
    /// Package position; may be alphanumeric on BGA ("A1").
    pub position: String,
    pub kind: PinKind,
    pub signals: Vec<PinSignal>,
    /// Cross-pin mutual-exclusion constraints (rare; e.g. BZ#83533).
    pub conditions: Vec<DiagCondition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PinKind {
    Io,
    Power,
    Reset,
    Boot,
    MonoIo,
    Nc,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinSignal {
    /// `{IP_INSTANCE}_{FUNCTION}`, e.g. "USART1_TX"; "GPIO" for the
    /// GPIO capability itself.
    pub name: String,
    /// Only on the "GPIO" signal: allowed IO modes
    /// (Input, Output, Analog, EVENTOUT, EXTI).
    pub io_modes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpInstance {
    /// e.g. "USART1", "RCC", "NVIC".
    pub instance: String,
    /// Generic IP type name, e.g. "USART".
    pub name: String,
    /// Versioned IP definition; `{name}-{version}` keys `IrPack::ips`.
    pub version: String,
    /// Optional codegen config key into `IrPack::configs`.
    pub config_file: Option<String>,
    /// HAL clock-enable macro name(s); "none" in the db becomes empty.
    pub clock_enable: Vec<String>,
}

/// Condition + human diagnostic, everywhere CubeMX pairs them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagCondition {
    pub condition: Condition,
    pub diagnostic: String,
}

// ---------------------------------------------------------------------------
// GPIO IP (AF numbers / F1 remap groups + electrical presets)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioIp {
    pub version: String,
    /// Electrical parameter definitions (GPIO_Mode, GPIO_PuPd, GPIO_Speed,
    /// GPIO_ModeDefaultPP, ...), document order.
    pub ref_parameters: Vec<RefParameter>,
    /// IO-mode presets (AlternateFunctionPushPull, Input, EXTI, ...).
    pub ref_modes: Vec<RefMode>,
    /// Pin name (e.g. "PA9", may carry suffixes "PA0-WKUP") -> per-pin data.
    pub pins: BTreeMap<String, GpioPin>,
    /// Port name ("PA") -> port-level data (RCC clock-enable macro).
    pub ports: BTreeMap<String, GpioPort>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioPort {
    pub name: String,
    /// e.g. "__HAL_RCC_GPIOA_CLK_ENABLE" (";"-split, "none" dropped).
    pub clock_enable: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioPin {
    pub port: String,
    /// HAL macro, e.g. "GPIO_PIN_9".
    pub pin_macro: String,
    /// F1 only: AFIO_EVENTOUT pin source macro.
    pub pin_source: Option<String>,
    /// Signal name -> AF binding, document order.
    pub signals: Vec<GpioPinSignal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioPinSignal {
    /// e.g. "USART1_TX".
    pub signal: String,
    pub binding: AfBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AfBinding {
    /// F0/F2+ style: HAL AF macro, e.g. "GPIO_AF7_USART1".
    Af { macro_name: String },
    /// F1 style: this (pin, signal) participates in one or more AFIO
    /// remap configurations of the owning peripheral.
    Remap { blocks: Vec<RemapBlockRef> },
    /// No explicit AF data (e.g. analog-only signals).
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemapBlockRef {
    /// e.g. "USART1_REMAP0". Prefix before "_REMAP" is the peripheral,
    /// suffix digit is the AFIO_MAPR configuration index.
    pub block: String,
    pub default_remap: bool,
    /// AFIO remap macro to emit for non-default blocks,
    /// e.g. "__HAL_AFIO_REMAP_USART1_ENABLE".
    pub af_macro: Option<String>,
}

// ---------------------------------------------------------------------------
// Generic IP definition (peripherals *and* services: RCC/NVIC/DMA/GPIO share it)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpDef {
    pub name: String,
    pub version: String,
    /// "peripheral" | "service".
    pub ip_type: String,
    /// Document order; same-Name entries are condition-ordered overloads,
    /// first matching wins, unconditioned entry is the fallback.
    pub ref_parameters: Vec<RefParameter>,
    pub ref_modes: Vec<RefMode>,
    /// Top-level mode tree (None for pure parameter services like NVIC).
    pub mode_tree: Option<ModeNode>,
    /// Signal catalog with default GPIO IOMode bindings.
    pub ref_signals: Vec<RefSignal>,
    /// IP-level semaphores raised whenever an instance is enabled
    /// (e.g. `USE_$IpInstance` — consumed by RCC constraint conditions).
    pub semaphores: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefParameter {
    pub name: String,
    pub comment: String,
    /// Raw default. May be a literal, `+Other` / `=Other` / `+A+|B`
    /// codegen indirections, or "null".
    pub default_value: String,
    /// "list" | "integer" | "double" | "string" | "uniqueElementList" | "".
    pub param_type: String,
    pub min: Option<Num>,
    pub max: Option<Num>,
    pub unit: String,
    pub group: String,
    pub visible: bool,
    /// Overload guard; entry applies only if this evaluates true.
    pub condition: Option<DiagCondition>,
    pub possible_values: Vec<PossibleValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PossibleValue {
    /// HAL enum literal (or packed record for NVIC IRQn).
    pub value: String,
    /// Human comment; for divider/multiplier lists this carries the
    /// numeric factor ("1.5") — parsed into `factor` by the importer.
    pub comment: String,
    /// Numeric factor parsed from `comment` when this list is used as a
    /// clock divider/multiplier domain. None when not numeric.
    pub factor: Option<Num>,
    /// Semaphore raised while this value is selected.
    pub semaphore: Option<String>,
    pub condition: Option<Condition>,
    /// "Disable" | "Remove" (with condition): value filtered out.
    pub action: Option<PvAction>,
    pub diagnostic: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PvAction {
    Disable,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefMode {
    pub name: String,
    pub is_abstract: bool,
    /// Single-inheritance parent RefMode.
    pub base_mode: Option<String>,
    /// HAL driver family ("UART", "TIM_OC", ...).
    pub hal_mode: Option<String>,
    /// Codegen init block names, in order ("Uart_Init", "RCC_OSCConfig").
    pub config_for_mode: Vec<String>,
    pub condition: Option<DiagCondition>,
    /// Parameters pulled into this mode; possibly pinned to values.
    pub parameters: Vec<ModeParameter>,
    /// Semaphores raised while the mode is active (rare at RefMode level).
    pub semaphores: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeParameter {
    pub name: String,
    /// Non-empty = value(s) pinned in this mode.
    pub pinned_values: Vec<String>,
    /// The RefParameter this entry actually pins, when the db redirects.
    ///
    /// `Name` is the mode-local label and `RefParameter` the parameter it
    /// binds; they differ in about half of the db's pairs
    /// (`Name="ADC1_Secure" RefParameter="IP_Secure"`). Reading only `Name`
    /// means the lookup misses and the pin is silently lost.
    #[serde(default)]
    pub ref_parameter: Option<String>,
    /// Guard: the value is pinned only while this holds.
    #[serde(default)]
    pub condition: Option<Condition>,
}

impl ModeParameter {
    /// The RefParameter name to resolve — the redirect when present.
    pub fn target(&self) -> &str {
        self.ref_parameter.as_deref().unwrap_or(&self.name)
    }
}

/// Mode tree node: operators compose modes; leaves reference RefModes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModeNode {
    Operator {
        op: ModeOp,
        children: Vec<ModeNode>,
    },
    Mode {
        name: String,
        user_name: Option<String>,
        /// Statically prunes this mode per family/instance.
        remove_condition: Option<Condition>,
        conditions: Vec<DiagCondition>,
        /// AND-required signals when this mode is active.
        signals: Vec<ModeSignal>,
        semaphores: Vec<String>,
        children: Vec<ModeNode>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModeOp {
    Or,
    Xor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeSignal {
    /// Short signal name ("TX"); full name is `{Instance}_{name}`.
    pub name: String,
    /// Per-mode IOMode override (beats RefSignal default).
    pub io_mode: Option<String>,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefSignal {
    pub name: String,
    /// Default GPIO RefMode preset name.
    pub io_mode: Option<String>,
    /// True = consumes no pin (internal signal).
    pub virtual_signal: bool,
    pub direction: Option<String>,
    pub shareable_group: Option<String>,
    pub exclusive_group: Option<String>,
}

// ---------------------------------------------------------------------------
// Clock tree (db/plugins/clock/*.xml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockTree {
    pub id: String,
    /// Document order. Duplicate ids with conditions = first-match-wins.
    pub elements: Vec<ClockElement>,
    /// signal id -> frequency RefParameter name (may be empty).
    pub signals: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockElement {
    pub id: String,
    pub kind: ClockElementKind,
    /// Binds the node to a RefParameter in the RCC IP def (divider list,
    /// mux selector, source/output frequency).
    pub ref_parameter: Option<String>,
    /// Enable parameters gating this node.
    pub ref_enable: Vec<String>,
    pub is_key: bool,
    pub condition: Option<Condition>,
    pub inputs: Vec<ClockEdge>,
    pub outputs: Vec<ClockEdge>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClockElementKind {
    FixedSource,
    VariedSource,
    /// An oscillator whose frequency is picked from a discrete list rather
    /// than being fixed or user-supplied: the MSI/MSIS range selector of the
    /// L/U/W/WB/WL families, where the bound parameter's `PossibleValue`
    /// comments carry the frequency in the parameter's own `Unit`.
    DistinctValsSource,
    /// sic — "devisor" in the db.
    Divisor,
    Multiplicator,
    MultiplicatorFrac,
    Fractional,
    Multiplexor,
    Output,
    ActiveOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClockEdge {
    pub signal_id: String,
    /// Peer element id (`from` for inputs, `to` for outputs).
    pub peer: String,
    /// On mux inputs: the selector enum value choosing this input.
    pub ref_value: Option<String>,
}

// ---------------------------------------------------------------------------
// NVIC vector records (parsed 5-field packed strings)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NvicVector {
    /// e.g. "USART1_IRQn".
    pub irqn: String,
    pub comment: String,
    /// First flag: user may enable/disable in config.
    pub user_enableable: bool,
    /// Remaining flags: "EXTI", "DMAL0", "2V1", "HAL", ...
    pub flags: Vec<String>,
    /// Owning IP instances ("USART1"; "EXTI5,EXTI6.." split).
    pub owners: Vec<String>,
    /// Handler function templates ("HAL_GPIO_EXTI_IRQHandler").
    pub handlers: Vec<String>,
    /// Raw trailing args field.
    pub args: String,
    /// Per-device availability (e.g. shared-vector variants).
    pub condition: Option<Condition>,
}

// ---------------------------------------------------------------------------
// Codegen call trees (db/mcu/config/*_Configs.xml)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigDef {
    /// e.g. "UART-STM32F1xx".
    pub name: String,
    /// RefConfig name (matches RefMode ConfigForMode) -> call sequence.
    pub ref_configs: BTreeMap<String, RefConfig>,
    /// LibMethod name -> signature/argument tree.
    pub lib_methods: BTreeMap<String, LibMethod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefConfig {
    pub name: String,
    pub calls: Vec<ConfigCall>,
    /// MSP callbacks to implement (e.g. "HAL_UART_MspInit").
    pub callbacks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigCall {
    /// LibMethod name, e.g. "HAL_UART_Init". Empty for a `Type="HardCode"`
    /// call, whose whole content is [`ConfigCall::hard_code`].
    pub method: String,
    /// struct-field/arg name -> engine parameter name supplying the value.
    pub arg_bindings: BTreeMap<String, String>,
    /// Wrapping IFCondition, if any.
    pub condition: Option<Condition>,
    /// Verbatim source the db wants emitted at this point in the sequence,
    /// with the db's `#n` / `#t` escapes already expanded. This is how H7
    /// spells its `while(!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}` wait —
    /// there is no HAL function for it, so the db ships the statement.
    #[serde(default)]
    pub hard_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibMethod {
    pub name: String,
    pub arguments: Vec<MethodArgument>,
    /// "true" => guard call with `!= HAL_OK`; other literal = compare value.
    pub return_hal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MethodArgument {
    pub name: String,
    pub type_name: Option<String>,
    /// "struct" | "simple" | "Array" | "baseaddress".
    pub generic_type: String,
    pub address_of: bool,
    /// "global" | "globalConst" | "globalInit" | "" (local).
    pub context: String,
    pub optimization_condition: Option<String>,
    pub children: Vec<MethodArgument>,
}
