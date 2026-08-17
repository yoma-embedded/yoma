//! DMA request resolution (plan §P3): flow (stream/channel) allocation over
//! the DMA service IpDef's mode tree, plus HAL_DMA_Init parameter
//! resolution through the request's RefMode chain.
//!
//! The db model (mined from the F1/F4 packs, mine-dma.md):
//! - the mode tree is `DMA1/DMA2 -> flows (DMA1_Stream2 / DMA1_Channel7) ->
//!   XOR of request leaves`; a leaf's ancestors are its legal flows and the
//!   leaf's condition gates availability (requester semaphores like
//!   `S_UART4_TX_RX`, `SPI3_DmaReceive` — published by the P1/P2 fixpoint)
//! - a flow node names a SET of flows on every request-mux (DMAMUX) family:
//!   `DMA1_Channel[1-7]` is a range, and `DMA1_Channel[1-7]:DMA2_Channel[1-5]`
//!   is an alternative list. F1 and F4 predate the mux and spell one flow per
//!   node, which is why the literal reading survived this long — see
//!   [`expand_flow_names`]
//! - leaf names may carry suffixes: `I2C3_RX:DMA_CHANNEL_3` overrides the
//!   request RefMode's pinned `Channel` for that flow; F1's
//!   `:Conflict:...:Config:...` metadata is ignored for now
//! - the request RefMode (BaseMode `DMA_Request`, ConfigForMode
//!   `HAL_DMA_Init`) pins per-request facts: `Channel` (F4 channel macro),
//!   `Direction`, `DMA_Handle` (the `__HAL_LINKDMA` field: hdmarx/hdmatx/
//!   DMA_Handle), `PeriphInc`, and the allowed `Mode` set (multi-pinned =
//!   restricted domain, first entry is the default)
//! - alignment defaults are overload-conditioned on transient semaphores
//!   CubeMX raises per request: `TEMP_{request}_REQUEST_SEM` and
//!   `TEMP_{emitter}_IP_SEM` — reproduced here on a scratch env per request
//! - the controller RefModes (`DMA1`/`DMA2`) pin `ClockEnableMode`
//!   (`__HAL_RCC_DMA1_CLK_ENABLE`) consumed by MX_DMA_Init.

use crate::config::{ConfigDoc, DmaReqCfg, NvicCfg};
use crate::diag::Diagnostic;
use crate::env::{Env, Value};
use crate::eval::{eval_condition, EvalTrace};
use crate::modes::bind_condition;
use crate::params::{check_value, effective_domain, mode_chain, resolve_param, ModeSel, Verdict};
use std::collections::BTreeMap;
use stm32ck_ir::expr::Condition;
use stm32ck_ir::model::{IpDef, IrPack, ModeNode, Part};

/// One fully resolved DMA request, ready for codegen.
#[derive(Debug, Clone)]
pub struct ResolvedDma {
    /// Full db request name ("UART4_RX", "ADC1").
    pub request: String,
    /// Peripheral instance owning the handle/MspInit ("UART4").
    pub owner_instance: String,
    /// Request suffix after the owner ("RX", "TX", "" for whole-instance).
    pub owner_signal: String,
    /// Allocated flow ("DMA1_Stream2" / "DMA1_Channel7").
    pub stream: String,
    /// "DMA1" / "DMA2".
    pub controller: String,
    /// F4 request-mux channel macro ("DMA_CHANNEL_4"); None on F1.
    pub channel_macro: Option<String>,
    /// "hdma_uart4_rx" (mine-dma.md naming: hdma_ + lowercased request).
    pub handle_name: String,
    /// `__HAL_LINKDMA` field on the owner handle: hdmarx/hdmatx/DMA_Handle.
    pub link_field: String,
    /// Final HAL_DMA_Init `Init` fields (name -> C literal). Emission order
    /// comes from the DMA ConfigDef's LibMethod, not this map.
    pub params: BTreeMap<String, String>,
    /// "DMA1_Stream2_IRQn".
    pub irqn: String,
    /// "__HAL_RCC_DMA1_CLK_ENABLE".
    pub clock_enable: String,
    pub nvic: NvicCfg,
    pub generate_handler: bool,
}

