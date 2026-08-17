FINDINGS — decompiled-plugin evidence vs our engine design. Host classes `com.st.microxplorer.mcu.*` / `codegenerator` are NOT in this tree; where the mechanism lives there I say so and report the plugin-side call contract.

---

## Q1. RefParameter overload resolution + semaphore lifecycle

**Resolution order — HOST-SIDE (absent), plugin contract partially visible. Verdict: PARTIAL / cannot confirm document-order from this tree.**
- Resolution itself is inside host `IP.getRefParameter(name)` / `IP.getAllRequiredRefParameters()` / `Pin.getGPIOParameters()`; plugins always receive an already-resolved single RefParameter per name. No overload iteration exists plugin-side.
- Supporting evidence for "iterate all, take first in-use" idiom: plugins CAN see all overloads via `getAllRefParameters()` plus a per-overload activation predicate `isInUse(context)`, and take the first hit in list order:
```java
for (RefParameter refparam : this.nvic.getAllRefParameters()) {
    if (!refparam.isInUse(null)) continue;
    switch (refparam.getName()) {
        case "CoreName": {
            if (this.coreName != null) break;   // keep FIRST in-use match
            this.coreName = refparam;
```
`D:/embedded_agent/java_code/decompiled/ip_nvic/com/st/microxplorer/plugins/ip/nvic/NvicPanel.java` (~line 135). List order = DB document order per the host loader; first-match-wins is consistent with this idiom and with `PluginManager` doing the same trick for plugin matching (`add(0,...)` exact before `.*` fallback, `ipmanager/.../pluginmanagement/PluginManager.java`, quoted in the analysis doc §ipmanager).
- **WHEN overloads re-evaluate — NEW_INSIGHT: cached + invalidated-on-write, then full re-projection per event (no in-pass fixpoint).** The host keeps a "RefParameter cache" that parameter writes flush; plugins suppress flushing during bulk default backfill and explicitly clear before rebuilding views:
```java
this.ip.setDisableFlushRefParameterCache(true);
this.ip.setFire(false);
... setParameterDisplayValue(refParam.getName(), refParam.getId(), refParam.getDefaultValue()); ...
this.ip.setFire(true);
this.ip.setDisableFlushRefParameterCache(false);
```
`D:/embedded_agent/java_code/decompiled/ipmanager/com/st/microxplorer/plugins/ipmanager/generictreatment/model/ParamManager.java:237-252`; and `this.nvic.clearRefParameterCache();` `ip_nvic/.../NvicTable.java:215` (same in `ip_adc/.../ADCParamManager.java:117`, `ip_dma/.../DmaPanel.java:1324`). Re-evaluation is event-driven: each edit → write to mcu → `EventMcu*` → `ParamManager.updateIpParameters()` re-reads `ip.getAllRequiredRefParameters()` from scratch (`ParamManager.java:187-259`). Our fixpoint loop is a valid batch analog, but CubeMX's is "invalidate cache on every write, lazily re-resolve at next read".

