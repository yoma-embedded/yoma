All four areas mined. Findings below.

---

## Q1 — ip_tim: per-channel params, ConfigForMode activation, MspPostInit

**1a. Per-channel storage/resolution keying — CONTRADICTS_OURS (suffix is the full RefMode name, not "CH1")**

ip_tim has NO channel logic at all (94 lines total). It instantiates the generic engine and nothing else:

```java
public void onEnable() {
    if (this.paramManager == null) {
        this.paramManager = new ParamManager(this.ip);
    }
}
```
`D:/embedded_agent/java_code/decompiled/ip_tim/com/st/microxplorer/plugins/ip/tim/TIM.java`

Resolution context lives host-side on `RefParameter.getId()`. The plugin-visible key contract (filemanager ioc-compare builds the same keys the .ioc uses):

```java
String string = szNeededID = lRefParameter.getId() != null ? lRefParameter.getId() : "";
if (szNeededID.isEmpty()) {
    lAllParamUsed.add(lRefParameter.getName());
    continue;
}
lAllParamUsed.add(lRefParameter.getName() + "-" + szNeededID);
```
`D:/embedded_agent/java_code/decompiled/filemanager/com/st/microxplorer/plugins/filemanager/iocCompare/PeripheralsPane.java:135-140`

For TIM the id is the **full RefMode name**. Verified against the real ODrive ioc (`D:/embedded_agent/motorcontrol/odrive_cubemx_demo/odrive_cubemx_demo.ioc`):
```
TIM1.Pulse-PWM\ Generation1\ CH1\ CH1N   (not "Pulse-CH1")
TIM1.OCMode_PWM-PWM\ Generation1\ CH1\ CH1N=TIM_OCMODE_PWM2
```
The shared names (`Pulse`, `OCMode_PWM`) are per-RefMode `<Parameter>` references in the db, so "resolve in the RefMode context of the channel that pulled them" is right — CONFIRMS_OURS on the mechanism, but your config-key suffix must be the RefMode name string ("PWM Generation1 CH1", "PWM Generation1 CH1 CH1N", "Output Compare4 No Output"), which also varies with the pin/no-output variant. Plugin `Parameter.getUniqueId()` = bare concat `name + id` (`ipmanager/.../generictreatment/model/Parameter.java:713-715`); the "-" separator is the ioc/persistence convention.

**1b. Which ConfigForMode blocks are active — pure db-name references, activated by the RefMode being set**

`ConfigForMode` is nothing but a *name reference* from a RefMode to a RefConfig — see the schema mirror the thirdparty plugin ships:

```java
case "ConfigForMode": {
    this.addConfigForModeChild(subNode);   // inner class ConfigForMode holds only configForNodeName (text content)
```
`D:/embedded_agent/java_code/decompiled/thirdparty/com/st/ipmodeconfigmanager/xmlManager/ipmode/RefMode.java:84-86, 397-443`

Db side (verified in `D:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db/mcu/IP/TIM1_8-gptimer2_v2_x_Cube_Modes.xml:1971`):
```xml
<RefMode BaseMode="Counter_init" Name="PWM Generation1 CH1" HalMode="TIM_OC" Group="PWM Generation Channel 1">
  <ConfigForMode>TIM_MasterConfigSynchronization</ConfigForMode>
  <ConfigForMode>TIM_ConfigBreakDeadTime</ConfigForMode>
  <ConfigForMode>PWM_Init</ConfigForMode>
  <ConfigForMode>PWM_ConfigChannel_1</ConfigForMode>
  <ConfigForMode>setOC1Preload_PWM</ConfigForMode>
  <Parameter Name="Channel"><PossibleValue>TIM_CHANNEL_1</PossibleValue></Parameter>
  <Parameter Name="OCMode_PWM"/> <Parameter Name="Pulse"/> ...
```
Active blocks = union of ConfigForMode lists of the RefModes currently in the IP's mode set (set by the Pinout combo). The plugin contributes zero logic here; resolution RefMode→RefConfig is in the absent host (`com.st.microxplorer.mcu` + `codegenerator`). NEW_INSIGHT: `PWM_ConfigChannel_n` maps shared names via `MethodArg`: `<MethodArg Name="OCMode" ParameterName="OCMode_PWM"/>`, `OCPolarity ← OCPolarity_n` (`db/mcu/config/TIM-STM32F4xx_Configs.xml:200-210`) — `Pulse`/`Channel` have no MethodArg and bind by same-name lookup in the channel's RefMode context.