impl ResolvedDma {
    /// Numeric flow index for (controller, flow) ordering ("DMA1_Stream2"
    /// -> 2).
    pub fn stream_index(&self) -> u32 {
        trailing_number(&self.stream)
    }
}

fn trailing_number(s: &str) -> u32 {
    let d: String = s
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    d.chars().rev().collect::<String>().parse().unwrap_or(0)
}

/// One legal (request, flow) pairing from the DMA mode tree.
struct FlowRow<'a> {
    request: String,
    controller: String,
    stream: String,
    channel_override: Option<String>,
    condition: Option<&'a Condition>,
    semaphores: &'a [String],
    /// The service IP this flow belongs to — a part may have several
    /// (H7 carries DMA + BDMA + MDMA, each its own mode tree and HAL type).
    ip: &'a IpDef,
}

/// Whether an IP instance is a DMA *service* controller.
///
/// The name is family data: `DMA` on F1..G4, `GPDMA` on H5/U5/N6/WBA,
/// plus H7's `BDMA`/`MDMA` and N6's `HPDMA`. `DMA2D` is a 2-D graphics
/// accelerator that merely sounds similar, and `LPBAMLPDMA` is the LPBAM
/// projection of `LPDMA` rather than a controller of its own.
fn is_dma_service(name: &str) -> bool {
    name.ends_with("DMA") && !name.contains("LPBAM")
}

/// Direct child Mode nodes, looking through operator nodes.
fn child_modes(children: &[ModeNode]) -> Vec<&ModeNode> {
    let mut out = Vec::new();
    for c in children {
        match c {
            ModeNode::Operator { children, .. } => out.extend(child_modes(children)),
            ModeNode::Mode { .. } => out.push(c),
        }
    }
    out
}

/// Expand a db flow-node name into the concrete flows it stands for.
///
/// * `DMA1_Stream2` -> itself (F1/F4 spell one flow per node);
/// * `DMA1_Channel[1-7]` -> `DMA1_Channel1` .. `DMA1_Channel7`;
/// * `DMA1_Channel[1-7]:DMA2_Channel[1-5]` -> both ranges, in order.
///
/// Order is the db's, low index first, because that is the order the
/// allocator walks and therefore what decides which channel a request lands
/// on. Anything that does not parse is kept verbatim so a novel spelling
/// surfaces as a compile error in the generated project rather than being
/// silently dropped.
fn expand_flow_names(node_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for alt in node_name.split(':') {
        let alt = alt.trim();
        if alt.is_empty() {
            continue;
        }
        let Some((prefix, rest)) = alt.split_once('[') else {
            out.push(alt.to_string());
            continue;
        };
        let parsed = rest.strip_suffix(']').and_then(|r| {
            let (lo, hi) = r.split_once('-')?;
            Some((lo.trim().parse::<u32>().ok()?, hi.trim().parse::<u32>().ok()?))
        });
        match parsed {
            Some((lo, hi)) if lo <= hi => {
                out.extend((lo..=hi).map(|i| format!("{prefix}{i}")));
            }
            _ => out.push(alt.to_string()),
        }
    }
    out
}