**Semaphore lifecycle — CONTRADICTS_OURS (if monotone means never-retracted): semaphores ARE retracted when values/modes change.**
- ADC clock constraints add AND remove per current frequency:
```java
if (adcClockFhz <= 2800000.0) {
    if (!this.ip.parser.checkCondition("SEM_ADC_LOW_FREQ_2_8MHZ")) {
        this.ip.parser.addSemaphore("SEM_ADC_LOW_FREQ_2_8MHZ", (IMXSemaphore)new SemaphoreTrue(...));
    }
} else if (this.ip.parser.checkCondition("SEM_ADC_LOW_FREQ_2_8MHZ")) {
    this.ip.parser.removeSemaphore("SEM_ADC_LOW_FREQ_2_8MHZ");
}
```
`D:/embedded_agent/java_code/decompiled/ip_adc/com/st/microxplorer/plugins/ip/adc/model/ADCParamManager.java:1681-1694`; same pattern with owner: `addSemaphoreWithOwner(sem, new SemaphoreTrue(sem), this.ip)` / `removeSemaphore(sem)` at :682-688. RIF does the same on false: `lp.removeSemaphore(semaphoreName);` `ipmanager/.../rifgui/RifView.java:733`. Clock tree adds/removes `_TZSEC`/`_TZLOCK` (`clock/.../clocktree/Multiplexer.java:99-104,166-173`).
- **NEW_INSIGHT — semaphores are lazily-evaluated value objects, not just asserted facts.** `IMXSemaphore` has `getName()/getValue()`; some are live predicates: `RefParameterSemaphore(mcu, ip, name, refParam, valueToMatch)` tracks a parameter's current value automatically (`ParamManager.java:743-747`), and even a UI panel registers itself as an ephemeral semaphore (`TEMP_<IP>_NVIC_SEM`, added on open, removed on ok): `ip_nvic/.../NvicIntPanel.java:111-131`. GPIO reads numeric semaphore values: `sem.getValue() > 0.0` `ip_gpio/.../GpioParamManager.java:390-391`. So within one evaluation CubeMX is state-sync (idempotent add/remove guarded by `checkCondition`); across edits it retracts freely. Monotone-within-a-single-validate-run is a safe approximation ONLY if every run starts from an empty semaphore set.

---

## Q2. DefaultValue indirections "+Param", "=Param", "=(Formula*2)", "+A+|B"

**Evaluator — HOST-SIDE (absent from tree). Verdict: NEW_INSIGHT on the observable contract; no plugin-side string evaluator for '+'/'=' defaults exists.**
- Grep across all 60+ plugin dirs finds no parsing of `"+Param"` / `"+A+|B"` and no arithmetic evaluation of `=`-formulas. Plugins consume `refParam.getDefaultValue()` as an already-resolved literal and write it straight back: `this.ip.setParameterDisplayValue(refParam.getName(), refParam.getId(), refParam.getDefaultValue());` `ParamManager.java:242`. Resolution of the indirection is inside host `RefParameter`.
- Host contract visible plugin-side: raw strings via `getMinString()/getMaxString()` and `getDefaultMinString()/getDefaultMaxString()`; resolved numerics via `getDisplayMin()/getDisplayMax()/getMax()/getMin()`; parsed references via `getRefDependencies()`; and configuredness test `valueContainsOnlyCheckedParameters(expr)` (`generictreatment/model/Parameter.java:98-114` constructor).
- **Exact `=`-bound semantics (usable for our gap):** an `=`-formula min/max whose referenced parameters are not all configured is treated as ABSENT (bound skipped), not an error:
```java
if (this.curRefParameter.getDefaultMaxString() != null && this.curRefParameter.getDefaultMaxString().startsWith("=")
    && !this.curRefParameter.valueContainsOnlyCheckedParameters(this.curRefParameter.getDefaultMaxString()).booleanValue()
    && this.curRefParameter.getDefaultMinString() != null && ... ) {
    return true;                       // both bounds unresolved -> any value valid
}
if (... getDefaultMaxString().startsWith("=") && !valueContainsOnlyCheckedParameters(...)) {
    return valueTmp >= minTmp;         // max unresolved -> check min only
}
```
`D:/embedded_agent/java_code/decompiled/ipmanager/generictreatment/model/Parameter.java:845-860` (mirrored for hex :901-916; tooltips "can accept any value" in `ParameterProperty.java:163-168`). So for our engine: unevaluated `=`-formulas should degrade to "unbounded", never block validation.
- User-entered arithmetic (`+ - * / %` and user constants) is evaluated by host `UserConstant.calculateExpression(value, "")` before range check (`Parameter.java:822-824`) — a separate mechanism from DB `=`-defaults.

---

## Q3. ip_nvic — IRQn record, flags, handler composition, checkboxes