**1c. HAL_TIM_MspPostInit — NOT plugin-side; db-declared, host-owned**

`grep MspPostInit|PostInit` across the whole decompiled tree: **zero matches**. It is declared in the Configs db and rendered by the absent host CodeGenerator:
```xml
<RefConfig Name="PWM_Init">
  <CallLibMethod Name="HAL_TIM_PWM_Init" ReturnHAL="true" Type="HAL"/>
  <ImplementCallBack Name="HAL_TIM_PWM_MspInit"/>
  <ImplementCallBack Name="HAL_TIM_PWM_MspDeInit"/>
  <ImplementCallBack Name="HAL_TIM_MspPostInit"/>
</RefConfig>
```
`db/mcu/config/TIM-STM32F4xx_Configs.xml:99-104` (same in `OC_Init`, `OnePulse_Init`; absent from `Encoder_Init`/`HallSensor_Init`/`IC_Init`). So: MspPostInit is triggered whenever a RefMode pulling `PWM_Init`/`OC_Init`/`OnePulse_Init` is active; ownership/emission is host codegenerator (not in tree).

---

## Q2 — ip_adc: rank/conversion model, activation, NVIC, multimode

**2a. Slots & Rank-N# keying — CONFIRMS_OURS on key format; slots are dynamic Mode instances, ids never renumbered**

Each conversion "slot" is a dynamically created non-pinout `Mode` whose exactId is a **monotonic counter + "#" + RefMode name**:

```java
public void addIPMode(String refModeName, String mode, Integer rank) {
    String newId = this.ip.generateNewModeId() + "#" + refModeName;
    Mode modeToAdd = new Mode(this.ip, refModeName, newId);
    this.ip.listOfNonPinoutModes.add(modeToAdd);
    ...
    paramTmp.setCurrentValue(rank.toString());
    if (paramType.equalsIgnoreCase("integer")) {
        paramTmp.setMin((double)rank.intValue());
        paramTmp.setMax((double)rank.intValue());   // Rank pinned: min=max=rank
    }
```
`D:/embedded_agent/java_code/decompiled/ip_adc/com/st/microxplorer/plugins/ip/adc/model/ADCParamManager.java:1330-1347`

Confirms ioc keys `ADC1.Rank-0\#ChannelRegularConversion=1` (real ioc verified). NEW_INSIGHT: the counter is global per IP across regular AND injected (ODrive ioc: `Rank-0#ChannelRegularConversion`, `Rank-1#ChannelInjectedConversion`). Display ordering = numeric sort of the id prefix (`Arrays.sort(... Integer.valueOf(id1[0]).compareTo(...)` lines 188-196).

**Renumbering on NbrOfConversion change: there is none.** The view adds/deletes whole modes:

```java
if (Integer.parseInt(oldValue) < Integer.parseInt(newValue)) {
    int nbrOfConvToAdd = Integer.parseInt(newValue) - Integer.parseInt(oldValue);
    for (int i = 1; i <= nbrOfConvToAdd; ++i) {
        ... ((ADCParamManager)this.paramManager).addIPMode(subMode, mode, Integer.parseInt(oldValue) + i);
} else {
    int nbrOfConvToRemove = Integer.parseInt(oldValue) - Integer.parseInt(newValue);
    for (int j = 0; j < nbrOfConvToRemove; ++j) {
        int k = Integer.parseInt(oldValue) - j;
        this.deleteMode(k, mode);   // finds the property whose Rank VALUE == k, deletes that mode
```
`ip_adc/.../gui/ADCParametersView.java:315-352` (constants `NbrOfConversion` / `InjNumberOfConversion` lines 41-42). Grow appends ranks old+1..new; shrink deletes highest-rank modes. Mode ids are never reused/renumbered; the Rank *parameter value* is the sequencer position, the id prefix is just identity.

**2b. Regular/injected activation — CONTRADICTS_OURS ("channelSelected$IpInstance" auto-activation): it's imperative plugin code keyed on NbrOfConversionFlag/Enable\*Conversion, not semaphore-condition auto-activation**

`channelSelected` appears nowhere in the plugin tree nor in the F4 db (`grep channelSelected` → only unrelated ip_mdma UI hits). Instead:

- Auto-add of the first regular slot when none exists (version-gated):
```java
if (nbrConversionRefParam != null && this.ip.getParameterDisplayValue(nbrConversionRefParam, null).equals("0")
    && EnableRegularConversionRefParameter == null | (EnableRegularConversionRefParameter != null && regularModeEnable.equalsIgnoreCase("ENABLE"))) {
    subModes = this.getRefModeOfBaseMode("ADC_Regular_ConversionMode");
    this.addIPMode(subModes.get(0), "ADC_Regular_ConversionMode", 1);
    this.setParameterValue("NbrOfConversionFlag", "1", null);
```
`ADCParamManager.java:137-145` (`NbrOfConversionFlag` is an invisible db param, `ADC-aditf2_v1_1_Cube_Modes.xml:192`).
- Removal when disabled:
```java
if (this.ip.getName().equals("ADC") && EnableRegularConversionRefParameter != null && this.ip.getParameterDisplayValue(...).equals("DISABLE") ...) {
    for (Mode mode : modesUsed) { if (!mode.getInternalName().equals("ChannelRegularConversion")) continue; this.deleteMode(mode); }
    ... this.ip.setParameterValue(refPFlag, "0", null);   // NbrOfConversionFlag=0
    ... this.ip.setParameterValue(refPNRC, "1", null);    // NbrOfConversion=1
```
`ADCParamManager.java:1072-1088` (injected analog at 1058-1070; G0/WL/U0 `Sequencer==NOT_FULLY_CONFIGURABLE` wipes regular modes, 1090-1106).
- The db RefModes carry the ConfigForMode + param list only; "abstract" parents hold the shared trigger/count params:
```xml
<RefMode BaseMode="ADC_Regular_ConversionMode" ... Name="ChannelRegularConversion">
    <ConfigForMode>ADC_RegularChannelConfig</ConfigForMode>
    <Parameter Name="Rank"/><Parameter Name="Channel"/><Parameter Name="SamplingTime"/>
</RefMode>
```
`db/mcu/IP/ADC-aditf2_v1_1_Cube_Modes.xml:844-856`. So "one rank per RefMode instance" is right (CONFIRMS_OURS single-rank-per-instance), but injected supports multiple instances too (`InjNumberOfConversion` drives the same add/delete machinery).

Semaphores ARE used by ADC, but for clock/legality, plugin-owned: per-prescaler-value semaphores named `<value>_<instance>` (`ADCParamManager.checkClockPrescalerCondition:652-695`), `InjConv_areNotAllowed`, `isNotAllowed_16b14b12b10b/_12b10b/_8b/_6b` (710-801), `SEM_ADC_LOW_FREQ_2_8MHZ/_3_5MHZ` (1674-1696).

**2c. ADC_IRQn NVIC coupling — lives in the absent host (NVICService) + NVIC db, not ip_adc**

ip_adc contains zero NVIC/IRQ references (grep verified). The vector→IP binding is db data consumed by host `com.st.microxplorer.mcu.NVICService`:
```xml
<PossibleValue Comment="ADC1, ADC2 and ADC3 global interrupts" Value="ADC_IRQn:Y,3V:ADC1,ADC2,ADC3:ADC,ADC,ADC:ADC1,ADC2,ADC3"/>
```
`db/mcu/IP/NVIC-STM32F417_Modes.xml:74` (format: `IRQn : flags : instances : HAL handler/IP : contexts`). Plugin-side call contract to the host:
```java
this.nvic.setInterruptParameters(vector.getName(), vector.isEnabled(), vector.isEnabledByUser(),
    vector.getInterruptPreemptionPriority(), vector.getInterruptSubPriority(),
    vector.isPreemptionPriorityModifiedByUser(), vector.usesOsFunctions(), vector.isForced(), vector.isHalHandlerNeeded());
```
`ip_nvic/.../NvicTable.java:142`. Note `isForced()`/`isHalHandlerNeeded()` — vectors can be force-enabled by the host model, but that logic is not in this tree.

**2d. Multimode — plugin hardcodes master flag + propagation; codegen gated by db `$Index=1`**