/// Flatten the DMA tree into flow rows, tree (controller, flow, leaf) order.
fn flow_matrix(ip: &IpDef) -> Vec<FlowRow<'_>> {
    let mut rows = Vec::new();
    let Some(root) = &ip.mode_tree else {
        return rows;
    };
    let controllers = match root {
        ModeNode::Operator { children, .. } => child_modes(children),
        m @ ModeNode::Mode { .. } => vec![m],
    };
    for ctrl in controllers {
        let ModeNode::Mode {
            name: ctrl_name,
            children: ctrl_children,
            ..
        } = ctrl
        else {
            continue;
        };
        for flow in child_modes(ctrl_children) {
            let ModeNode::Mode {
                name: flow_name,
                children: flow_children,
                ..
            } = flow
            else {
                continue;
            };
            for leaf in child_modes(flow_children) {
                let ModeNode::Mode {
                    name: leaf_name,
                    conditions,
                    semaphores,
                    ..
                } = leaf
                else {
                    continue;
                };
                // "I2C3_RX:DMA_CHANNEL_3" / F1 ":Conflict:..:Config:.."
                let mut segs = leaf_name.split(':');
                let request = segs.next().unwrap_or(leaf_name).to_string();
                let channel_override = leaf_name
                    .split(':')
                    .find(|s| s.starts_with("DMA_CHANNEL_"))
                    .map(str::to_string);
                for stream in expand_flow_names(flow_name) {
                    let ip_ref = ip;
                    // A flow list may span controllers ("DMA1_Channel[1-7]:
                    // DMA2_Channel[1-5]"), so the controller comes from the
                    // flow name itself when it says one, not from the parent.
                    let controller = stream
                        .split_once('_')
                        .map(|(c, _)| c.to_string())
                        .unwrap_or_else(|| ctrl_name.clone());
                    rows.push(FlowRow {
                        request: request.clone(),
                        controller,
                        stream,
                        channel_override: channel_override.clone(),
                        condition: conditions.first().map(|dc| &dc.condition),
                        semaphores,
                        ip: ip_ref,
                    });
                }
            }
        }
    }
    rows
}

/// Fixed fallback resolution order for the HAL_DMA_Init fields; matches the
/// db chain's dependency order (Direction before PeriphInc, FIFOMode before
/// the FIFO/burst trio, alignments before FIFOThreshold).
const INIT_FIELD_ORDER: [&str; 12] = [
    "Channel",
    "Direction",
    "PeriphInc",
    "MemInc",
    "PeriphDataAlignment",
    "MemDataAlignment",
    "Mode",
    "Priority",
    "FIFOMode",
    "FIFOThreshold",
    "MemBurst",
    "PeriphBurst",
];

/// Params handled outside the Init-struct fill.
const NON_INIT_PARAMS: [&str; 4] = ["Instance", "DMA_Handle", "IpInstance", "ClockEnableMode"];

fn user_override<'c>(cfg: &'c DmaReqCfg, field: &str) -> Option<&'c String> {
    match field {
        "Direction" => cfg.direction.as_ref(),
        "PeriphInc" => cfg.periph_inc.as_ref(),
        "MemInc" => cfg.mem_inc.as_ref(),
        "PeriphDataAlignment" => cfg.periph_data_alignment.as_ref(),
        "MemDataAlignment" => cfg.mem_data_alignment.as_ref(),
        "Mode" => cfg.mode.as_ref(),
        "Priority" => cfg.priority.as_ref(),
        "FIFOMode" => cfg.fifo_mode.as_ref(),
        _ => None,
    }
}

