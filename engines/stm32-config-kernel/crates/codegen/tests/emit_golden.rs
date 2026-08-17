//! Golden emission tests against the real F1 IR pack (BluePill class):
//! the same 72 MHz HSE + USART1 + PC13 LED document as
//! engine/tests/f103_golden.rs, pushed through `emit_all`. Tests skip when
//! `data/stm32f1.irpack` is absent (run the importer first).

use std::collections::BTreeMap;
use std::path::PathBuf;
use stm32ck_codegen::emit::emit_all;
use stm32ck_codegen::GenCtx;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::{validate, Resolved};
use stm32ck_ir::model::IrPack;

fn load_pack(name: &str) -> Option<IrPack> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("data")
        .join(name);
    if !path.is_file() {
        eprintln!("skip: {} not present (run the importer first)", path.display());
        return None;
    }
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn golden_doc() -> ConfigDoc {
    serde_json::from_str(
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
    .unwrap()
}

/// Validate + emit; returns rel_path -> content.
fn emit(pack: &IrPack, doc: &ConfigDoc) -> (BTreeMap<String, String>, usize) {
    let resolved: Resolved<'_> = validate(pack, doc).expect("hard failure");
    for d in &resolved.diags {
        eprintln!("diag: {:?} {} {} {}", d.severity, d.code, d.path, d.message);
    }
    assert!(!has_errors(&resolved.diags), "golden config must be clean");
    let ctx = GenCtx {
        pack,
        resolved: &resolved,
        doc,
        kernel_version: "0.0.0-test",
        fw: None,
    };
    let files = emit_all(&ctx).expect("emit_all");
    let n = files.len();
    (
        files.into_iter().map(|f| (f.rel_path, f.content)).collect(),
        n,
    )
}

#[test]
fn f103_golden_file_set() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let (files, n) = emit(&pack, &golden_doc());
    assert_eq!(n, files.len(), "duplicate rel_path in emission");
    for expected in [
        "Core/Inc/main.h",
        "Core/Src/main.c",
        "Core/Inc/gpio.h",
        "Core/Src/gpio.c",
        "Core/Inc/usart.h",
        "Core/Src/usart.c",
        "Core/Src/stm32f1xx_hal_msp.c",
        "Core/Inc/stm32f1xx_it.h",
        "Core/Src/stm32f1xx_it.c",
        "Core/Inc/stm32f1xx_hal_conf.h",
        "Core/Src/syscalls.c",
        "Core/Src/sysmem.c",
    ] {
        assert!(files.contains_key(expected), "missing {expected}: {:?}", files.keys());
    }
}

#[test]
fn f103_golden_main_c() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let (files, _) = emit(&pack, &golden_doc());
    let main_c = &files["Core/Src/main.c"];

    // File split: the handle + MX body live in usart.c; main.c includes the
    // coupled headers (gpio.h LAST) and calls the inits.
    let usart_c = &files["Core/Src/usart.c"];
    let usart_h = &files["Core/Inc/usart.h"];
    assert!(usart_c.contains("UART_HandleTypeDef huart1;"), "usart.c:\n{usart_c}");
    assert!(usart_h.contains("extern UART_HandleTypeDef huart1;"), "usart.h:\n{usart_h}");
    assert!(usart_h.contains("void MX_USART1_UART_Init(void);"));
    assert!(main_c.contains("#include \"usart.h\""), "main.c:\n{main_c}");
    assert!(main_c.contains("#include \"gpio.h\""));
    let usart_inc = main_c.find("#include \"usart.h\"").unwrap();
    let gpio_inc = main_c.find("#include \"gpio.h\"").unwrap();
    assert!(usart_inc < gpio_inc, "gpio.h must be the LAST coupled include");
    assert!(main_c.contains("MX_GPIO_Init();"));
    assert!(main_c.contains("MX_USART1_UART_Init();"));
    assert!(usart_c.contains("huart1.Instance = USART1;"));
    assert!(usart_c.contains("huart1.Init.BaudRate = 115200;"));
    assert!(usart_c.contains("huart1.Init.WordLength = UART_WORDLENGTH_8B;"));
    assert!(usart_c.contains("huart1.Init.StopBits = UART_STOPBITS_1;"));
    assert!(usart_c.contains("huart1.Init.Parity = UART_PARITY_NONE;"));
    assert!(usart_c.contains("huart1.Init.Mode = UART_MODE_TX_RX;"));
    assert!(usart_c.contains("huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;"));
    assert!(usart_c.contains("huart1.Init.OverSampling = UART_OVERSAMPLING_16;"));
    assert!(usart_c.contains("if (HAL_UART_Init(&huart1) != HAL_OK)"));

    // Clock config from the resolved clock state.
    assert!(main_c.contains("RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE|RCC_OSCILLATORTYPE_HSI;"));
    assert!(main_c.contains("RCC_OscInitStruct.HSEState = RCC_HSE_ON;"));
    assert!(main_c.contains("RCC_OscInitStruct.HSEPredivValue = RCC_HSE_PREDIV_DIV1;"));
    assert!(main_c.contains("RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;"));
    assert!(main_c.contains("RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;"));
    assert!(main_c.contains("RCC_OscInitStruct.PLL.PLLMUL = RCC_PLL_MUL9;"));
    assert!(main_c.contains("RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;"));
    assert!(main_c.contains("RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;"));
    assert!(main_c.contains("RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;"));
    assert!(main_c.contains("RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;"));
    assert!(main_c.contains("FLASH_LATENCY_2"));

    // USER CODE anchors.
    for tag in [
        "/* USER CODE BEGIN Includes */",
        "/* USER CODE BEGIN PTD */",
        "/* USER CODE BEGIN PD */",
        "/* USER CODE BEGIN PM */",
        "/* USER CODE BEGIN PV */",
        "/* USER CODE BEGIN PFP */",
        "/* USER CODE BEGIN 0 */",
        "/* USER CODE BEGIN 1 */",
        "/* USER CODE BEGIN 2 */",
        "/* USER CODE BEGIN 3 */",
        "/* USER CODE BEGIN 4 */",
        "/* USER CODE BEGIN WHILE */",
        "/* USER CODE END WHILE */",
        "/* USER CODE BEGIN SysInit */",
        "/* USER CODE BEGIN Init */",
    ] {
        assert!(main_c.contains(tag), "main.c missing anchor {tag}");
    }
    for tag in [
        "/* USER CODE BEGIN USART1_Init 0 */",
        "/* USER CODE BEGIN USART1_Init 1 */",
        "/* USER CODE BEGIN USART1_Init 2 */",
    ] {
        assert!(usart_c.contains(tag), "usart.c missing anchor {tag}");
    }

    insta::assert_snapshot!("f103_main_c", main_c);
    insta::assert_snapshot!("f103_usart_c", usart_c);
}

