//! TEMPORARY dev-only dump tool (deleted before merge).
use std::path::PathBuf;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn load_pack(name: &str) -> IrPack {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("data")
        .join(name);
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    postcard::from_bytes(&bin).unwrap()
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("f4") {
        f4();
        return;
    }
    let pack = load_pack("stm32f1.irpack");
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
              "nvic": { "enabled": true, "preemptionPriority": 1 }
            }
          },
          "gpio": { "PC13": { "mode": "output", "initHigh": true, "label": "LED" } }
        }"#,
    )
    .unwrap();
    let resolved = validate(&pack, &doc).expect("validate");

    if std::env::args().nth(1).as_deref() == Some("extra") {
        extra(&pack, &resolved);
        return;
    }

    println!("=== ENV PARAMS (clock-ish) ===");
    for (k, v) in &resolved.env.params {
        if !k.contains(':') {
            println!("  {k} = {}", v.as_str());
        }
    }
    println!("=== CLOCK assignments ===");
    for (k, v) in &resolved.clock.assignments {
        println!("  {k} = {v}");
    }
    println!("=== CLOCK derived ===");
    for (k, v) in &resolved.clock.derived {
        println!("  {k} = {v}");
    }
    println!("=== PERIPHS ===");
    for p in &resolved.periphs {
        println!(
            "  {} ip={} hal_mode={:?} cfm={:?} clock_enable={:?}",
            p.instance, p.ip.name, p.hal_mode, p.config_for_mode, p.clock_enable
        );
        for (k, v) in &p.params {
            println!("    param {k} = {v}");
        }
        for s in &p.signals {
            println!("    signal {} io_mode={:?}", s.short, s.io_mode);
        }
    }
    println!("=== PLACEMENTS ===");
    for pl in &resolved.pin_plan.placements {
        println!(
            "  {} pin={} af={:?} remap={:?}",
            pl.signal, pl.pin, pl.af_macro, pl.remap_block
        );
    }
    println!("=== REMAPS === {:?}", resolved.pin_plan.remaps);
    println!("=== NVIC ===");
    for irq in &resolved.nvic {
        println!(
            "  {} owner={} pre={} sub={} handlers={:?} args={:?}",
            irq.irqn, irq.owner, irq.preemption_priority, irq.sub_priority, irq.handlers, irq.args
        );
    }
    println!("=== gpio_version = {}", resolved.gpio_version);
    let g = &pack.gpio[&resolved.gpio_version];
    println!("=== GPIO ref_parameters ===");
    for rp in &g.ref_parameters {
        println!(
            "  {} default={} type={} pv={:?}",
            rp.name,
            rp.default_value,
            rp.param_type,
            rp.possible_values.iter().map(|p| p.value.as_str()).collect::<Vec<_>>()
        );
    }
    println!("=== GPIO ref_modes ===");
    for rm in &g.ref_modes {
        println!(
            "  {} base={:?} params={:?}",
            rm.name,
            rm.base_mode,
            rm.parameters
                .iter()
                .map(|p| format!("{}={:?}", p.name, p.pinned_values))
                .collect::<Vec<_>>()
        );
    }
    println!("=== GPIO ports ===");
    for (k, p) in &g.ports {
        println!("  {k} clock_enable={:?}", p.clock_enable);
    }
    println!("=== SYS/RCC instances ===");
    for ii in &resolved.part.ip_instances {
        println!(
            "  {} name={} ver={} config_file={:?} clock_enable={:?}",
            ii.instance, ii.name, ii.version, ii.config_file, ii.clock_enable
        );
    }
    println!("=== CONFIG KEYS ===");
    for k in pack.configs.keys() {
        println!("  {k}");
    }
    if let Some(cfg) = pack.configs.get("UART-STM32F1xx") {
        println!("=== UART-STM32F1xx ref_configs ===");
        for (name, rc) in &cfg.ref_configs {
            println!("  RefConfig {name} callbacks={:?}", rc.callbacks);
            for c in &rc.calls {
                println!("    call {} cond={:?}", c.method, c.condition.is_some());
                for (a, b) in &c.arg_bindings {
                    println!("      bind {a} <- {b}");
                }
            }
        }
        println!("=== UART-STM32F1xx lib_methods ===");
        for (name, lm) in &cfg.lib_methods {
            println!("  LibMethod {name} return_hal={:?}", lm.return_hal);
            for a in &lm.arguments {
                dump_arg(a, 2);
            }
        }
    }
}