/// Resolve every configured DMA request of the document. Called after the
/// peripheral activation fixpoint: leaf conditions read the requester
/// semaphores it published. Raises the winning leaves' semaphores
/// (`DMARequest_ADC1`) onto `env`. Output keeps document order
/// (owner instance, then request name).
pub fn resolve_dma(
    pack: &IrPack,
    part: &Part,
    doc: &ConfigDoc,
    env: &mut Env,
    trace: &mut EvalTrace,
    diags: &mut Vec<Diagnostic>,
) -> Vec<ResolvedDma> {
    // Configured requests in document order.
    struct Want<'c> {
        owner: String,
        request: String,
        cfg: &'c DmaReqCfg,
        path: String,
    }
    let mut wants: Vec<Want<'_>> = Vec::new();
    for (instance, pcfg) in &doc.peripherals {
        if pcfg.dma.is_empty() {
            continue;
        }
        if !part.ip_instances.iter().any(|i| i.instance == *instance) {
            continue; // PERIPH_UNKNOWN already diagnosed by the session
        }
        for (request, dcfg) in &pcfg.dma {
            wants.push(Want {
                owner: instance.clone(),
                request: request.clone(),
                cfg: dcfg,
                path: format!("/peripherals/{instance}/dma/{request}"),
            });
        }
    }
    if wants.is_empty() {
        return Vec::new();
    }

    // Every DMA service controller the part carries, in instance order. A
    // part may have more than one with different flow spaces and different
    // HAL types (H7: DMA + BDMA + MDMA), and only H7-and-earlier call the
    // first one "DMA" — see [`is_dma_service`].
    let mut services: Vec<&IpDef> = Vec::new();
    let mut service_names: Vec<&str> = Vec::new();
    for ii in part.ip_instances.iter().filter(|i| is_dma_service(&i.name)) {
        if let Some(ip) = pack.ips.get(&format!("{}-{}", ii.name, ii.version)) {
            if !service_names.contains(&ii.name.as_str()) {
                service_names.push(ii.name.as_str());
                services.push(ip);
            }
        }
    }
    if services.is_empty() {
        diags.push(Diagnostic::error(
            "DMA_IP_MISSING",
            "/peripherals",
            format!(
                "DMA requests configured but no DMA service IP exists on {}",
                part.ref_name
            ),
        ));
        return Vec::new();
    }

    let rows: Vec<FlowRow<'_>> = services.iter().flat_map(|ip| flow_matrix(ip)).collect();
    // The part's NVIC vector table names the interrupt each flow shares.
    let vectors: Option<&[stm32ck_ir::model::NvicVector]> = part
        .ip_instances
        .iter()
        .find(|i| i.name == "NVIC" || i.name.starts_with("NVIC"))
        .and_then(|i| pack.nvic_vectors.get(&format!("{}-{}", i.name, i.version)))
        .map(|v| v.as_slice());
    // stream -> occupying request (conflict bookkeeping + diagnostics).
    let mut occupied: BTreeMap<String, String> = BTreeMap::new();
    // Two passes — user-pinned flows claim their streams first, autos fill
    // the gaps — but the output keeps document order.
    let mut results: Vec<Option<ResolvedDma>> = (0..wants.len()).map(|_| None).collect();

    for pinned_pass in [true, false] {
        for (idx, w) in wants.iter().enumerate() {
            if (w.cfg.instance.is_some()) != pinned_pass {
                continue;
            }
            let my_rows: Vec<&FlowRow<'_>> =
                rows.iter().filter(|r| r.request == w.request).collect();
            if my_rows.is_empty() {
                diags.push(Diagnostic::error(
                    "DMA_REQUEST_UNKNOWN",
                    w.path.clone(),
                    format!(
                        "DMA request `{}` does not exist on {}'s DMA controllers",
                        w.request, part.ref_name
                    ),
                ));
                continue;
            }

            // The request must belong to the peripheral it is configured
            // under: the RefMode's pinned IpInstance ("UART4", "SPI3:I2S3")
            // names the legal emitters.
            let emitters: Vec<String> = services
                .iter()
                .find_map(|ip| ip.ref_modes.iter().find(|m| m.name == w.request))
                .and_then(|m| {
                    m.parameters
                        .iter()
                        .find(|p| p.name == "IpInstance")
                        .and_then(|p| p.pinned_values.first())
                })
                .map(|v| v.split(':').map(str::to_string).collect())
                .unwrap_or_default();
            let owner_ok = if emitters.is_empty() {
                w.request == w.owner || w.request.starts_with(&format!("{}_", w.owner))
            } else {
                emitters.contains(&w.owner)
            };
            if !owner_ok {
                diags.push(Diagnostic::error(
                    "DMA_REQUEST_OWNER",
                    w.path.clone(),
                    format!(
                        "DMA request `{}` is not emitted by {} (emitters: {})",
                        w.request,
                        w.owner,
                        if emitters.is_empty() {
                            w.request.clone()
                        } else {
                            emitters.join(", ")
                        }
                    ),
                ));
                continue;
            }

            // Availability condition (requester semaphores).
            if let Some(cond) = my_rows[0].condition {
                let bound = bind_condition(cond, "DMA");
                if !eval_condition(&bound, env, trace) {
                    diags.push(Diagnostic::error(
                        "DMA_REQUEST_CONDITION",
                        w.path.clone(),
                        format!(
                            "DMA request `{}` is not enabled by the current {} \
                             configuration (its mode does not demand this transfer)",
                            w.request, w.owner
                        ),
                    ));
                    continue;
                }
            }

            // Flow allocation.
            let legal: Vec<&str> = my_rows.iter().map(|r| r.stream.as_str()).collect();
            let row: Option<&FlowRow<'_>> = match &w.cfg.instance {
                Some(pin) => match my_rows.iter().find(|r| r.stream == *pin) {
                    Some(r) => {
                        if let Some(who) = occupied.get(pin) {
                            diags.push(Diagnostic::error(
                                "DMA_STREAM_CONFLICT",
                                w.path.clone(),
                                format!(
                                    "{pin} is already allocated to DMA request `{who}`"
                                ),
                            ));
                            None
                        } else {
                            Some(*r)
                        }
                    }
                    None => {
                        diags.push(
                            Diagnostic::error(
                                "DMA_STREAM_ILLEGAL",
                                w.path.clone(),
                                format!(
                                    "`{pin}` cannot serve DMA request `{}`",
                                    w.request
                                ),
                            )
                            .with_suggestion(format!("legal: {}", legal.join(", "))),
                        );
                        None
                    }
                },
                None => {
                    let free = my_rows.iter().find(|r| !occupied.contains_key(&r.stream));
                    if free.is_none() {
                        let contention: Vec<String> = my_rows
                            .iter()
                            .map(|r| {
                                format!(
                                    "{} (taken by {})",
                                    r.stream,
                                    occupied
                                        .get(&r.stream)
                                        .cloned()
                                        .unwrap_or_else(|| "?".into())
                                )
                            })
                            .collect();
                        diags.push(Diagnostic::error(
                            "DMA_EXHAUSTED",
                            w.path.clone(),
                            format!(
                                "no free flow for DMA request `{}`: {}",
                                w.request,
                                contention.join(", ")
                            ),
                        ));
                    }
                    free.copied()
                }
            };
            let Some(row) = row else { continue };
            occupied.insert(row.stream.clone(), w.request.clone());
            for s in row.semaphores {
                env.raise(s.clone());
            }

            results[idx] = Some(resolve_request(
                row.ip, w.owner.as_str(), &w.request, w.cfg, row, &emitters, vectors, env,
                trace, diags, &w.path,
            ));
        }
    }

    results.into_iter().flatten().collect()
}