**5-field record decoder — HOST-SIDE (`com.st.microxplorer.mcu.NVICService` + `NvicVector`), absent. Verdict: cannot decode flag tokens (Y/N, W1, RTOS, HAL, EXTI, DMAL0, 2V1, NO_ARG, IF_HAL, nV) from this tree — zero occurrences of those tokens in any plugin.** But the `NvicVector` API surface maps the flags' semantics 1:1:
- `isEnabled()/isEnabledByUser()/isForced()` + conditional forcing: `hasForceSetCondition()/isForceSetConditionTrue()/getForcedSetDiagnostic()`, `hasForceResetCondition()/...`, `hasWarningCondition()/getWarningDiagnostic()` (`ip_nvic/.../NvicTable.java:243-253`) → DB flags for force-set/force-reset/warning with condition expressions.
- `isSystemHandler()`, `isTimebaseInterrupt()`, `isExtiInterrupt()/isExtiInterruptSelectable()`, `isHandledByRtos()/isManagedByRtos()`, `usesOsFunctions()/isUsesOsFunctionsFixed()/isUseOsFunctionsToBeSet()`, `hasFixedPriority()/isPriorityConfigurable()/isEnableFixed()`, `halHandlerExists()`, `getNewName()/getNewComment()` (renamed/aggregated display of shared vectors), per-vector priority floor `vector.getParameterMin(preemptRefparam)` (`NvicTable.java:296`).
- **Checkbox → codegen mapping (CONFIRMS the 3-bit codegen model), columns of `NvicCodeSelectionTable`:** col1 "Select for init sequence ordering" → `setCodeOutsideMspInit(b)` + `setRank(nvic.getRankMax()+1)`; col2 "Generate Enable in Init" → `setEnableCodeNeeded(b)`; col3 "Generate IRQ handler" → `setIrqHandlerGenerated(b)`; col4 "Call HAL handler" → `setHalHandlerNeeded(b)`:
```java
case 3: {
    vector.setIrqHandlerGenerated(booleanValue);
    if (!booleanValue) { ((NvicTableModel)this.getModel()).setCellReadOnly(row, 4); break; }
    ((NvicTableModel)this.getModel()).resetCellReadOnly(row, 4);
}
case 4: { vector.setHalHandlerNeeded(booleanValue); }
```
`D:/embedded_agent/java_code/decompiled/ip_nvic/com/st/microxplorer/plugins/ip/nvic/NvicCodeSelectionTable.java:294-332`. Gating rules: "Call HAL handler" editable only if `vector.halHandlerExists() && vector.isIrqHandlerGenerated()` (:134-135, tooltip "No HAL handler to be called"); "Generate IRQ handler" read-only if `isHandledByRtos()` (:131-133, tooltip "IRQ handler is provided by the active RTOS"); system/timebase vectors lock cols 1-2 (:127-130, tooltip "system interrupts are always enabled. HAL_NVIC_EnableIRQ shouldn't be called"). This implies IF_HAL/NO_ARG-class flags surface as `halHandlerExists()` and the handler-arg contract, decoded host-side.
- Persistence contract — three `NVICService.setInterruptParameters` overloads: 9-arg (name, enabled, enabledByUser, preemptPrio, subPrio, prioModifiedByUser, usesOsFunctions, forced, halHandlerNeeded), 4-arg codegen triple (name, codeOutsideMspInit, irqHandlerGenerated, halHandlerNeeded), 2-arg (name, rank) — all three in `NvicTable.cancel()` `NvicTable.java:142-144`.
- Init-order ranks are renormalized 1..N sorted by rank on every rebuild, `nvic.setRankMax(rank)` (`NvicCodeOrderTable.java:115-128`).
- Shared-vector handler BODY composition: host codegen; plugin only shows aggregated `getNewComment()` and defaults `setIrqHandlerGenerated(!vector.isHandledByRtos())` on restore-default (`NvicTable.java:163`).
- **NEW_INSIGHT:** FreeRTOS coupling: priority floor via `nvic.getPreemptionPriorityMin()` and per-row `checkValue(i, 2, minPreempt, maxPreempt)` when `usesOsFunctions`; tooltip "If interrupt handler calls FreeRTOS functions, higher preemption priorities are reserved for FreeRTOS" (`NvicTable.java:978-980`).

---

## Q4. GPIO speed defaults per signal class

