//! P2 channel machinery, engine level: `-CHn` / `-{RefModeName}` suffix
//! mapping, per-RefMode value contexts (pinned > user-context > user-bare >
//! default), and ADC's auto-activated non-tree RefModes. Runs against the
//! real F4 pack; skips when data/stm32f4.irpack is absent.

use std::path::PathBuf;
use stm32ck_engine::config::ConfigDoc;
use stm32ck_engine::diag::has_errors;
use stm32ck_engine::session::validate;
use stm32ck_ir::model::IrPack;

fn load_f4() -> Option<IrPack> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("data")
        .join("stm32f4.irpack");
    if !path.is_file() {
        eprintln!("skip: {} not present (run the importer first)", path.display());
        return None;
    }
    let compressed = std::fs::read(path).unwrap();
    let bin = zstd::decode_all(compressed.as_slice()).unwrap();
    Some(postcard::from_bytes(&bin).unwrap())
}

fn doc(json: &str) -> ConfigDoc {
    serde_json::from_str(json).unwrap()
}

/// The ODrive TIM2 shape: shared param names (`Pulse`, `OCMode_PWM`) and
/// channel-indexed db spellings (`OCPolarity_3`) must land in the right
/// RefMode context via the `-CHn` suffix.
#[test]
fn tim_channel_suffix_maps_to_mode_contexts() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "TIM2": {
              "mode": ["PWM Generation3 CH3", "PWM Generation4 CH4"],
              "params": {
                "CounterMode": "TIM_COUNTERMODE_CENTERALIGNED3",
                "Period": 4096,
                "OCMode_PWM-CH3": "TIM_OCMODE_PWM2",
                "OCMode_PWM-CH4": "TIM_OCMODE_PWM2",
                "OCPolarity-CH3": "TIM_OCPOLARITY_LOW",
                "Pulse-CH4": 4097
              },
              "pins": { "CH3": "PB10", "CH4": "PB11" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    assert!(!has_errors(&r.diags), "diags: {:?}", r.diags);
    let tim2 = r.periphs.iter().find(|p| p.instance == "TIM2").unwrap();

    let ch3 = &tim2.mode_params["PWM Generation3 CH3"];
    let ch4 = &tim2.mode_params["PWM Generation4 CH4"];
    // Suffixed values land only in their channel's context.
    assert_eq!(ch3["OCPolarity_3"], "TIM_OCPOLARITY_LOW");
    assert_eq!(ch3["Pulse"], "0", "CH3 keeps the db default pulse");
    assert_eq!(ch4["Pulse"], "4097", "CH4 gets the suffixed pulse");
    assert_eq!(ch4["OCPolarity_4"], "TIM_OCPOLARITY_HIGH", "CH4 default");
    // Pinned Channel stays per-mode.
    assert_eq!(ch3["Channel"], "TIM_CHANNEL_3");
    assert_eq!(ch4["Channel"], "TIM_CHANNEL_4");
    // Bare (instance-wide) params reach every chain.
    assert_eq!(ch3["CounterMode"], "TIM_COUNTERMODE_CENTERALIGNED3");
    assert_eq!(ch4["CounterMode"], "TIM_COUNTERMODE_CENTERALIGNED3");
    // Flattened view = last chain in mode order (documented compat shape).
    assert_eq!(tim2.params["Pulse"], "4097");
}

/// Unknown channel suffixes are hard PARAM_UNKNOWN errors that name the
/// valid channel suffixes.
#[test]
fn unknown_channel_suffix_is_param_unknown() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "TIM2": {
              "mode": ["PWM Generation3 CH3"],
              "params": { "Pulse-CH5": 1 },
              "pins": { "CH3": "PB10" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    let hit = r.diags.iter().find(|x| {
        x.code == "PARAM_UNKNOWN" && x.path == "/peripherals/TIM2/params/Pulse-CH5"
    });
    let hit = hit.unwrap_or_else(|| panic!("expected PARAM_UNKNOWN, got {:?}", r.diags));
    assert!(
        hit.message.contains("CH3"),
        "diag should list the valid channel suffixes: {}",
        hit.message
    );
}

/// ADC's parameter-carrying RefModes are not mode-tree leaves; selecting a
/// channel input (IN6) plus suffix/bare params must auto-activate
/// ADC_Settings + ChannelRegularConversion + ChannelInjectedConversion, in
/// db doc order, with their ConfigForMode blocks owned by those modes.
#[test]
fn adc_conversion_refmodes_auto_activate() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6"],
              "params": {
                "ClockPrescaler": "ADC_CLOCK_SYNC_PCLK_DIV2",
                "NbrOfConversion": 1,
                "InjNumberOfConversion": 1,
                "Channel-ChannelRegularConversion": "ADC_CHANNEL_6",
                "Rank-ChannelRegularConversion": 1,
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_3CYCLES",
                "Channel-ChannelInjectedConversion": "ADC_CHANNEL_6",
                "InjectedRank-ChannelInjectedConversion": 1
              },
              "pins": { "IN6": "PA6" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    assert!(!has_errors(&r.diags), "diags: {:?}", r.diags);
    let adc = r.periphs.iter().find(|p| p.instance == "ADC1").unwrap();

    for m in ["ADC_Settings", "ChannelRegularConversion", "ChannelInjectedConversion"] {
        assert!(
            adc.active_modes.iter().any(|a| a == m),
            "{m} must auto-activate; active: {:?}",
            adc.active_modes
        );
    }
    // WatchDog / Copy modes must NOT fire without demand.
    for m in ["WatchDog", "ChannelRegularConversionCopy", "ADCs_Common_Settings"] {
        assert!(
            !adc.active_modes.iter().any(|a| a == m),
            "{m} must not auto-activate; active: {:?}",
            adc.active_modes
        );
    }
    // Blocks in db doc order with the right owners.
    let blocks: Vec<(&str, &str)> = adc
        .config_blocks
        .iter()
        .map(|b| (b.name.as_str(), b.owner.as_str()))
        .collect();
    assert_eq!(
        blocks,
        vec![
            ("ADC_RegularConfig", "ADC_Settings"),
            ("ADC_RegularChannelConfig", "ChannelRegularConversion"),
            ("ADC_InjectedChannelConfig", "ChannelInjectedConversion"),
        ]
    );
    // Shared `Channel` keeps per-mode identity: the IN6 leaf pins it, the
    // conversion contexts carry the user's suffixed values.
    assert_eq!(adc.mode_params["IN6"]["Channel"], "ADC_CHANNEL_6");
    assert_eq!(
        adc.mode_params["ChannelRegularConversion"]["Rank"], "1"
    );
    assert_eq!(
        adc.mode_params["ChannelInjectedConversion"]["InjectedRank"], "1"
    );
    assert_eq!(
        adc.mode_params["ChannelRegularConversion"]["SamplingTime"],
        "ADC_SAMPLETIME_3CYCLES"
    );
}

/// A 3-channel regular sequence instantiates ChannelRegularConversion once
/// per rank, each clone in its own `{i}#` scope with Rank seeded to i+1 and
/// Channel to the i-th IN mode's pinned value (user mode-array order); the
/// un-indexed `-ChannelRegularConversion` suffix broadcasts to every rank.
#[test]
fn adc_multi_rank_sequence_instantiates_scoped_chains() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6", "IN7", "IN8"],
              "params": {
                "ClockPrescaler": "ADC_CLOCK_SYNC_PCLK_DIV2",
                "NbrOfConversion": 3,
                "ScanConvMode": "ENABLE",
                "SamplingTime-ChannelRegularConversion": "ADC_SAMPLETIME_3CYCLES"
              },
              "pins": { "IN6": "PA6", "IN7": "PA7", "IN8": "PB0" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    assert!(!has_errors(&r.diags), "diags: {:?}", r.diags);
    assert!(
        !r.diags.iter().any(|x| x.code == "ADC_SEQUENCE_TRUNCATED"),
        "3 ranks are fully configured: {:?}",
        r.diags
    );
    assert!(
        !r.diags.iter().any(|x| x.code == "PARAM_INACTIVE"),
        "no param may be dropped: {:?}",
        r.diags
    );
    let adc = r.periphs.iter().find(|p| p.instance == "ADC1").unwrap();

    let blocks: Vec<(&str, &str)> = adc
        .config_blocks
        .iter()
        .map(|b| (b.name.as_str(), b.scope.as_str()))
        .collect();
    assert_eq!(
        blocks,
        vec![
            ("ADC_RegularConfig", "ADC_Settings"),
            ("ADC_RegularChannelConfig", "0#ChannelRegularConversion"),
            ("ADC_RegularChannelConfig", "1#ChannelRegularConversion"),
            ("ADC_RegularChannelConfig", "2#ChannelRegularConversion"),
        ]
    );
    for (i, ch) in [(0, "ADC_CHANNEL_6"), (1, "ADC_CHANNEL_7"), (2, "ADC_CHANNEL_8")] {
        let scope = format!("{i}#ChannelRegularConversion");
        let m = &adc.mode_params[&scope];
        assert_eq!(m["Channel"], ch, "rank {i} channel");
        assert_eq!(m["Rank"], (i + 1).to_string(), "rank {i} seed");
        assert_eq!(
            m["SamplingTime"], "ADC_SAMPLETIME_3CYCLES",
            "un-indexed suffix broadcasts to rank {i}"
        );
    }
    assert_eq!(adc.params["NbrOfConversion"], "3");
}

/// Single-rank configs stay on the single-chain path: the scope is the bare
/// RefMode name (no `{i}#`), which keeps pre-instantiation output identical.
#[test]
fn adc_single_rank_keeps_unindexed_scope() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6"],
              "params": {
                "NbrOfConversion": 1,
                "Channel-ChannelRegularConversion": "ADC_CHANNEL_6",
                "Rank-ChannelRegularConversion": 1
              },
              "pins": { "IN6": "PA6" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    assert!(!has_errors(&r.diags), "diags: {:?}", r.diags);
    let adc = r.periphs.iter().find(|p| p.instance == "ADC1").unwrap();
    assert!(
        adc.config_blocks
            .iter()
            .any(|b| b.name == "ADC_RegularChannelConfig"
                && b.scope == "ChannelRegularConversion"),
        "blocks: {:?}",
        adc.config_blocks
            .iter()
            .map(|b| (b.name.clone(), b.scope.clone()))
            .collect::<Vec<_>>()
    );
    assert!(
        adc.mode_params.keys().all(|k| !k.contains('#')),
        "no rank-indexed scopes on a single-rank config: {:?}",
        adc.mode_params.keys().collect::<Vec<_>>()
    );
}

/// NbrOfConversion above the number of channel sources still truncates —
/// and says how many ranks it COULD configure.
#[test]
fn adc_nbrofconversion_exceeding_channels_still_warns() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "ADC1": {
              "mode": ["IN6"],
              "params": { "NbrOfConversion": 3 },
              "pins": { "IN6": "PA6" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    let hit = r
        .diags
        .iter()
        .find(|x| x.code == "ADC_SEQUENCE_TRUNCATED")
        .unwrap_or_else(|| panic!("expected ADC_SEQUENCE_TRUNCATED, got {:?}", r.diags));
    assert!(
        hit.message.contains("only 1 rank"),
        "message should count configured ranks: {}",
        hit.message
    );
}

/// `$ModeExist_<mode>` device-existence semaphores: TIM's Encoder_Interface
/// leaf sits under "Multi-Channels", whose RemoveCondition is
/// `!($ModeExist_Encoder_Interface | ...)` — without the existence
/// semaphores the whole subtree pruned and the ODrive TIM3/TIM4 encoder
/// config reported MODE_UNKNOWN.
#[test]
fn encoder_interface_survives_mode_exist_removal() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "TIM3": {
              "mode": "Encoder_Interface",
              "params": {
                "EncoderMode": "TIM_ENCODERMODE_TI12",
                "IC1Polarity": "TIM_ICPOLARITY_RISING",
                "IC2Polarity": "TIM_ICPOLARITY_RISING",
                "IC1Filter": 4,
                "IC2Filter": 4,
                "Period": "0xffff"
              },
              "pins": { "CH1": "PB4", "CH2": "PB5" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    assert!(!has_errors(&r.diags), "diags: {:?}", r.diags);
    let tim3 = r.periphs.iter().find(|p| p.instance == "TIM3").unwrap();
    assert!(tim3.active_modes.iter().any(|m| m == "Encoder_Interface"));
    assert_eq!(tim3.hal_mode.as_deref(), Some("TIM_Encoder"));
    let enc = &tim3.mode_params["Encoder_Interface"];
    assert_eq!(enc["EncoderMode"], "TIM_ENCODERMODE_TI12");
    // Hex period passes numeric range validation (0xffff <= 0xFFFFFFFF).
    assert_eq!(enc["Period"], "0xffff");
    // Both encoder inputs demanded.
    for short in ["CH1", "CH2"] {
        assert!(
            tim3.signals.iter().any(|s| s.short == short),
            "missing demanded signal {short}: {:?}",
            tim3.signals
        );
    }
}

/// Context precedence within one chain: pinned beats user, user-context
/// beats user-bare, user-bare beats the db default.
#[test]
fn context_precedence_pinned_context_bare_default() {
    let Some(pack) = load_f4() else { return };
    let d = doc(
        r#"{
          "schemaVersion": 1,
          "mcu": { "part": "STM32F405RGTx" },
          "peripherals": {
            "TIM3": {
              "mode": ["PWM Generation1 CH1", "PWM Generation2 CH2"],
              "params": {
                "Pulse": 7,
                "Pulse-CH2": 42,
                "Channel-CH1": "TIM_CHANNEL_4"
              },
              "pins": { "CH1": "PA6", "CH2": "PA7" }
            }
          }
        }"#,
    );
    let r = validate(&pack, &d).expect("hard failure");
    let tim3 = r.periphs.iter().find(|p| p.instance == "TIM3").unwrap();
    let ch1 = &tim3.mode_params["PWM Generation1 CH1"];
    let ch2 = &tim3.mode_params["PWM Generation2 CH2"];
    // Pinned wins over the user's attempt to override Channel.
    assert_eq!(ch1["Channel"], "TIM_CHANNEL_1");
    // Context value beats the bare value; bare value beats the default.
    assert_eq!(ch1["Pulse"], "7");
    assert_eq!(ch2["Pulse"], "42");
}