/// The NVIC vector serving one DMA flow, from the db's own vector table.
///
/// It is not mechanically `<flow>_IRQn`: parts with fewer vectors than
/// channels share one, and the db says which — STM32F0 groups channels 2 and
/// 3 under `DMA1_Channel2_3_IRQn`. The `IRQn` PossibleValue record spells it
/// as `<name>:<flags>:<ip>:<controller>:<first>,<last>`, which the importer
/// splits into `handlers` (the controller) and `args` (the covered channel
/// range). `None` when no vector claims this flow, and the caller falls back
/// to the mechanical name.
fn dma_irqn(
    vectors: Option<&[stm32ck_ir::model::NvicVector]>,
    controller: &str,
    stream: &str,
) -> Option<String> {
    // TRAILING digit run — "DMA1_Channel2" is channel 2, not 1.
    let digits: String = stream
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let index: u32 = digits.parse().ok()?;
    vectors?
        .iter()
        .find(|v| {
            if !v.handlers.iter().any(|h| h == controller) {
                return false;
            }
            let mut bounds = v.args.split(',').filter_map(|s| s.trim().parse::<u32>().ok());
            match (bounds.next(), bounds.next()) {
                (Some(lo), Some(hi)) => (lo.min(hi)..=lo.max(hi)).contains(&index),
                (Some(only), None) => only == index,
                _ => false,
            }
        })
        .map(|v| v.irqn.clone())
}