- `master` is an invisible db param (`ADC-aditf2_v1_1_Cube_Modes.xml:362`) that the plugin force-sets:
```java
if (this.ip.getInstanceName().equals("ADC1")) {
    this.setParameterValue("master", "1", null);
} else if (this.ip.getInstanceName().equals("ADC3") && (this.ADCVersion.equals("aditf5_v1_1_Cube") || this.ADCVersion.equals("G4_aditf5_90_v1_0_Cube"))) {
    this.setParameterValue("master", "1", null);
}
```
`ADCParamManager.java:174-178`; `isMaster()` = `MasterList` default contains instance name (1467-1473).
- Group-based cross-instance propagation on every set: group `ADCs_Common_Settings` → hardcoded master/slave pairs; group `ADCsgroup` → all instances:
```java
if (paramGroup.equals("ADCs_Common_Settings")) {
    otherADC = this.getSlaveADCs(this.ip);
    for (IP adcx : otherADC) { if (!adcx.setParameterDisplayValue(parameter, id, value)) continue; ... }
```
`ADCParamManager.java:1222-1234`; pairs hardcoded per version family — `ADC1↔ADC2, ADC3↔ADC4, ADC3↔ADC5, ADC4↔ADC5` for aditf5-class, "all other ADCs" for F4-class (`getSlaveADCs:1240-1253`). UI marks common params read-only-except-master with injected red HTML text (`ADCParametersView.java:227-261`).
- Codegen side is db: `<RefMode Name="ADCs_Common_Settings"><Condition Expression="$Index=1 | $Index=2"/><ConfigForMode>multiMode</ConfigForMode>` and `<RefConfig Name="multiMode"><IFCondition Expression="$Index=1"><CallLibMethod Name="HAL_ADCEx_MultiModeConfigChannel"/></IFCondition>` (`ADC-aditf2_v1_1_Cube_Modes.xml:808-814`, `ADC-STM32F4xx_Configs.xml:3-7`) — multimode call emitted only for instance index 1.

---

## Q3 — Codegen contribution per plugin

**CONFIRMS host-side generation; plugins hand over (almost) nothing for TIM/ADC.** `IPUIPlugin.generateCode` default:
```java
public HashMap<String, HashMap<String, String>> generateCode(String path, IProgressBarMonitor monitor) {
    return null;
}
```
`ipmanager/.../pluginmanagement/IPUIPlugin.java:241-243`. Neither `TIM.java` nor `ADC.java` overrides it. The C-init content comes entirely from db `_Modes.xml` (RefMode→ConfigForMode) + `_Configs.xml` (`RefConfig` → `CallLibMethod` with `MethodArg` param mapping + full `LibMethod` argument struct trees + `ImplementCallBack`), rendered by the absent host `com.st.microxplorer.codegenerator.CodeGenerator`. Plugin-side hooks that DO exist:
- `IPUIPlugin.addTemplate(data, templateName, outputName)` builds `CodeInput(data, templatePath, outPutPath)` per `Context` (TrustZone Secure/NonSecure, BOOT/APPLI etc.) and `this.ip.setCodeInputList(inputs)` (`IPUIPlugin.java:81-121`) — used by middleware/utility plugins, not TIM/ADC.
- `BlockDiagram.generateCode` iterates all plugins, prefixes returned settings maps with context names, merges via `ValuesMap.mergeSettings` (`ipmanager/.../gui/BlockDiagram.java:1195-1219`).
- Host model objects `Config`/`LibMethod`/`Argument`/`RefConfigFile` are mutable through the IP: generic `ParamManager` clones/edits them for middleware tab duplication (`mwIp.getListOfRefConfigs()`, `cfg.getALLCalledLibMethod()`, `cfg.addLibMethod/removeLibMethod` — `ParamManager.java:860-871, 993-1010`), revealing the host contract: **an IP carries an ordered list of Config objects, each with an ordered LibMethod list whose Arguments bind by ParameterName/VariableName**. There is no plugin-side "ordered ConfigForMode list" handoff — ordering is host-resolved from the db.

---

## Q4 — Java-hardcoded behavior a data-driven engine would miss

