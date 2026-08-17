FINDINGS — USB Device middleware (CubeMX). Sources: decompiled Java at D:/embedded_agent/java_code/decompiled + CubeMX db at D:/Program Files/STMicroelectronics/STM32Cube/STM32CubeMX/db (templates + IP XML; needed because the codegen driver is host-side).

## Q1. Owning plugin + CLASS_NAME_FS selection

**VERDICT: NEW_INSIGHT.** There is NO dedicated USB_DEVICE Java plugin. No `usbdevice` jar exists under plugins/ip (verified `ls .../plugins/ip`), and no decompiled dir matches. USB_DEVICE is a pure **data-driven middleware**: GUI comes from the catch-all `ip_genericplugin` (ipMatch `.*`) which projects Modes.xml RefParameters into a table and has **no generateCode override** — codegen is entirely host `CodeGenerator` (absent from tree) + db XML + FTL.
- `D:/embedded_agent/java_code/decompiled/ip_genericplugin/com/st/microxplorer/plugins/ip/genericplugin/GenericPlugin.java`:
```java
public void onEnable() {
    if (this.paramManager == null) {
        this.paramManager = new ParamManager(this.ip);
    }
}
```
(no `generateCode` in class); `main()` registers `String ipMatch = ".*";`.
- Selection chain (all in db, host-executed): `db/mcu/STM32F405RGTx.xml` → `<IP ConfigFile="USB_DEVICE-STM32F4xx" InstanceName="USB_DEVICE" Name="USB_DEVICE" Version="v1.0_Cube"/>`; `db/mcu/IP/USB_DEVICE-v1.0_Cube_Modes.xml` → `<RefMode Name="CDC_FS"><ConfigForMode>USB_DEVICE_CDC_FS</ConfigForMode> ... <Parameter Name="CLASS_NAME_FS"><PossibleValue>CDC</PossibleValue></Parameter>`; `db/mcu/config/USB_DEVICE-STM32F4xx_Configs.xml` → `<RefConfig Comment="CDC" Name="USB_DEVICE_CDC_FS">` listing exactly: `ConfigFile USBD_CONF_CDC_H, USBD_CONF_FS_C, USBD_DESC_H, USBD_DESC_C, USBD_DESC_FS_H, USBD_DESC_CDC_FS_C, USBD_INF_CDC_H_FS, USBD_INF_CDC_C_FS` + `<Component Name="Middlewares:USB_DEVICE:CDC"/>` + 4 `CallLibMethod` (USBD_Init/USBD_RegisterClass/USBD_CDC_RegisterInterface/USBD_Start). So CLASS_NAME_FS=CDC in .ioc is the RefMode's hidden parameter; file selection is via mode→RefConfig, not by reading CLASS_NAME_FS directly.
- MX_USB_DEVICE_Init body is rendered by `db/templates/usbdevice_c.ftl` from the CallLibMethod list: line 324 `if (${return}${method.name}(${args}) != USBD_OK)` / line 326 `Error_Handler();`; PreTreatment/PostTreatment USER CODE at lines 482-484. CONFIRMS_OURS on §4.1 shape. `usbdevice_h.ftl:98 void MX_USB_DEVICE_Init(void);`.
- Ioc-key naming (spec table): shared params have no suffix in db (`RefParameter Name="VID" DefaultValue="1155"`, `MANUFACTURER_STRING`, `LANGID_STRING` in Modes.xml:130-144); `.ioc` suffix `-CDC_FS` is the host's mode-scoping. Per-class params are literally `PID_CDC_FS`, `PRODUCT_STRING_CDC_FS` (Modes.xml:191,347).

## Q2. usbd_desc.c — template + params