**Verdict: NOT a plugin-side hardcoded table — CONTRADICTS a "hardcoded per-IP speed table in the plugin" hypothesis; the rule lives in host `GPIOService` + DB.** Plugin evidence:
- Defaults are fetched per-pin/per-param from the host: `String defaultValue = gpio.getGPIOParameterDefaultValue(pinFromMcu, param.getName());` `D:/embedded_agent/java_code/decompiled/ip_gpio/com/st/microxplorer/plugins/ip/gpio/model/GpioParamManager.java:677` (and :705). No speed constants (`VERY_HIGH`/`GPIO_SPEED_FREQ_*`) appear anywhere in the plugin tree (grep: 0 hits).
- The only plugin-side speed logic is visibility, not value: speed param dropped for Input/Analog signals —
```java
if (signal == null || !signal.ioMode.equals("Analog") && !signal.ioMode.equals("Input")) continue;
if (pin.getParam("GPIO_Speed") != null) { pin.getParams().remove(pin.getParam("GPIO_Speed")); }
```
`GpioParamManager.java:466-478` (also skipped when `pin.GetCurrentSignalIODirection().equals("Input")` :131), and rendered "n/a" for `GPIO_MODE_INPUT/ANALOG/IT*/EVT*` in `ip_gpio/.../model/GpioTableModel.java:64`. Speed-param detection is heuristic: `paramName.contains("GPIO_Speed") || paramComment.matches(".*(s|S)peed.*")` (`GpioParamManager.java:68-72`).
- Consequence for our engine: the F4 SPI/UART=VERY_HIGH vs TIM=LOW split must be decided by host `GPIOService` resolving conditional RefParameter overloads / per-signal defaults from the GPIO IP DB (GPIO-…_Modes.xml conditions keyed on signal/mode), since `Pin.getGPIOParameters()` already returns per-pin-specialized RefParameters. Validate against the DB XML, not Java.

---

## Q5. Pin signal stacking (SH.SharedStack)

**Verdict: NEW_INSIGHT on contract; model class is HOST-SIDE `com.st.microxplorer.mcu.SharedStack` (a `Signal` subtype), writer of `SH.*` ioc keys not in tree.** Plugin-visible contract:
- A pad's current signal can BE a stack; active members come from `getGreenSignals()`:
```java
List mappedSignals = pin.getMappedSignals();
if (pin.GetCurrentSignal() instanceof SharedStack) {
    mappedSignals = pin.GetCurrentSignal().getGreenSignals();
}
```
`D:/embedded_agent/java_code/decompiled/ip_gpio/com/st/microxplorer/plugins/ip/gpio/model/GpioParamManager.java:84-87`. Multiple mapped signals → `pinTable.setSharedPin(true)`, signal names joined with `;`, and the SAME `PinTable` (one shared GPIO parameter set for the pad) is added to EVERY member IP's tab (:106-111, :295-307). So two signals on one pad share a single GPIO config; there is no per-signal GPIO config.
- Activation constraint: only signals with mapped modes are unconditionally active; mode-less EXTI/IO signals stacked on a pad are active only if the stack says so:
```java
if (lSig.isEXTISignal() || lSig.isIOSignal()) {
    Signal sigMaster = lPin.GetCurrentSignal();
    if (sigMaster instanceof SharedStack) {
        return ((SharedStack)sigMaster).isActivated(lSig);
    }
    return true;
}
```
`D:/embedded_agent/java_code/decompiled/pinoutconfig/com/st/microxplorer/plugins/pinoutconfig/gui/PinOutPanel.java:1264-1277` (dup at :1954). I.e., plugin-observable stacking = one functional/AF signal + EXTI/GPIO-class signals, with per-member activation bits held by the stack.
- Related host type `SharedSignal` (distinct from SharedStack) exposes `getMappedSignals()` — RIF picks `.get(0)` as the representative (`ipmanager/.../rifgui/RifView.java:307`).
- Which signal pairs are allowed to stack, and `SH.` ioc serialization: host `Mcu/Pin` model — not in this tree.