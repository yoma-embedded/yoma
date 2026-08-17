//! CAN gate (plan §P4): ODrive CAN1 (bxCAN, mode CAN_Activate, prescaler 7,
//! BS1 6TQ / BS2 5TQ, PB8/PB9, all four interrupt vectors at 6:0 via the
//! fine-grained `interrupts` map) must reproduce the reference can.c:
//! MX_CAN1_Init field set, MspInit 4x SetPriority/EnableIRQ in vector-table
//! order, four it.c handlers each calling HAL_CAN_IRQHandler(&hcan1) — and
//! the generated project must compile with arm-gcc.

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

fn tool_available(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn prerequisites() -> Option<(IrPack, PathBuf)> {
    let pack = load_pack("stm32f4.irpack")?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join("STM32F4").is_dir() {
        eprintln!("skip: firmware components not present under {}", fw_dir.display());
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

fn f405_can_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "assignments": {
              "APB1CLKDivider": "RCC_HCLK_DIV4",
              "APB2CLKDivider": "RCC_HCLK_DIV2",
              "PLLM": 4,
              "PLLN": 168,
              "PLLP": "RCC_PLLP_DIV2",
              "PLLQ": 7,
              "PLLSourceVirtual": "RCC_PLLSOURCE_HSE",
              "SYSCLKSource": "RCC_SYSCLKSOURCE_PLLCLK"
            }
          },
          "peripherals": {
            "CAN1": {
              "mode": "CAN_Activate",
              "params": {
                "Prescaler": 7,
                "BS1": "CAN_BS1_6TQ",
                "BS2": "CAN_BS2_5TQ"
              },
              "pins": { "RX": "PB8", "TX": "PB9" },
              "interrupts": {
                "CAN1_TX_IRQn":  { "enabled": true, "preemptionPriority": 6 },
                "CAN1_RX0_IRQn": { "enabled": true, "preemptionPriority": 6 },
                "CAN1_RX1_IRQn": { "enabled": true, "preemptionPriority": 6 },
                "CAN1_SCE_IRQn": { "enabled": true, "preemptionPriority": 6 }
              }
            }
          }
        }"#,
    )
    .unwrap()
}

fn generate(pack: &IrPack, doc: &ConfigDoc, fw_dir: &Path, out_dir: &Path) {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir).unwrap();
    }
    std::fs::create_dir_all(out_dir).unwrap();
    let resolved = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "CAN doc must validate clean");
    generate_project(pack, &resolved, doc, fw_dir, out_dir, "0.1.0").expect("generate_project");
}

fn run(cwd: &Path, program: &str, args: &[&str]) {
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
}