**VERDICT: mostly CONFIRMS_OURS, one CONTRADICTS_OURS.** Template `db/templates/usbddesc_c.ftl` (selected via Configs.xml `USBD_DESC_C` + `USBD_DESC_CDC_FS_C`).
- Define emission is generic over the SWIP defines list (usbddesc_c.ftl:93-103):
```
[#elseif  definition.type=="stringRW"]
#define USBD_${definition.paramName} #t#t"${value}"
[#else]
#define USBD_${definition.paramName} #t#t${value}
```
- Renaming to `_FS` names is db-side, not template: Configs.xml `USBD_DESC_CDC_FS_C` → `<Argument Name="PID_CDC_FS" ParamName="PID_FS"/> <Argument Name="PRODUCT_STRING_CDC_FS" ParamName="PRODUCT_STRING_FS"/> <Argument Name="CONFIGURATION_STRING_CDC_FS" ParamName="CONFIGURATION_STRING_FS"/> <Argument Name="INTERFACE_STRING_CDC_FS" ParamName="INTERFACE_STRING_FS"/>` → yields `USBD_PID_FS`, `USBD_PRODUCT_STRING_FS`, `USBD_CONFIGURATION_STRING_FS`, `USBD_INTERFACE_STRING_FS`. NOTE (minor CONTRADICTS_OURS §4.2): "CDC Config"/"CDC Interface" are NOT derived from class name in code — they are the **DefaultValue of real ioc parameters** `CONFIGURATION_STRING_CDC_FS` / `INTERFACE_STRING_CDC_FS` (Modes.xml:353-356, `DefaultValue="CDC Config"`). Treat them as parameterized with class-specific defaults.
- SERIALNUMBER_STRING_CDC_FS: CONFIRMS_OURS — grep of USB_DEVICE-STM32F4xx_Configs.xml for `SERIALNUMBER` = zero hits; it is GUI-only, never passed to any template.
- UID serial: CONTRADICTS_OURS for current CubeMX (ODrive reference used an old version). usbddesc_c.ftl:728-740:
```
[#if cpucore=="ARM_CORTEX_M4"]
/* USER CODE BEGIN SerialNum */
  deviceserial0 = DEVICE_SERIAL0;
  ...
[#elseif cpucore=="ARM_CORTEX_M7" | CLASS_FS!="CDC" | CLASS_HS!="CDC"]
  deviceserial0 = *(uint32_t *) DEVICE_ID1;
```
On Cortex-M4 today it emits `deviceserial0 = DEVICE_SERIAL0;` (inside `USER CODE SerialNum`), with `#define DEVICE_SERIAL0 (0x11223344)`-style defines from params `DEVICE_SERIAL0/1/2_CDC_FS` (Modes.xml:359-367, gated `<Condition Expression="$IpInstance_Cortex_M4">`). The UID branch (`DEVICE_ID1/2/3`) is for M7/non-CDC. `usbddesc_h.ftl:59-61` still always defines `#define DEVICE_ID1 (UID_BASE)` `(UID_BASE+0x4)` `(UID_BASE+0x8)`. The `deviceserial0 += deviceserial2; IntToUnicode(...,&USBD_StringSerial[2],8); IntToUnicode(...,&USBD_StringSerial[18],4);` tail (usbddesc_c.ftl:742-747) CONFIRMS_OURS. For ODrive byte-parity you must reproduce the OLD template output (UID reads), not the current one.
- FS_Desc struct with conditional BOS entry gated `family?contains("STM32F4")...` + `USBD_LPM_ENABLED == 1` (usbddesc_c.ftl:180-205, 700-714): CONFIRMS_OURS.

## Q3. usbd_conf.c — PCD glue + FIFO