/// Resolve one allocated request's HAL_DMA_Init parameters and identity.
#[allow(clippy::too_many_arguments)]
fn resolve_request(
    ip: &IpDef,
    owner: &str,
    request: &str,
    cfg: &DmaReqCfg,
    row: &FlowRow<'_>,
    emitters: &[String],
    vectors: Option<&[stm32ck_ir::model::NvicVector]>,
    env: &Env,
    trace: &mut EvalTrace,
    diags: &mut Vec<Diagnostic>,
    path: &str,
) -> ResolvedDma {
    // Scratch env: CubeMX's transient per-request semaphores steer the
    // alignment-default overloads (TEMP_ADC1_REQUEST_SEM -> HALFWORD).
    let mut scratch = env.clone();
    scratch.scope = None;
    scratch.mode_scope = None;
    scratch.raise(format!("TEMP_{request}_REQUEST_SEM"));
    if emitters.is_empty() {
        scratch.raise(format!("TEMP_{owner}_IP_SEM"));
    } else {
        for e in emitters {
            scratch.raise(format!("TEMP_{e}_IP_SEM"));
        }
    }

    let chain = mode_chain(
        ip,
        request,
        ModeSel {
            instance: owner,
            env: &scratch,
        },
    );
    // Pinned values per param from the leaf-merged chain.
    let pinned_of = |name: &str| -> Vec<String> {
        chain
            .as_ref()
            .and_then(|c| c.parameters.iter().find(|p| p.name == name))
            .map(|p| p.pinned_values.clone())
            .unwrap_or_default()
    };

    // Field list: the chain's parameters filtered to Init fields, ordered
    // by the canonical dependency order (chain merge order is leaf-first
    // and would resolve PeriphInc before Direction lands on the board).
    let chain_fields: Vec<String> = chain
        .as_ref()
        .map(|c| {
            c.parameters
                .iter()
                .map(|p| p.name.clone())
                .filter(|n| !NON_INIT_PARAMS.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_else(|| INIT_FIELD_ORDER.iter().map(|s| s.to_string()).collect());
    let mut fields: Vec<String> = INIT_FIELD_ORDER
        .iter()
        .filter(|f| chain_fields.iter().any(|c| c == **f))
        .map(|f| f.to_string())
        .collect();
    for f in &chain_fields {
        if !fields.contains(f) {
            fields.push(f.clone());
        }
    }

    let mut params: BTreeMap<String, String> = BTreeMap::new();
    for field in &fields {
        let pinned = pinned_of(field);
        let user = user_override(cfg, field);
        let value: Option<String> = if field == "Channel" && row.channel_override.is_some() {
            row.channel_override.clone()
        } else if pinned.len() == 1 {
            if let Some(u) = user {
                if *u != pinned[0] {
                    diags.push(Diagnostic::error(
                        "DMA_PARAM_PINNED",
                        format!("{path}/{field}"),
                        format!(
                            "`{field}` of request `{request}` is fixed to {} by the device \
                             (got `{u}`)",
                            pinned[0]
                        ),
                    ));
                }
            }
            Some(pinned[0].clone())
        } else if pinned.len() > 1 {
            match user {
                Some(u) => {
                    if pinned.iter().any(|p| p == u) {
                        Some(u.clone())
                    } else {
                        diags.push(
                            Diagnostic::error(
                                "DMA_PARAM_VALUE",
                                format!("{path}/{field}"),
                                format!(
                                    "`{u}` is not a legal `{field}` for request `{request}`"
                                ),
                            )
                            .with_suggestion(format!("allowed: {}", pinned.join(", "))),
                        );
                        Some(pinned[0].clone())
                    }
                }
                None => Some(pinned[0].clone()),
            }
        } else {
            // Unpinned: condition-ordered overloads on the scratch env
            // (previously resolved fields are visible to the guards).
            let rp = resolve_param(ip, field, &scratch, trace);
            match (user, rp) {
                (Some(u), Some(rp)) => {
                    let dom = effective_domain(rp, &scratch, trace);
                    match check_value(&dom, &Value::Str(u.clone())) {
                        Verdict::Ok => {}
                        _ => diags.push(
                            Diagnostic::error(
                                "DMA_PARAM_VALUE",
                                format!("{path}/{field}"),
                                format!(
                                    "`{u}` is not a legal `{field}` for request `{request}`"
                                ),
                            )
                            .with_suggestion(format!(
                                "allowed: {}",
                                dom.values
                                    .iter()
                                    .map(|pv| pv.value.clone())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )),
                        ),
                    }
                    Some(u.clone())
                }
                (Some(u), None) => Some(u.clone()),
                (None, Some(rp)) => {
                    let d = rp.default_value.trim();
                    if d.is_empty() || d == "null" || d.starts_with('+') || d.starts_with('=') {
                        None
                    } else {
                        Some(d.to_string())
                    }
                }
                (None, None) => None,
            }
        };
        if let Some(v) = value {
            scratch.set(field.clone(), Value::Str(v.clone()));
            params.insert(field.clone(), v);
        }
    }

    // LINKDMA field: db-pinned DMA_Handle, else derived from direction.
    let link_field = pinned_of("DMA_Handle").first().cloned().unwrap_or_else(|| {
        match params.get("Direction").map(String::as_str) {
            Some("DMA_MEMORY_TO_PERIPH") => "hdmatx".to_string(),
            _ => "hdmarx".to_string(),
        }
    });

    // Controller clock enable from the DMA1/DMA2 RefMode.
    // Most families pin `ClockEnableMode` on the controller's RefMode. WB0
    // declares it once at IP level instead, with an empty default and a
    // single PossibleValue — and its macro is `__HAL_RCC_DMA_CLK_ENABLE`,
    // not the `__HAL_RCC_<controller>_CLK_ENABLE` the name would suggest.
    let clock_enable = ip
        .ref_modes
        .iter()
        .find(|m| m.name == row.controller)
        .and_then(|m| {
            m.parameters
                .iter()
                .find(|p| p.name == "ClockEnableMode")
                .and_then(|p| p.pinned_values.first().cloned())
        })
        .or_else(|| {
            let rp = resolve_param(ip, "ClockEnableMode", &scratch, trace)?;
            let dv = rp.default_value.trim();
            if !dv.is_empty() {
                return Some(dv.to_string());
            }
            (rp.possible_values.len() == 1).then(|| rp.possible_values[0].value.clone())
        })
        .unwrap_or_else(|| format!("__HAL_RCC_{}_CLK_ENABLE", row.controller));

    let handle_name = format!(
        "hdma_{}",
        request
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect::<String>()
    );
    let owner_signal = request
        .strip_prefix(&format!("{owner}_"))
        .unwrap_or("")
        .to_string();

    ResolvedDma {
        request: request.to_string(),
        owner_instance: owner.to_string(),
        owner_signal,
        stream: row.stream.clone(),
        controller: row.controller.clone(),
        channel_macro: params.get("Channel").cloned(),
        handle_name,
        link_field,
        params,
        irqn: dma_irqn(vectors, &row.controller, &row.stream)
            .unwrap_or_else(|| format!("{}_IRQn", row.stream)),
        clock_enable,
        nvic: cfg.nvic.clone().unwrap_or(NvicCfg {
            enabled: true,
            preemption_priority: 0,
            sub_priority: 0,
            generate_handler: None,
        }),
        // Unified on NvicCfg.generateHandler (plan §P4); the request-level
        // field stays as a deprecated alias for v1 documents.
        generate_handler: cfg
            .nvic
            .as_ref()
            .and_then(|n| n.generate_handler)
            .or(cfg.generate_handler)
            .unwrap_or(true),
    }
}