#[test]
fn f103_golden_msp_c() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let (files, _) = emit(&pack, &golden_doc());
    let msp = &files["Core/Src/stm32f1xx_hal_msp.c"];

    // Global MSP: SYS-instance clock enables from the IR (F1: AFIO + PWR).
    assert!(msp.contains("void HAL_MspInit(void)"), "msp:\n{msp}");
    assert!(msp.contains("__HAL_RCC_AFIO_CLK_ENABLE();"));
    assert!(msp.contains("__HAL_RCC_PWR_CLK_ENABLE();"));
    // Since the file split the peripheral Msp callbacks live in usart.c.
    assert!(!msp.contains("HAL_UART_MspInit"), "msp must only hold HAL_MspInit:\n{msp}");
    let msp = &files["Core/Src/usart.c"];

    // UART MSP: clock enable -> port clock -> GPIO init -> NVIC.
    assert!(msp.contains("void HAL_UART_MspInit(UART_HandleTypeDef* uartHandle)"));
    assert!(msp.contains("if(uartHandle->Instance==USART1)"));
    assert!(msp.contains("__HAL_RCC_USART1_CLK_ENABLE();"));
    assert!(msp.contains("__HAL_RCC_GPIOA_CLK_ENABLE();"));
    // TX PA9: alternate-function push-pull (F1 has no .Alternate field).
    assert!(msp.contains("GPIO_InitStruct.Pin = GPIO_PIN_9;"));
    assert!(msp.contains("GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;"));
    assert!(!msp.contains(".Alternate ="), "F1 GPIO init must not set Alternate");
    // RX PA10: input floating.
    assert!(msp.contains("GPIO_InitStruct.Pin = GPIO_PIN_10;"));
    assert!(msp.contains("GPIO_InitStruct.Mode = GPIO_MODE_INPUT;"));
    assert!(msp.contains("HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);"));
    // Default remap: no AFIO remap statement.
    assert!(!msp.contains("__HAL_AFIO_REMAP_USART1_ENABLE();"));
    // NVIC from the resolved vector (preemption 1, sub 0).
    assert!(msp.contains("HAL_NVIC_SetPriority(USART1_IRQn, 1, 0);"));
    assert!(msp.contains("HAL_NVIC_EnableIRQ(USART1_IRQn);"));

    // DeInit mirror.
    assert!(msp.contains("void HAL_UART_MspDeInit(UART_HandleTypeDef* uartHandle)"));
    assert!(msp.contains("__HAL_RCC_USART1_CLK_DISABLE();"));
    assert!(msp.contains("HAL_GPIO_DeInit(GPIOA, GPIO_PIN_9|GPIO_PIN_10);"));
    assert!(msp.contains("HAL_NVIC_DisableIRQ(USART1_IRQn);"));

    insta::assert_snapshot!("f103_msp_c", &files["Core/Src/stm32f1xx_hal_msp.c"]);
}