**VERDICT: CONFIRMS_OURS + NEW_INSIGHT on the mechanism.** Template `db/templates/usbdconf_f4_c.ftl` (per-family template chosen by each family's Configs.xml: usbdconf_f0/f1/f3/f4/f7/h7/l4/... — that IS the per-family variance mechanism).
- FIFO sizing is **hardcoded in the template**, per speed, class-independent (usbdconf_f4_c.ftl:390-392, 416-418):
```
#tHAL_PCDEx_SetRxFiFo(&hpcd_USB_OTG_FS, 0x80);
#tHAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 0, 0x40);
#tHAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 1, 0x80);
```
(HS: 0x200/0x80/0x174). Not computed. CONFIRMS_OURS 0x80/0x40/0x80.
- NEW_INSIGHT — the `hpcd` init body and HAL_PCD_MspInit are NOT in the template: they are host-generated tmp fragments included at render time (usbdconf_f4_c.ftl:370 and 130-136):
```
#t[#include mxTmpFolder+"/usb_otg_fs_HalInit.tmp"]
...
/* MSP Init */
[#if handleNameFS == "FS"] ... [#include mxTmpFolder+"/usb_otg_fs_Msp.tmp"]
```
plus `usb_otg_fs_vars.tmp` for the `PCD_HandleTypeDef hpcd_USB_OTG_FS;` declaration (line 98). The absent host `com.st.microxplorer.codegenerator` renders the USB_OTG_FS **peripheral IP's** init/MSP (the same content that would otherwise be `MX_USB_OTG_FS_PCD_Init` + `HAL_PCD_MspInit` in msp.c) into `mxTmpFolder/*.tmp`, and the middleware template embeds them into `USBD_LL_Init`/usbd_conf.c. The Init field values are USB_OTG_FS IP RefParameters, e.g. `db/mcu/IP/USB_OTG_FS-otgfs1_v1_2_Cube_Modes.xml:17 <RefParameter Comment="Device endpoints number" DefaultValue="4" Name="dev_endpoints" ...>`, `:92 phy_itface DefaultValue="PCD_PHY_EMBEDDED"`, `:133/137 vbus_sensing_enable` conditioned on `(VirtualMode = Device_Only) & VBUS_SENSING_ON` → ENABLE else DISABLE. So in your Rust design: generate the PCD init struct from USB_OTG_FS peripheral config and splice it into usbd_conf.c; do NOT emit a standalone MX_USB_OTG_FS_PCD_Init.
- Callback glue: all `#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U) static void PCD_Xxx #else void HAL_PCD_Xxx #endif` pairs verbatim in template (e.g. lines 215-219). Reset callback: F405 is `<Die>DIE413</Die>` → generic branch (HIGH/FULL map + Error_Handler; the strict FS-only variant is only for DIE423/463/441/431) — CONFIRMS_OURS. Suspend `__HAL_PCD_GATE_PHYCLOCK(hpcd);` then `low_power_enable` SCB code inside `/* USER CODE BEGIN 2 */` (lines 270-278) — CONFIRMS_OURS. `USBD_Get_USB_Status` prototype inside `/* USER CODE BEGIN PFP */` (lines 116-119) — CONFIRMS_OURS verbatim. `USBD_static_malloc` is class-switched: line 788 `static uint32_t mem[(sizeof(USBD_CDC_HandleTypeDef)/4)+1];/* On 32-bit boundary */` — CONFIRMS_OURS.
- usbd_conf.h from shared `usbdconf_v2.10_h.ftl` (Configs.xml `USBD_CONF_CDC_H`), values injected as Arguments (`USBD_MAX_NUM_INTERFACES`, `USBD_MAX_NUM_CONFIGURATION`, `USBD_MAX_STR_DESC_SIZ`, `USBD_DEBUG_LEVEL`, `USBD_LPM_ENABLED`, `USBD_SELF_POWERED`) — these are ioc-visible RefParameters, not constants; defaults produce your 1U/1U/512U/0U/0U/1U. `USBD_malloc (void *)USBD_static_malloc` at usbdconf_v2.10_h.ftl:153.

## Q4. usbd_cdc_if — parameter injection

**VERDICT: CONFIRMS_OURS.** Header `usbd_cdc_if_h.ftl` (Configs.xml `USBD_INF_CDC_H_FS`, Arguments `APP_RX_DATA_SIZE`/`APP_TX_DATA_SIZE`), lines 93-94:
```
#define APP_RX_DATA_SIZE  ${RX_DATA_SIZE}
#define APP_TX_DATA_SIZE  ${TX_DATA_SIZE}
```
(assigned at :52-56 via `definition.name?contains("APP_RX_DATA_SIZE")`; comment `[#-- BZ 102389 Generate RX, TX Buffer size out of user code section --]`). Source `usbd_cdc_if_f4_c.ftl` (Configs.xml `USBD_INF_CDC_C_FS`): `uint8_t UserRxBufferFS[APP_RX_DATA_SIZE];` (:132), fops struct with `CDC_TransmitCplt_FS` (:208-214), bodies in USER CODE 3/4/5/6/7/13 (:237-393) — matches §4.4 exactly. NOTE: APP_RX/TX_DATA_SIZE are RAM-size-conditioned RefParameters (Modes.xml:722+ `DefaultValue="2048"` for RAM>64K with `ValueCondition "MOD(Value,512) = 0"`); ODrive's 64 is a user override.

## Q5. Library file list, include dirs, init-call ownership

**VERDICT: CONFIRMS_OURS + mechanism.**
- File list: Configs.xml root `<IP ... RootFolder="Middlewares/ST/STM32_USB_Device_Library/" Version="STM32Cube_FW_F4_V1.28.2">`; `<RefComponent Cclass="Middlewares" Cgroup="USB_DEVICE">` lists Core files (`Core/Inc/usbd_core.h, usbd_ctlreq.h, usbd_def.h, usbd_ioreq.h; Core/Src/usbd_core.c, usbd_ctlreq.c, usbd_ioreq.c`) + `<SubComponent Csub="CDC"><File Category="header" Name="Class/CDC/Inc/usbd_cdc.h"/><File Category="source" Name="Class/CDC/Src/usbd_cdc.c"/></SubComponent>`; RefConfig selects `<Component Name="Middlewares:USB_DEVICE:CDC"/>`. Matches §4.6 exactly (3 Core .c + usbd_cdc.c).
- Host contract: file resolution is host-side — `ProjectBuilder.searchNeededFiles()` (D:/embedded_agent/java_code/decompiled/projectmanager/.../engine/ProjectBuilder.java:4245):
```java
Map clUsedLibFilesMap = CodeGenerator.getListOfRefComponent();
...
this.m_sNeededFileNameList.addAll((Collection)clUsedLibFilesMap.get("headers"));
this.m_sNeededFileNameList.addAll((Collection)clUsedLibFilesMap.get("sources"));
```
`CodeGenerator.getListOfRefComponent()` lives in the absent host; plugin side only consumes repo-relative paths and copies from the FW repository (`copyNeededFiles`, ProjectBuilder.java:5122+).
- Include dirs are derived, not declared: `searchToolChainFiles()` (ProjectBuilder.java:4430-4432) adds the parent folder of every needed `.h`:
```java
if (!sFileName.endsWith(".h") && !sFileName.endsWith(".hpp")) continue;
String sFolderNameCst = sFolderName = sNeededFileName.substring(0, sNeededFileName.lastIndexOf("/"));
...
this.m_sTcLibHeaderFolderNameList.add(sFolderName);
```
→ `Core/Inc` and `Class/CDC/Inc` appear because headers live there. CONFIRMS_OURS §4.6.
- Group/OBJECT-lib name: `EngineConstants.java:171 public static final String USB_DEVICE_LIBRARY_GROUP_NAME = "USB_Device_Library";` mapped from IP name via `Group.setName` (projectmanager/.../model/Group.java:174-178, `MIDDLEWARES` → `MIDDLEWARES_GROUP_NAMES`). CONFIRMS_OURS.
- Init ownership: middleware owns ALL USB init. No MX_USB_OTG_FS_PCD_Init is generated; the PCD init is spliced into `USBD_LL_Init` via `usb_otg_fs_HalInit.tmp` (see Q3). The FreeRTOS-deferred call is template-driven: `db/templates/freertos_body_default_thread_cmsis_v1.ftl`:
```
[#if mw?upper_case == "USB_HOST" | mw?upper_case == "USB_DEVICE" | ...]
#t/* init code for ${mw} */
#tMX_${mw}_Init();#n
```
emitted as first statements of the default task (before `USER CODE BEGIN 5`/`StartDefaultTask` section), plus `freertos_c.ftl:109 extern void MX_${mw}_Init(void);` — CONFIRMS_OURS §4.5 (both the call site and the extern).
- App file placement: Configs.xml `File Name="App/usbd_desc.c"`, `"Target/usbd_conf.c"` → modern CubeMX emits `USB_DEVICE/App/*` + `USB_DEVICE/Target/*`; the ODrive-era flat `Src/` layout is a legacy-version difference your file-split logic should treat as such.
- H7 quirk (NEW_INSIGHT, low priority): usbdevice_c.ftl post-treatment injects `HAL_PWREx_EnableUSBVoltageDetector();` inside `USER CODE ..._Init_PostTreatment` when `family?contains("STM32H7")`.

## Caveat
The codegen driver (RefConfig/ConfigForMode resolution, FTL invocation, .tmp fragment writer, `CodeGenerator.getListOfRefComponent`) is `com.st.microxplorer.codegenerator` / `...mcu` — NOT in the decompiled tree. All host-behavior claims above are grounded in the db XML/FTL artifacts it consumes plus plugin-side call sites (`CodeGenerator.*` statics in ProjectBuilder).