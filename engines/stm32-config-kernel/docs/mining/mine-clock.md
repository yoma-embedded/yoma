All evidence gathered. Final findings below.

---

# CLOCK PLUGIN FINDINGS (D:/embedded_agent/java_code/decompiled/clock)

Host-side classes `com.st.microxplorer.mcu.RCCService/RefParameter/Mcu` and `com.st.microxplorer.util.LogicalParser` are **NOT in this tree**; contracts inferred from call sites are marked HOST.

## Q1. Tree evaluation / propagation / min-max detection

**VERDICT: NEW_INSIGHT (propagation model differs from ours), CONFIRMS_OURS (freq math, domains)**

- Propagation is **event-driven observer cascade, not a global forward pass**. Each `Signal` (edge) is a `PropertyChangeSupport` source; downstream nodes register as listeners in `initOutPutFrequency()`. There is no topological order — order = listener registration order, incremental per change. A whole-tree pass exists only at load (`Tree.initOutPutFrequencies` → `ClockTree.updateElementsState`) and via `ClockTree.updateElements()` after edits. Our deterministic full-propagation is a valid re-serialization but Java has no fixpoint loop; each edit triggers exactly one cascade.
  - `model/clocktree/Signal.java:38`: `public void setSignalFrequency(double value) { double oldValue = this.signalFrequency; this.signalFrequency = value; this.changeSupport.firePropertyChange("Signal", oldValue, value); }`
  - Side effect — **every Signal writes its frequency back into RCC params** (model↔param double binding), `Signal.java:179-181`: `if (... evt.getPropertyName().equals("Signal") && !this.refParameterName.isEmpty()) { this.rcc.setParameterValue(this.refParameterName, Double.toString(this.signalFrequency)); }`
- **Node math** (`model/clocktree/ArithmeticOperator.java:466-470`): `if (this.getOperatorSign().equals("/")) { this.setOutputFrequency((Double)evt.getNewValue() / Double.parseDouble(this.getValue())); } else { this.setOutputFrequency((Double)evt.getNewValue() * Double.parseDouble(this.getValue())); }`. Mux = pass-through of selected input (`Multiplexer.java:500-501`). Fractional PLL (`MultiplicatorFractional.java:39`): `out = in * (N + fracSignal)` where the Fractional element outputs `fracV / fracCVdiv`, `fracCVdiv` default 8192, overridable via `refParameter="PARAM/div"` XML encoding (`ApiDbClock.java:211-215`).
- **Value domains from RefParameter** (CONFIRMS_OURS): list-type → *comments* parsed as doubles; integer-type → `min..max` enumerated. `ArithmeticOperator.java:306-322` (`getValuesList`). Writing back maps comment→value: `ArithmeticOperator.setParameterValue` (`:284-291`): `if (!newValue.equals(possibleValue.getComment())) continue; this.rcc.setParameterValue(this.refParameterName, possibleValue.getValue());`. Mux writes the selected input's `refValue` matched against `possibleValues[].getValue()`; input with empty refValue forwards the *previous element's param value* (`Multiplexer.setParameterValue`, `:270-319`).
- **Constraint checks — two variants**:
  - Prospective `Element.checkConstraints(newFreq)` (`Element.java:426-457`): active-field nodes (ActiveOutput etc.) check own RefParameter — list-type with unit MHz/KHz ⇒ freq must **equal one ParamValue comment exactly** (`newFreq == Double.parseDouble(...getComment())`); else min/max interval (`getMax() != +∞ && newFreq > max ⇒ fail`). Non-active nodes check each output **Signal's** RefParameter min/max (`Signal.checkFrequency`, no 0-exemption).
  - Current-state `checkOutputFreqConstraints` → `Signal.checkSignalFreqConstraints` (`Signal.java:70-75`) **exempts 0 Hz from min/max**: `if (refParameter.getMax() != POSITIVE_INFINITY && this.signalFrequency != 0.0 && this.signalFrequency > refParameter.getMax()) checked = false;` — but list-type params still fail at 0.