fn f4() {
    let pack = load_pack("stm32f4.irpack");
    let part = pack
        .parts
        .keys()
        .find(|k| k.contains("F411C"))
        .or_else(|| pack.parts.keys().next())
        .unwrap()
        .clone();
    let part_no = pack.parts[&part].part_numbers[0].clone();
    println!("using part {part} ({part_no})");
    let doc: ConfigDoc = serde_json::from_str(&format!(
        r#"{{
          "schemaVersion": 1,
          "mcu": {{ "part": "{part_no}" }},
          "clock": {{
            "sources": {{ "HSE": {{ "kind": "crystal", "freqHz": 25000000 }} }},
            "targets": {{ "SYSCLK": {{ "hz": 100000000 }} }}
          }},
          "peripherals": {{
            "USART1": {{
              "mode": "Asynchronous",
              "params": {{ "BaudRate": 115200 }},
              "pins": {{ "TX": "PA9", "RX": "PA10" }},
              "nvic": {{ "enabled": true }}
            }}
          }},
          "gpio": {{ "PC13": {{ "mode": "output", "label": "LED" }} }}
        }}"#
    ))
    .unwrap();
    let resolved = match validate(&pack, &doc) {
        Ok(r) => r,
        Err(e) => {
            println!("ERR {e:?}");
            return;
        }
    };
    for d in &resolved.diags {
        println!("diag {:?} {} {}", d.severity, d.code, d.message);
    }
    println!("=== F4 ENV PARAMS ===");
    for (k, v) in &resolved.env.params {
        if !k.contains(':') {
            println!("  {k} = {}", v.as_str());
        }
    }
    println!("=== F4 derived === {:?}", resolved.clock.derived);
    println!("=== F4 placements ===");
    for pl in &resolved.pin_plan.placements {
        println!("  {} pin={} af={:?}", pl.signal, pl.pin, pl.af_macro);
    }
    for p in &resolved.periphs {
        println!(
            "periph {} hal={:?} cfm={:?} clk_en={:?}",
            p.instance, p.hal_mode, p.config_for_mode, p.clock_enable
        );
        for s in &p.signals {
            println!("  sig {} io={:?}", s.short, s.io_mode);
        }
    }
    println!("=== F4 gpio version {} ===", resolved.gpio_version);
    let g = &pack.gpio[&resolved.gpio_version];
    for rm in &g.ref_modes {
        println!(
            "  refmode {} params={:?}",
            rm.name,
            rm.parameters
                .iter()
                .map(|p| format!("{}={:?}", p.name, p.pinned_values))
                .collect::<Vec<_>>()
        );
    }
    for rp in &g.ref_parameters {
        println!("  refparam {} default={}", rp.name, rp.default_value);
    }
    println!("=== SYS clk enable ===");
    for ii in &resolved.part.ip_instances {
        if ii.name == "SYS" || ii.name == "RCC" || ii.instance == "USART1" {
            println!("  {} clock_enable={:?}", ii.instance, ii.clock_enable);
        }
    }
    println!("=== NVIC out ===");
    for irq in &resolved.nvic {
        println!("  {} handlers={:?} args={:?}", irq.irqn, irq.handlers, irq.args);
    }
}

#[allow(dead_code)]
fn extra(pack: &IrPack, resolved: &stm32ck_engine::session::Resolved<'_>) {
    println!("=== USART IP ref_parameters (defaults) ===");
    let usart = &resolved.periphs[0];
    for rp in &usart.ip.ref_parameters {
        println!(
            "  {} default={:?} type={} cond={}",
            rp.name,
            rp.default_value,
            rp.param_type,
            rp.condition.is_some()
        );
    }
    if let Some(cfg) = pack.configs.get("UART-STM32F1xx") {
        for name in ["HAL_UART_Init", "HAL_UART_DeInit"] {
            if let Some(lm) = cfg.lib_methods.get(name) {
                println!("  LibMethod {name} return_hal={:?}", lm.return_hal);
                for a in &lm.arguments {
                    println!(
                        "    root arg {} ctx={:?} type={:?} addr={}",
                        a.name, a.context, a.type_name, a.address_of
                    );
                }
            }
        }
    }
    println!("=== NVIC vectors (F1) ===");
    for (k, vecs) in &pack.nvic_vectors {
        println!("  table {k}");
        for v in vecs {
            println!(
                "    {} ue={} flags={:?} owners={:?} handlers={:?} args={:?} cond={}",
                v.irqn,
                v.user_enableable,
                v.flags,
                v.owners,
                v.handlers,
                v.args,
                v.condition.is_some()
            );
        }
    }
}

#[allow(dead_code)]
fn dump_arg(a: &stm32ck_ir::model::MethodArgument, indent: usize) {
    println!(
        "{:indent$}arg {} type={:?} generic={} addr={} ctx={:?} opt={:?}",
        "",
        a.name,
        a.type_name,
        a.generic_type,
        a.address_of,
        a.context,
        a.optimization_condition,
        indent = indent * 2
    );
    for c in &a.children {
        dump_arg(c, indent + 1);
    }
}
