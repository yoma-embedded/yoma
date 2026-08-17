//! DMA end-to-end gate (plan §P3): the ODrive F405 DMA set — UART4 RX/TX
//! (DMA1_Stream2/4, channel 4), SPI3 RX/TX (DMA1_Stream0/5, channel 0),
//! ADC1 (DMA2_Stream0, circular halfword, NVIC-enabled but handler-less) —
//! must reproduce the reference wiring field for field
//! (`odrive_cubemx_demo/Src/{usart,spi,adc,dma}.c`, `stm32f4xx_it.c`) and
//! compile. Plus engine-level allocation tests: F1 fixed matrix
//! (USART2_TX -> DMA1_Channel7), auto-pick, conflict/exhaustion diags.

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

fn prerequisites(pack_name: &str, fw_family: &str) -> Option<(IrPack, PathBuf)> {
    let pack = load_pack(pack_name)?;
    let fw_dir = repo_root().join("data").join("fw");
    if !fw_dir.join(fw_family).is_dir() {
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

/// The ODrive DMA slice on F405: UART4 with fully explicit request params
/// (the ioc pins everything), SPI3/ADC1 with minimal overrides so the db
/// alignment defaults (TEMP request/IP semaphores + SPI3 DataSize=16BIT)
/// must produce the reference HALFWORD values on their own. ADC1 keeps its
/// stream IRQ enabled but generates no handler — the reference it.c shape.
fn f405_dma_doc() -> ConfigDoc {
    serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "clock": {
            "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
            "targets": { "SYSCLK": { "hz": 168000000 } }
          },
          "peripherals": {
            "UART4": {
              "mode": "Asynchronous",
              "pins": { "TX": "PA0", "RX": "PA1" },
              "nvic": { "enabled": true, "preemptionPriority": 5 },
              "dma": {
                "UART4_RX": {
                  "instance": "DMA1_Stream2",
                  "direction": "DMA_PERIPH_TO_MEMORY",
                  "periphInc": "DMA_PINC_DISABLE",
                  "memInc": "DMA_MINC_ENABLE",
                  "periphDataAlignment": "DMA_PDATAALIGN_BYTE",
                  "memDataAlignment": "DMA_MDATAALIGN_BYTE",
                  "mode": "DMA_CIRCULAR",
                  "priority": "DMA_PRIORITY_LOW",
                  "fifoMode": "DMA_FIFOMODE_DISABLE",
                  "nvic": { "enabled": true, "preemptionPriority": 5 }
                },
                "UART4_TX": {
                  "instance": "DMA1_Stream4",
                  "direction": "DMA_MEMORY_TO_PERIPH",
                  "periphInc": "DMA_PINC_DISABLE",
                  "memInc": "DMA_MINC_ENABLE",
                  "periphDataAlignment": "DMA_PDATAALIGN_BYTE",
                  "memDataAlignment": "DMA_MDATAALIGN_BYTE",
                  "mode": "DMA_NORMAL",
                  "priority": "DMA_PRIORITY_LOW",
                  "fifoMode": "DMA_FIFOMODE_DISABLE",
                  "nvic": { "enabled": true, "preemptionPriority": 5 }
                }
              }
            },
            "SPI3": {
              "mode": "Full_Duplex_Master",
              "params": {
                "Mode": "SPI_MODE_MASTER",
                "DataSize": "SPI_DATASIZE_16BIT",
                "CLKPhase": "SPI_PHASE_2EDGE",
                "BaudRatePrescaler": "SPI_BAUDRATEPRESCALER_16"
              },
              "pins": { "SCK": "PC10", "MISO": "PC11", "MOSI": "PC12" },
              "nvic": { "enabled": true, "preemptionPriority": 5 },
              "dma": {
                "SPI3_RX": {
                  "instance": "DMA1_Stream0",
                  "priority": "DMA_PRIORITY_MEDIUM",
                  "nvic": { "enabled": true, "preemptionPriority": 5 }
                },
                "SPI3_TX": {
                  "instance": "DMA1_Stream5",
                  "priority": "DMA_PRIORITY_MEDIUM",
                  "nvic": { "enabled": true, "preemptionPriority": 5 }
                }
              }
            },
            "ADC1": {
              "mode": ["IN6"],
              "params": {
                "ClockPrescaler": "ADC_CLOCK_SYNC_PCLK_DIV4",
                "Resolution": "ADC_RESOLUTION_12B",
                "DataAlign": "ADC_DATAALIGN_RIGHT",
                "ScanConvMode": "DISABLE",
                "ContinuousConvMode": "DISABLE",
                "DiscontinuousConvMode": "DISABLE",
                "DMAContinuousRequests": "DISABLE",
                "EOCSelection": "ADC_EOC_SINGLE_CONV",
                "NbrOfConversion": 1,
                "ExternalTrigConv": "ADC_SOFTWARE_START",
                "ExternalTrigConvEdge": "ADC_EXTERNALTRIGCONVEDGE_NONE",
                "Channel-ChannelRegularConversion": "ADC_CHANNEL_6",
                "Rank-ChannelRegularConversion": 1,
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_3CYCLES"
              },
              "pins": { "IN6": "PA6" },
              "nvic": { "enabled": true, "preemptionPriority": 5 },
              "dma": {
                "ADC1": {
                  "instance": "DMA2_Stream0",
                  "mode": "DMA_CIRCULAR",
                  "nvic": { "enabled": true, "preemptionPriority": 5 },
                  "generateHandler": false
                }
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
    assert!(!has_errors(&resolved.diags), "config must validate clean");
    let manifest = generate_project(pack, &resolved, doc, fw_dir, out_dir, "0.1.0")
        .expect("generate_project");
    assert!(!manifest.files.is_empty());
}

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

fn build(out_dir: &Path) {
    run(
        out_dir,
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
    run(out_dir, "cmake", &["--build", "build"]);
    let elf = out_dir.join("build").join("app.elf");
    assert!(elf.is_file(), "missing linked ELF at {}", elf.display());
}

fn read(out_dir: &Path, rel: &str) -> String {
    std::fs::read_to_string(out_dir.join(rel))
        .unwrap_or_else(|e| panic!("missing {rel}: {e}"))
}

#[test]
fn f405_odrive_dma_set_matches_reference_and_compiles() {
    let Some((pack, fw_dir)) = prerequisites("stm32f4.irpack", "STM32F4") else { return };
    let doc = f405_dma_doc();
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("dma_gate_f405");
    generate(&pack, &doc, &fw_dir, &out_dir);

    // File split: DMA handles live in their OWNER's family file; dma.c has
    // only MX_DMA_Init (non-static, declared in dma.h).
    let main_c = read(&out_dir, "Core/Src/main.c");
    let usart_c = read(&out_dir, "Core/Src/usart.c");
    let spi_c = read(&out_dir, "Core/Src/spi.c");
    let adc_c = read(&out_dir, "Core/Src/adc.c");
    let dma_c = read(&out_dir, "Core/Src/dma.c");
    let dma_h = read(&out_dir, "Core/Inc/dma.h");
    assert!(usart_c.contains("DMA_HandleTypeDef hdma_uart4_rx;"), "usart.c:\n{usart_c}");
    assert!(usart_c.contains("DMA_HandleTypeDef hdma_uart4_tx;"));
    assert!(spi_c.contains("DMA_HandleTypeDef hdma_spi3_rx;"), "spi.c:\n{spi_c}");
    assert!(spi_c.contains("DMA_HandleTypeDef hdma_spi3_tx;"));
    assert!(adc_c.contains("DMA_HandleTypeDef hdma_adc1;"), "adc.c:\n{adc_c}");
    assert!(dma_h.contains("void MX_DMA_Init(void);"), "dma.h:\n{dma_h}");
    assert!(dma_c.contains("void MX_DMA_Init(void)"), "dma.c:\n{dma_c}");
    assert!(
        !dma_c.contains("DMA_HandleTypeDef"),
        "dma.c must not own DMA handles:\n{dma_c}"
    );
    let gpio_call = main_c.find("  MX_GPIO_Init();").expect("MX_GPIO_Init call");
    let dma_call = main_c.find("  MX_DMA_Init();").expect("MX_DMA_Init call");
    let first_periph = ["MX_ADC1_Init();", "MX_SPI3_Init();", "MX_UART4_Init();"]
        .iter()
        .map(|s| main_c.find(s).expect(s))
        .min()
        .unwrap();
    assert!(
        gpio_call < dma_call && dma_call < first_periph,
        "MX_DMA_Init must be called after MX_GPIO_Init and before peripheral inits"
    );

    // MX_DMA_Init body: dma.c reference — both controller clocks, NVIC rows
    // in (controller, stream) order.
    for line in [
        "__HAL_RCC_DMA1_CLK_ENABLE();",
        "__HAL_RCC_DMA2_CLK_ENABLE();",
        "/* DMA1_Stream0_IRQn interrupt configuration */",
        "HAL_NVIC_SetPriority(DMA1_Stream0_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(DMA1_Stream0_IRQn);",
        "HAL_NVIC_SetPriority(DMA1_Stream2_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(DMA1_Stream2_IRQn);",
        "HAL_NVIC_SetPriority(DMA1_Stream4_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(DMA1_Stream4_IRQn);",
        "HAL_NVIC_SetPriority(DMA1_Stream5_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(DMA1_Stream5_IRQn);",
        "HAL_NVIC_SetPriority(DMA2_Stream0_IRQn, 5, 0);",
        "HAL_NVIC_EnableIRQ(DMA2_Stream0_IRQn);",
    ] {
        assert!(dma_c.contains(line), "dma.c missing `{line}`:\n{dma_c}");
    }
    let s1 = dma_c.find("HAL_NVIC_SetPriority(DMA1_Stream0_IRQn").unwrap();
    let s2 = dma_c.find("HAL_NVIC_SetPriority(DMA1_Stream2_IRQn").unwrap();
    let s3 = dma_c.find("HAL_NVIC_SetPriority(DMA1_Stream4_IRQn").unwrap();
    let s4 = dma_c.find("HAL_NVIC_SetPriority(DMA1_Stream5_IRQn").unwrap();
    let s5 = dma_c.find("HAL_NVIC_SetPriority(DMA2_Stream0_IRQn").unwrap();
    assert!(s1 < s2 && s2 < s3 && s3 < s4 && s4 < s5, "NVIC rows must be stream-ordered");

    // MSP: reference usart.c/spi.c/adc.c hdma wiring, field for field —
    // each fill lives in its owner's family file since the split.
    let msp = format!("{usart_c}\n{spi_c}\n{adc_c}");
    for line in [
        // UART4 (explicit ioc values).
        "/* UART4 DMA Init */",
        "/* UART4_RX Init */",
        "hdma_uart4_rx.Instance = DMA1_Stream2;",
        "hdma_uart4_rx.Init.Channel = DMA_CHANNEL_4;",
        "hdma_uart4_rx.Init.Direction = DMA_PERIPH_TO_MEMORY;",
        "hdma_uart4_rx.Init.PeriphInc = DMA_PINC_DISABLE;",
        "hdma_uart4_rx.Init.MemInc = DMA_MINC_ENABLE;",
        "hdma_uart4_rx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;",
        "hdma_uart4_rx.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;",
        "hdma_uart4_rx.Init.Mode = DMA_CIRCULAR;",
        "hdma_uart4_rx.Init.Priority = DMA_PRIORITY_LOW;",
        "hdma_uart4_rx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;",
        "if (HAL_DMA_Init(&hdma_uart4_rx) != HAL_OK)",
        "__HAL_LINKDMA(uartHandle,hdmarx,hdma_uart4_rx);",
        "/* UART4_TX Init */",
        "hdma_uart4_tx.Instance = DMA1_Stream4;",
        "hdma_uart4_tx.Init.Channel = DMA_CHANNEL_4;",
        "hdma_uart4_tx.Init.Direction = DMA_MEMORY_TO_PERIPH;",
        "hdma_uart4_tx.Init.Mode = DMA_NORMAL;",
        "__HAL_LINKDMA(uartHandle,hdmatx,hdma_uart4_tx);",
        // SPI3 (db defaults must supply the halfword alignments via the
        // SPI3 DataSize=16BIT semaphore + TEMP IP semaphore).
        "/* SPI3 DMA Init */",
        "hdma_spi3_rx.Instance = DMA1_Stream0;",
        "hdma_spi3_rx.Init.Channel = DMA_CHANNEL_0;",
        "hdma_spi3_rx.Init.Direction = DMA_PERIPH_TO_MEMORY;",
        "hdma_spi3_rx.Init.PeriphInc = DMA_PINC_DISABLE;",
        "hdma_spi3_rx.Init.MemInc = DMA_MINC_ENABLE;",
        "hdma_spi3_rx.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;",
        "hdma_spi3_rx.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;",
        "hdma_spi3_rx.Init.Mode = DMA_NORMAL;",
        "hdma_spi3_rx.Init.Priority = DMA_PRIORITY_MEDIUM;",
        "hdma_spi3_rx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;",
        "__HAL_LINKDMA(spiHandle,hdmarx,hdma_spi3_rx);",
        "hdma_spi3_tx.Instance = DMA1_Stream5;",
        "hdma_spi3_tx.Init.Channel = DMA_CHANNEL_0;",
        "hdma_spi3_tx.Init.Direction = DMA_MEMORY_TO_PERIPH;",
        "hdma_spi3_tx.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;",
        "hdma_spi3_tx.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;",
        "hdma_spi3_tx.Init.Priority = DMA_PRIORITY_MEDIUM;",
        "__HAL_LINKDMA(spiHandle,hdmatx,hdma_spi3_tx);",
        // ADC1 (db defaults: HALFWORD via TEMP_ADC1_REQUEST_SEM; LINKDMA
        // field is DMA_Handle).
        "/* ADC1 DMA Init */",
        "/* ADC1 Init */",
        "hdma_adc1.Instance = DMA2_Stream0;",
        "hdma_adc1.Init.Channel = DMA_CHANNEL_0;",
        "hdma_adc1.Init.Direction = DMA_PERIPH_TO_MEMORY;",
        "hdma_adc1.Init.PeriphInc = DMA_PINC_DISABLE;",
        "hdma_adc1.Init.MemInc = DMA_MINC_ENABLE;",
        "hdma_adc1.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;",
        "hdma_adc1.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;",
        "hdma_adc1.Init.Mode = DMA_CIRCULAR;",
        "hdma_adc1.Init.Priority = DMA_PRIORITY_LOW;",
        "hdma_adc1.Init.FIFOMode = DMA_FIFOMODE_DISABLE;",
        "__HAL_LINKDMA(adcHandle,DMA_Handle,hdma_adc1);",
        // DeInit side.
        "HAL_DMA_DeInit(uartHandle->hdmarx);",
        "HAL_DMA_DeInit(uartHandle->hdmatx);",
        "HAL_DMA_DeInit(adcHandle->DMA_Handle);",
    ] {
        assert!(msp.contains(line), "msp missing `{line}`:\n{msp}");
    }
    // FIFO disabled => the threshold/burst trio must NOT be emitted
    // (db "null" defaults; reference stops at FIFOMode).
    for absent in ["FIFOThreshold", "MemBurst", "PeriphBurst"] {
        assert!(!msp.contains(absent), "msp must not emit `{absent}`:\n{msp}");
    }

    // it.c: handlers for the four DMA1 streams, none for DMA2_Stream0
    // (generateHandler=false, reference it.c), externs only for handled
    // streams.
    let it_c = read(&out_dir, "Core/Src/stm32f4xx_it.c");
    for line in [
        "extern DMA_HandleTypeDef hdma_uart4_rx;",
        "extern DMA_HandleTypeDef hdma_uart4_tx;",
        "extern DMA_HandleTypeDef hdma_spi3_rx;",
        "extern DMA_HandleTypeDef hdma_spi3_tx;",
        "void DMA1_Stream0_IRQHandler(void)",
        "HAL_DMA_IRQHandler(&hdma_spi3_rx);",
        "void DMA1_Stream2_IRQHandler(void)",
        "HAL_DMA_IRQHandler(&hdma_uart4_rx);",
        "void DMA1_Stream4_IRQHandler(void)",
        "HAL_DMA_IRQHandler(&hdma_uart4_tx);",
        "void DMA1_Stream5_IRQHandler(void)",
        "HAL_DMA_IRQHandler(&hdma_spi3_tx);",
    ] {
        assert!(it_c.contains(line), "it.c missing `{line}`:\n{it_c}");
    }
    assert!(
        !it_c.contains("DMA2_Stream0_IRQHandler"),
        "DMA2_Stream0 must have NVIC rows but no handler (reference):\n{it_c}"
    );
    assert!(
        !it_c.contains("extern DMA_HandleTypeDef hdma_adc1;"),
        "no handler => no hdma_adc1 extern (reference):\n{it_c}"
    );

    build(&out_dir);
}

// ---------------------------------------------------------------------------
// Engine-level allocation tests (no compile)
// ---------------------------------------------------------------------------

/// F1 channel matrix is fixed (no request mux): USART2_TX has exactly one
/// legal flow, DMA1_Channel7, and F1 requests carry no Channel macro.
#[test]
fn f103_usart2_tx_auto_allocates_dma1_channel7() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F103C8Tx" },
          "peripherals": {
            "USART2": {
              "mode": "Asynchronous",
              "pins": { "TX": "PA2", "RX": "PA3" },
              "dma": { "USART2_TX": {} }
            }
          }
        }"#,
    )
    .unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags));
    assert_eq!(resolved.dma.len(), 1);
    let d = &resolved.dma[0];
    assert_eq!(d.stream, "DMA1_Channel7");
    assert_eq!(d.controller, "DMA1");
    assert_eq!(d.channel_macro, None, "F1 has no request-mux channel");
    assert_eq!(d.handle_name, "hdma_usart2_tx");
    assert_eq!(d.link_field, "hdmatx");
    assert_eq!(d.irqn, "DMA1_Channel7_IRQn");
    assert_eq!(d.clock_enable, "__HAL_RCC_DMA1_CLK_ENABLE");
    assert_eq!(d.owner_instance, "USART2");
    assert_eq!(d.owner_signal, "TX");
    assert!(d.nvic.enabled, "DMA vectors default to enabled");
    assert!(d.generate_handler);
    assert_eq!(d.params.get("Direction").unwrap(), "DMA_MEMORY_TO_PERIPH");
    assert_eq!(d.params.get("PeriphDataAlignment").unwrap(), "DMA_PDATAALIGN_BYTE");
    assert_eq!(d.params.get("Mode").unwrap(), "DMA_NORMAL");
}

/// A user-pinned stream that the request cannot reach is rejected with the
/// legal alternatives; a pinned occupant starves an auto request with an
/// exhaustion diagnostic naming the contender.
#[test]
fn f405_dma_conflicts_are_diagnosed() {
    let Some(pack) = load_pack("stm32f4.irpack") else { return };
    // UART4_RX pinned to a stream it cannot use.
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "UART4": {
              "mode": "Asynchronous",
              "pins": { "TX": "PA0", "RX": "PA1" },
              "dma": { "UART4_RX": { "instance": "DMA1_Stream4" } }
            }
          }
        }"#,
    )
    .unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    assert!(
        resolved.diags.iter().any(|d| d.code == "DMA_STREAM_ILLEGAL"),
        "expected DMA_STREAM_ILLEGAL, got {:?}",
        resolved.diags
    );

    // SPI3_RX pins DMA1_Stream2 (its alternate flow), starving UART4_RX
    // whose only flow is DMA1_Stream2.
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "SPI3": {
              "mode": "Full_Duplex_Master",
              "params": { "Mode": "SPI_MODE_MASTER" },
              "pins": { "SCK": "PC10", "MISO": "PC11", "MOSI": "PC12" },
              "dma": { "SPI3_RX": { "instance": "DMA1_Stream2" } }
            },
            "UART4": {
              "mode": "Asynchronous",
              "pins": { "TX": "PA0", "RX": "PA1" },
              "dma": { "UART4_RX": {} }
            }
          }
        }"#,
    )
    .unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    let exhausted = resolved
        .diags
        .iter()
        .find(|d| d.code == "DMA_EXHAUSTED")
        .unwrap_or_else(|| panic!("expected DMA_EXHAUSTED, got {:?}", resolved.diags));
    assert!(
        exhausted.message.contains("SPI3_RX"),
        "exhaustion diag must name the contender: {}",
        exhausted.message
    );

    // A request configured under a peripheral that does not emit it.
    let doc: ConfigDoc = serde_json::from_str(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "UART4": {
              "mode": "Asynchronous",
              "pins": { "TX": "PA0", "RX": "PA1" },
              "dma": { "ADC1": {} }
            }
          }
        }"#,
    )
    .unwrap();
    let resolved = validate(&pack, &doc).expect("hard failure");
    assert!(
        resolved.diags.iter().any(|d| d.code == "DMA_REQUEST_OWNER"),
        "expected DMA_REQUEST_OWNER, got {:?}",
        resolved.diags
    );
}