- **Detection/display**: global sweep `ClockTree.refreshErronousElementList` (`ClockTree.java:187-207`) over `getConnectedElements()` (enabled nodes with successors, plus enabled terminal Output/ActiveOutput/Source/PixelClockSource); muxes flagged via `isErronousMultiplexer()` (selected input's source disabled, or refValue absent from possibleValues — `Multiplexer.java:434-460`); `FixedSource` never flagged (`... || nextElement instanceof FixedSource) continue;`). Failing node: `setChekedConstraints(false)` (fires prop-change → UI red) + `rcc.setRCCState(false)`; then `checkClockState()` fires `MxSystem.MxFirePropertyChange("EventGuiCheckErrorsInRCC", ...)` which enables the Resolve button / plugin error flag (`ClockConfigurationView.java:614-621`). Tooltip text: `Element.getConstraintsMessage` uses `<param>ConstraintsText` RefParameter's default value if non-empty, else synthesizes ">= min ... =< max" from the RefParameter (`Element.java:553-601`).

## Q2. "Resolve Clock Issues"

**VERDICT: NEW_INSIGHT — it is NOT one solver; it is a fixed-order per-category greedy repair loop, plus the DFS Round solver for ActiveOutputs.**

- `ClockTreeView.resolveClockIssues` (`ClockTreeView.java:304-359`): up to **2 passes** (`while (++i < 2)`) over categories in hard order: VariedSources → PixelClock → Fractionals → **HCLK** → ActiveOutputs → Multiplexers → Xbar → ArithmeticOperators → Outputs. Within a category it iterates a `HashSet<Element>` (identity hash) ⇒ **element order inside a category is JVM-nondeterministic**.
- Per-category heuristics, no global objective:
  - VariedSource → set to **max** (`:397` `setParameterDisplayValue(..., variedSource.getParameterMaxStringValue())`); Fractional → set to **min** (`:420 refParameter.getMinString()`).
  - HCLK (`:407`): `if (!(refParameter.getName().equals("HCLKFreq_Value") | ...equals("HPREFreq_Value")) || activeOutput.findClockSolution((Number)refParameter.getDisplayMax(), ...) || findClockSolution((Number)refParameter.getDisplayMin(), ...)) continue;` then integer scan `for (int i = MinFreq + 1; i < MaxFreq ...)`. Target order: **max first, then min, then ascending integers**.
  - ActiveOutputs (`:438-453`): skip HCLK; USB hardcode (see Q5); list-type param → try each possible value in list order via `findClockSolution`; else `findClockAnySolution(displayMin, displayMax)` (range solve).
  - Multiplexers/Outputs: try inputs / operator values in order until constraint passes. ArithmeticOperators (`:482-542`): **parses its own HTML constraint tooltip** (split on `">= "`, `"=&lt;"`, `indexOf("MHz")`) to recover bounds, then first value in list satisfying — bound recovery only works for MHz-unit messages.
- **Round solver** (direct freq entry and the resolve calls above), `model/reversePath/Round.java`:
  - Two phases: `launchRound(true)` = only the currently-selected path (chain of `getPreviousSelectedElement()` to first `isKey()` source); on failure `launchRound(false)` = enumerate **all** paths to key sources (`getPathListToFirstKeys`, DFS over `getPreviousElements()`, guarded `if (currentElement.isEnabled())` — CONFIRMS_OURS on refEnable gating the solver).
  - `RoundForPath.calcValuesForPath` (`:426-694`): walks path key→output, enumerates each `NumericElement.getValues()` in list order, `calcResult = currentResult / currentValue` (Divisor) or `* currentValue` (Multiplicator); prunes with `checkConstraints(calcResult)`; **dependency re-check**: `setParameterValueNoFire(...)` then verify all `getDependantElements(refParameter)` (recursive closure of `RefParameter.getDependencies()`) still satisfy `checkOutputFreqConstraints()`, then `removeParameterValue` (`:575-588`).
  - Acceptance (`:657-665`): `if (currentResult >= this.targetMinFrequency && currentResult <= this.targetFrequency) { solution = new Solution(...); solution.restoreSolution(...); if (Solution.Solutionvalid) { ...; Round.this.noSolutionFound = false; return; } ... }` — **first feasible solution wins** (exact entry: min==max==target); validity = side-branch (`EdgePath`) re-solve of every fan-out from path elements (`Solution.SolutionEdgePath`) + user-lock respect. Non-hits are stored as near-candidates only if the display value has <15 decimal digits (`:677-688` — "clean decimal" filter).
  - No exact hit ⇒ `getBestSolution` (`:189-252`): sorts all candidates by `calcResult`, picks nearest-above and nearest-below the target by `Math.abs(solution.getcalcResult() - this.targetFrequency)`, both validated by `restoreSolution`; user picks via dialog (`gui/ActiveOutputUI.java:330-376`); if errors remain afterwards it chains into `resolveClockIssues()`.
  - Params it may change: NumericElement values, Multiplexer/Xbar selected inputs, Fractional fracN, key-source value for MSIRC only; locked outputs (`ListLockElement`, e.g. locked AHBOutput/HCLK) are hard constraints (`Round.java:612-622`).
  - Determinism: path order = XML declaration order, value order = RefParameter list order (deterministic); **but** the static mutable `Solution.Solutionvalid` global and HashSet iteration in resolveClockIssues are shared-state hazards; `checklaunchingElement` (`:313-321`) **reverses** the candidate path list only for element name `"HRTIMoutput"`.

## Q3. refEnable semantics

**VERDICT: CONFIRMS_OURS with two refinements (strict parseBoolean truthiness; separate "auto" and load-time availability tiers).**

Three distinct predicates over the same comma-split `refEnable` list:
1. **Load-time availability** — element dropped from the tree entirely if no listed param is available on this package: `ApiDbClock.java:499-506`: `for (String refEnableParamString : refEnableParamList) { if (!this.rcc.isParamAvailable(refEnableParamString)) continue; return true; } return false;` (empty list ⇒ available). Same logic in `Element.isAvailable()` (`Element.java:615-624`). HOST: `isParamAvailable` semantics live in RCCService.
2. **Runtime enable** — `Element.java:668-679`:
```java
public boolean isEnabled() {
    if (this.refEnableParamList.isEmpty()) { return true; }
    for (String paramName : this.refEnableParamList) {
        RefParameter enableParam = this.rcc.getParameter(paramName);
        boolean enableParamValue = Boolean.parseBoolean(this.rcc.getParameterValue(enableParam));
        if (!enableParamValue) continue;
        return true;
    }
    return false;
}
```
   ⇒ any-listed-param-true wins (CONFIRMS_OURS), **but truthy = the string "true" case-insensitive only** (`Boolean.parseBoolean`); "1"/"ON"/nonzero are NOT truthy. If our Rust "truthy" is broader, that CONTRADICTS on the coercion detail.
3. **Auto tier** — checked *before* isEnabled in `ClockTree.updateElementsState` (`ClockTree.java:273-283`): `Element.isAuto()` (`Element.java:83-91`) returns true if any listed param's value `equalsIgnoreCase("auto")` ⇒ element set disabled ("selected automatically by system" tooltip).

Effects of disabled: excluded from `getActiveNextElements`/recursive traversal (`Element.java:303,307`), from solver path enumeration (`Round.getPathListToFirstKeys :136`), and from the erroneous sweep (`getConnectedElements` requires `isEnabledElement()`, `ClockTree.java:253`); a mux whose selected input's source is disabled is itself erroneous (`Multiplexer.RadioButton.isActiveRadioButton :547-551` → `fromElement.isEnabled()`). Oscillator override: `VariedSource.isEnabledOscillator` (`VariedSource.java:304-319`) returns false if the state RefParameter value `endsWith("OFF")` regardless of refEnable.

## Q4. RefParameter overloads / condition evaluator

**VERDICT: HOST-SIDE — evaluator and first-match-wins resolution are in the absent `com.st.microxplorer.mcu` / `com.st.microxplorer.util`. Plugin-side contract:**

- `RCCService.parser` is a **public field** of type `com.st.microxplorer.util.LogicalParser`; methods used by plugins: `checkCondition(String) → boolean`, `addSemaphore(String, IMXSemaphore)`, `removeSemaphore(String)`. `IMXSemaphore = { String getName(); double getValue(); }` — truth is **numeric** (1.0); see the bundled duplicate `thirdparty/com/st/ipmodeconfigmanager/util/SemaphoreTrue.java:12-24`: `this.name = n.replaceAll("[^a-zA-Z0-9]", "_"); ... public double getValue() { return 1.0; }` — identifiers are sanitized to `[A-Za-z0-9_]`.
- Clock XML `<Condition Expression=...>` evaluation contract, `db/ElementTypeExt.java:28-45`:
```java
String mcuPackage = MxSystem.getMxMcu().getPackage();
this.conditionParser.addSemaphore(mcuPackage.replaceAll("/", "_"), (IMXSemaphore)this);
for (String condition : this.getConditions()) {
    if (!this.conditionParser.checkCondition(condition)) { ret = false; }
}
catch (Exception e) { LOGGER.trace(...); }  // ret stays true
```
  ⇒ the MCU **package name is registered as a true semaphore** before evaluation (so expressions can reference packages); multiple conditions AND together; **any parser exception ⇒ element treated as available** (fail-open). TrustZone injects `<elemName>_TZSEC` / `<elemName>_TZLOCK` semaphores into the same parser (`Multiplexer.java:99,166`).
- First-match-wins overload resolution is not observable here, but two plugin-side echoes of it: (a) all min/max/possibleValues are re-read live from `rcc.getRefParameter` on every check, and `ArithmeticOperator.updateElement` (`:229-256`) detects the value list *changing* at runtime and falls back to the RefParameter default when the old selection vanished — consistent with condition-dependent overload swaps happening host-side; (b) the plugin itself implements a two-candidate first-match for comma-encoded refParameter names, `ApiDbClock.java:228-235`: `clockTreeRefParam = rcc.getRefParameter(refParamArray[0]); if (clockTreeRefParam == null) { ...refParamArray[1]...}` (same for Signals, `:172`). No numeric-coercion or unknown-identifier evidence is available plugin-side.

## Q5. Hardcoded quirks in Java (not DB data)

**VERDICT: NEW_INSIGHT — concrete quirks list; flash-latency/VOS are NOT plugin-side.**

1. **USB 48 MHz**: `ClockTreeView.java:439-441`: `if (refParameter.getName().equals("USBFreq_Value") || refParameter.getName().equals("48MHZClocksFreq_Value")) { double usbFreq = 48.0; output.findClockSolution((Number)usbFreq, this.currentSW);` — resolve target hardcoded (display MHz). The 48-MHz *window* itself is DB min/max, not code.
2. **USBPHYFreq_Value on STM32MP**: list-constraint compares `ParamValue.getValue()` instead of `getComment()`: `Element.java:434` (also `:468`, `ClockTreeView.java:449`): `refParameter.getName().equals("USBPHYFreq_Value") && MxSystem.getMxMcu().getName().startsWith("STM32MP") ? newFreq == Double.parseDouble(...getValue()) : newFreq == Double.parseDouble(...getComment())`.
3. **VOS**: `Element.java:462` fetches `RefParameter refParVOGScale = this.rcc.getRefParameter("PWR_Regulator_Voltage_Scale");` and **never uses it** — dead code. No other VOS reference; no `Flash`/`Latency` string anywhere in the clock plugin ⇒ **flash-latency & VOS→fmax coupling are host/DB-side (conditional RefParameter overloads), not clock-plugin Java**.
4. **APB↔TIM coupling**: `Round.java:585-587`: `if ((refParameter.getName().equals("APB2CLKDivider") || refParameter.getName().equals("APB1CLKDivider")) && refParameterNextElementName.contains("TimCLKDivider") && !this.chekAPBConstraint(...)) isCorrectConfig = false;` with `chekAPBConstraint` (`:765-769`) = reject (APB="1.0", TIM="2") and (APB≠"1.0", TIM="1"); plus `Solution.chekAPBConstraint` (`Solution.java:341-351`) force-resets any `APB1TimCLKDivider`/`APB2TimCLKDivider` element to `ref.getDefaultMinString()` after **every** solution restore.
5. **HCLK/AHBOutput lock**: `Round.java:612-621` — element named `"AHBOutput"` with param `"HCLKFreq_Value"`: solution rejected unless `currentResult` equals the locked value; also `resolveErroneousHCLK` (Q2) and `importConfig` (`ClockTreeView.java:707`) target `"AHBOutput"` by name.
6. **MSIRC** (MSI): key element named `"MSIRC"` gets its discrete ranges enumerated `Double.parseDouble(val) * 1000.0` (`Round.java:400-407`) and bespoke restore incl. display-unit division (`Solution.java:159-174`).
7. **HRTIMoutput**: candidate-path list reversed (`Round.java:313-321`).
8. **STM32F3**: `Solution.chekErronousMux` (`Solution.java:321`) — mux auto-reselect pass runs only `if (MxSystem.getMxMcu().getName().startsWith("STM32F3"))`.
9. **DIE503/504/505**: fractional-PLL feasibility uses analytic min/max window instead of iterative fracN scan (`Round.java:495-517`, `switch (MxSystem.getMxMcu().getDie())`).
10. **STM32F0 + DB < DB.4.0.70**: clock XML loaded from default install path (`ClockTree.java:58`).
11. **RCC_RTC_Clock_Source_FROM_HSE**: min forced to 1 MHz with equality-only match (`ClockTreeView.java:513-514`).
12. **F4/F2 label exemption**: label refEnable availability check skipped when MCU name contains "F4"/"F2" (`ApiDbClock.java:476`).
13. **Structural quirks worth mirroring**: near-solution "clean decimal" filter (<15 fractional digits, `Round.java:677-688`); 0 Hz min/max exemption (`Signal.java:70-75`); `resolveErroneousArithmeticOperators` recovers bounds by parsing its own "MHz"-formatted tooltip strings (breaks for KHz-unit constraints).