fn build(out_dir: &Path) {
    run(
        out_dir,
        "cmake",
        &["-S", ".", "-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Debug"],
    );
    run(out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("app.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}

fn read(out_dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(out_dir.join(rel))
        .unwrap_or_else(|e| panic!("missing {rel}: {e}"))
}

#[test]
fn f405_can1_matches_reference_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites() else { return };
    let doc = f405_can_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("can_gate_f405");
    generate(&pack, &doc, &fw_dir, &out_dir);

    // can.c: handle + MX_CAN1_Init field-for-field vs reference can.c.
    let can_c = read(&out_dir, "Core/Src/can.c");
    for line in [
        "CAN_HandleTypeDef hcan1;",
        "void MX_CAN1_Init(void)",
        "hcan1.Instance = CAN1;",
        "hcan1.Init.Prescaler = 7;",
        "hcan1.Init.Mode = CAN_MODE_NORMAL;",
        "hcan1.Init.SyncJumpWidth = CAN_SJW_1TQ;",
        "hcan1.Init.TimeSeg1 = CAN_BS1_6TQ;",
        "hcan1.Init.TimeSeg2 = CAN_BS2_5TQ;",
        "hcan1.Init.TimeTriggeredMode = DISABLE;",
        "hcan1.Init.AutoBusOff = DISABLE;",
        "hcan1.Init.AutoWakeUp = DISABLE;",
        "hcan1.Init.AutoRetransmission = DISABLE;",
        "hcan1.Init.ReceiveFifoLocked = DISABLE;",
        "hcan1.Init.TransmitFifoPriority = DISABLE;",
        "if (HAL_CAN_Init(&hcan1) != HAL_OK)",
    ] {
        assert!(can_c.contains(line), "can.c missing `{line}`:\n{can_c}");
    }

    // MspInit: clock, PB8/PB9 AF9 pins, then all FOUR vectors enabled in
    // vector-table order with the ioc priorities (6, 0).
    for line in [
        "void HAL_CAN_MspInit(CAN_HandleTypeDef* canHandle)",
        "__HAL_RCC_CAN1_CLK_ENABLE();",
        "GPIO_InitStruct.Pin = GPIO_PIN_8|GPIO_PIN_9;",
        "GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;",
        "GPIO_AF9_CAN1",
        "HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);",
        "HAL_NVIC_SetPriority(CAN1_TX_IRQn, 6, 0);",
        "HAL_NVIC_EnableIRQ(CAN1_TX_IRQn);",
        "HAL_NVIC_SetPriority(CAN1_RX0_IRQn, 6, 0);",
        "HAL_NVIC_EnableIRQ(CAN1_RX0_IRQn);",
        "HAL_NVIC_SetPriority(CAN1_RX1_IRQn, 6, 0);",
        "HAL_NVIC_EnableIRQ(CAN1_RX1_IRQn);",
        "HAL_NVIC_SetPriority(CAN1_SCE_IRQn, 6, 0);",
        "HAL_NVIC_EnableIRQ(CAN1_SCE_IRQn);",
        "void HAL_CAN_MspDeInit(CAN_HandleTypeDef* canHandle)",
        "__HAL_RCC_CAN1_CLK_DISABLE();",
        "HAL_NVIC_DisableIRQ(CAN1_TX_IRQn);",
        "HAL_NVIC_DisableIRQ(CAN1_SCE_IRQn);",
    ] {
        assert!(can_c.contains(line), "can.c missing `{line}`:\n{can_c}");
    }
    let tx = can_c.find("HAL_NVIC_SetPriority(CAN1_TX_IRQn").unwrap();
    let rx0 = can_c.find("HAL_NVIC_SetPriority(CAN1_RX0_IRQn").unwrap();
    let rx1 = can_c.find("HAL_NVIC_SetPriority(CAN1_RX1_IRQn").unwrap();
    let sce = can_c.find("HAL_NVIC_SetPriority(CAN1_SCE_IRQn").unwrap();
    assert!(
        tx < rx0 && rx0 < rx1 && rx1 < sce,
        "NVIC rows must be in vector-table order TX,RX0,RX1,SCE:\n{can_c}"
    );

    // it.c: four handlers, each dispatching HAL_CAN_IRQHandler(&hcan1).
    let it_c = read(&out_dir, "Core/Src/stm32f4xx_it.c");
    assert!(it_c.contains("extern CAN_HandleTypeDef hcan1;"), "it.c:\n{it_c}");
    for irq in ["CAN1_TX", "CAN1_RX0", "CAN1_RX1", "CAN1_SCE"] {
        let handler = format!("void {irq}_IRQHandler(void)");
        assert!(it_c.contains(&handler), "it.c missing `{handler}`:\n{it_c}");
    }
    assert_eq!(
        it_c.matches("HAL_CAN_IRQHandler(&hcan1);").count(),
        4,
        "each CAN vector must call HAL_CAN_IRQHandler(&hcan1):\n{it_c}"
    );

    // can.h: extern + prototype; hal_conf: CAN module on.
    let can_h = read(&out_dir, "Core/Inc/can.h");
    assert!(can_h.contains("extern CAN_HandleTypeDef hcan1;"), "can.h:\n{can_h}");
    assert!(can_h.contains("void MX_CAN1_Init(void);"));
    let conf = read(&out_dir, "Core/Inc/stm32f4xx_hal_conf.h");
    assert!(conf.contains("#define HAL_CAN_MODULE_ENABLED"));

    build(&out_dir);
}