#[test]
fn f103_golden_it_c() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let (files, _) = emit(&pack, &golden_doc());
    let it_c = &files["Core/Src/stm32f1xx_it.c"];
    let it_h = &files["Core/Inc/stm32f1xx_it.h"];

    for h in [
        "void NMI_Handler(void)",
        "void HardFault_Handler(void)",
        "void SVC_Handler(void)",
        "void DebugMon_Handler(void)",
        "void PendSV_Handler(void)",
        "void SysTick_Handler(void)",
        "void USART1_IRQHandler(void)",
    ] {
        assert!(it_c.contains(h), "it.c missing {h}:\n{it_c}");
        assert!(it_h.contains(&format!("{};", &h[5..])), "it.h missing prototype for {h}");
    }
    assert!(it_c.contains("HAL_IncTick();"));
    assert!(it_c.contains("extern UART_HandleTypeDef huart1;"));
    assert!(it_c.contains("HAL_UART_IRQHandler(&huart1);"));

    insta::assert_snapshot!("f103_it_c", it_c);
}

#[test]
fn f103_golden_main_h_and_conf() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let (files, _) = emit(&pack, &golden_doc());
    let main_h = &files["Core/Inc/main.h"];
    assert!(main_h.contains("#include \"stm32f1xx_hal.h\""), "main.h:\n{main_h}");
    assert!(main_h.contains("#define LED_Pin GPIO_PIN_13"));
    assert!(main_h.contains("#define LED_GPIO_Port GPIOC"));
    assert!(main_h.contains("#define USART1_TX_Pin GPIO_PIN_9"));
    assert!(main_h.contains("#define USART1_TX_GPIO_Port GPIOA"));
    assert!(main_h.contains("void Error_Handler(void);"));

    let conf = &files["Core/Inc/stm32f1xx_hal_conf.h"];
    for m in ["HAL_MODULE_ENABLED", "HAL_RCC_MODULE_ENABLED", "HAL_GPIO_MODULE_ENABLED",
              "HAL_CORTEX_MODULE_ENABLED", "HAL_FLASH_MODULE_ENABLED", "HAL_PWR_MODULE_ENABLED",
              "HAL_DMA_MODULE_ENABLED", "HAL_UART_MODULE_ENABLED"] {
        assert!(conf.contains(&format!("#define {m}")), "conf missing {m}");
    }
    // Unused modules stay off.
    assert!(!conf.contains("#define HAL_SPI_MODULE_ENABLED"));
    assert!(!conf.contains("#define HAL_ADC_MODULE_ENABLED"));
    assert!(conf.contains("#define HSE_VALUE    8000000U"));
    assert!(conf.contains("#define  VDD_VALUE                    3300U"));
    assert!(conf.contains("#include \"stm32f1xx_hal_uart.h\""));
    assert!(conf.contains("assert_param"));

    let gpio_c = &files["Core/Src/gpio.c"];
    assert!(gpio_c.contains("void MX_GPIO_Init(void)"));
    assert!(gpio_c.contains("__HAL_RCC_GPIOC_CLK_ENABLE();"));
    assert!(gpio_c.contains("HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, GPIO_PIN_SET);"));
    assert!(gpio_c.contains("GPIO_InitStruct.Pin = LED_Pin;"));
    assert!(gpio_c.contains("GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;"));
    assert!(gpio_c.contains("HAL_GPIO_Init(LED_GPIO_Port, &GPIO_InitStruct);"));
}

#[test]
fn f103_remap_emits_afio_macro() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let mut doc = golden_doc();
    let usart = doc.peripherals.get_mut("USART1").unwrap();
    usart.pins.insert("TX".into(), "PB6".into());
    usart.pins.insert("RX".into(), "PB7".into());
    let (files, _) = emit(&pack, &doc);
    let msp = &files["Core/Src/usart.c"];
    assert!(msp.contains("__HAL_RCC_GPIOB_CLK_ENABLE();"), "msp:\n{msp}");
    assert!(msp.contains("GPIO_InitStruct.Pin = GPIO_PIN_6;"));
    assert!(msp.contains("__HAL_RCC_AFIO_CLK_ENABLE();"));
    assert!(msp.contains("__HAL_AFIO_REMAP_USART1_ENABLE();"));
}

#[test]
fn emission_is_deterministic() {
    let Some(pack) = load_pack("stm32f1.irpack") else { return };
    let doc = golden_doc();
    let (a, _) = emit(&pack, &doc);
    let (b, _) = emit(&pack, &doc);
    assert_eq!(a, b, "same input must produce byte-identical output");
}