1. **TIM trigger-source gate**: slave-controller modes (`External Clock Mode 1`, `Reset/Gated/Trigger/Combined...Mode`) require one of a hardcoded trigger list (`ITR0..ITR15, ETR1, TI1_ED, TI1FP1, TI2FP2, "ETR1 through Remap", "ETR1 through ADC Remap", "ETR1 through ADC or COMP Remap"`), else UI = "Please select a Trigger Source" and `mState="Error"` — `TIM.java:74-85`. Not in db.
2. **ADC auto-create first conversion slot** when `NbrOfConversionFlag=="0"` (+ sets flag to 1), incl. SDADC variants — `ADCParamManager.java:136-173`. The flag param itself is db, the behavior is Java.
3. **NbrOfConversion → mode add/delete machinery** entirely in `ADCParametersView.specifActionToAddorDeleteRank` (315-352); Rank pinned min=max at creation.
4. **master=1 forcing + hardcoded master/slave instance pairs + group-based value propagation** (174-178, 1222-1253); `ADCs_Common_Settings` editable only from ADC1/ADC3.
5. **Clock-legality semaphores computed from RCCService frequencies**: per-prescaler `"<VALUE>_<instance>"` vs `FadcConstraint` min/max (652-695, incl. H7 `ClockPrescalerADC3` special case at 657-659); injected-conversion resolution/AHB ratio rules (ADC/4 vs AHB for 16..10b, /3 for 8b, /2 for 6b → `InjConv_areNotAllowed`, `isNotAllowed_*`; 710-801); `SEM_ADC_LOW_FREQ_2_8MHZ/_3_5MHZ` thresholds (1674-1696). Db conditions consume these semaphores but the arithmetic is Java.
6. **Synthetic bookkeeping params written NoFire** (consumed by db conditions/codegen): `SelectedChannel` = pipe-joined available channels (1496-1514); `WDG2ChannelRn`/`WDG3ChannelRn`/`InjWDG2ChannelRn`/`InjWDG3ChannelRn` from `MonitoredBy` (1516-1567); `ChannelVREF/VBAT/TS/VDDCORE` + `CommonPathInternal` ("A|B" or `ADC_INTERNAL_NONE`, 1569-1650); `InjectedChannelsSelection` for SDADC (583-587, 646-650).
7. **Rank echo params per version**: setting `Rank` also writes `RankArg` = `ADC4_REGULAR_RANK_n` (U5/U0), `ADC_RANK_n` (WB0x/WL33), `ADC_REGULAR_RANK_n` (U0); setting `InjectedChannel` also writes `Rank{InjectedRank}_Channel` (`ADCParamManager.setParameterValue:1190-1219`).
8. **Channel availability derived from pinout modes by regex**, not db lists: `getAvailableChannel()` motif `IN.*` / bank-B `IN(\d)*b` (997-1043); WatchdogChannel choices rebuilt from currently configured regular/injected channels per `ChannelForWatchDog` (813-852). Note latent dead code: `removeChannel15_18` condition `&&`s three different version equals (1007) — can never be true.
9. **Version-string dispatch everywhere**: dozens of hardcoded `aditf*` version lists select which of the above run (e.g. 103-116, 595-612) — behavior forks that no db field expresses; also `CodeGenerator.isDBversionOlderThan("DB.4.0.70")` gating (597, 610).
10. **OPAMP sampling-time mirroring** (aditf5_v1_1/G4): swaps `SamplingTime`↔`SamplingTimeOPAMP` (+ injected variants) when the channel crosses to/from an OPAMP channel; OPAMP-ness detected by scanning the current-values map for keys containing "OPAMP" (228-294, 1660-1672). Also `SubFamily` set from the MCU name substring (73-84).
11. **fixQueueEnable** (aditf5_v2_0): `QueueInjectedContext==ENABLE` forces `InjectedQueueMode=ENABLE` (803-811).
12. **HAL_TIM_MspPostInit**, NVIC vector wiring, RefMode→Config resolution, `$Index`/`$IpInstance` expression evaluation: all in the absent host (`com.st.microxplorer.mcu`, `codegenerator`); plugin-side contract shows only `ip.parser.checkCondition/addSemaphoreWithOwner/removeSemaphore`, `ip.getAllRequiredRefParameters()` (id-stamped RefParameters), and `NVICService.setInterruptParameters(...)`.

Corrections to apply to our P2 design: (a) TIM config-key context = full RefMode name, not "CH1"; (b) ADC slot activation = imperative NbrOfConversionFlag/EnableXConversion logic, not `channelSelected$IpInstance` semaphore auto-activation (that semaphore name doesn't exist); (c) shrink deletes highest-Rank mode instances by Rank value with no id renumbering; (d) injected group is multi-slot too on F4 (up to 4).