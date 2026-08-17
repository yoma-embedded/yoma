AREA ip_dma — FINDINGS

SCOPE NOTE: ip_dma contains 7 UI classes only (Dma, DmaPanel, DmaTabbedPanel, DMAGeneratorPanel, DMASynchronizationPanel, SelectComboBox, GuiConstants). All allocation/model logic lives in host `com.st.microxplorer.mcu` (DMAService, DMAServiceSet, DMAController, DMAFlow, UserDMARequest, DMAMuxService, DMA3Service, NVICService, NvicVector) — NOT in this tree. All codegen lives in host `com.st.microxplorer.codegenerator` — NOT in this tree. `grep -rn "MX_DMA_Init\|__HAL_LINKDMA\|hdma_"` over the whole decompiled tree: 0 hits.

## Q1. Request→stream/channel allocation — verdict: CONFIRMS_OURS (+NEW_INSIGHT on override/conflict mechanics)

1a. Allocation is HOST-AUTOMATIC at addRequest; user may override via combo. Plugin calls `dmaSet.addRequest(name, panelId)` and gets back a request whose flow is already assigned (plugin never writes an initial flow — all combo events during refresh are suppressed by `refreshinprogress`, yet `getFlowName()` is immediately valid for the report/table):
```java
UserDMARequest newrequest = this.dmaSet.addRequest(req.getSelectedItem().toString(), this.panelId);
...
if (request != null) { this.dma = request.dma;
```
D:/embedded_agent/java_code/decompiled/ip_dma/com/st/microxplorer/plugins/ip/dma/DmaPanel.java:1715-1728. Note `DMAServiceSet.addRequest` also picks the controller (DMA1 vs DMA2) — plugin re-reads `request.dma`.

1b. Stream override: the "Instance" column is a db RefParameter named `Instance` (`tblparams = {"Request", "Instance", "Direction", "Priority"}`, line 111); flow names are its values (comment↔value mapped via `dma.getLastRefParameter(param).getPossibleValues()`). Setting it calls host `request.setDMAFlow(value, panelId)` which returns success/fail (= conflict check on write). Cross-controller move is delete+re-add:
```java
if (value.startsWith(request.dma.getName())) {
    if (!request.setDMAFlow(value, this.panelId)) continue; ...
}
DMAService newDma = (DMAService)this.dmaSet.getDMAServiceForSpecifiedFlow(value);
UserDMARequest newrequest = newDma.addControllerRequest(request.getRequestName(), this.panelId);
if (newrequest.setDMAFlow(value, this.panelId)) { this.copyParams(request, newrequest); ... curdma.deleteRequest(request);
```
DmaPanel.java:410-425.

1c. Compatibility matrix is HOST/db-side, exposed as `request.getDMAFlows(panelId)` → `Map<flowValue, Boolean available>`; occupied/incompatible flows are shown greyed, not hidden:
```java
Map dmaFlows = dmaRequest.getDMAFlows(this.panelId);
...
flows.put(this.getComment(this.tblparams[1], flow, dmaRequest.getRequestNameId()), (Boolean)dmaFlows.get(flow));
```
DmaPanel.java:2134-2143. Since the flow list is the `Instance` RefParameter value set filtered per request by the host, the source is the DMA IpDef/db model, not Java tables — CONFIRMS our "db mode tree" assumption at the contract level (host internals unverifiable here).

1d. Request-level availability + conflict diagnostics: host returns `Map<requestName, Boolean>` via `dma.getAllControllerDMARequests(ipname)` (DMA tab) / `dmaSet.getAllPeripheralDMARequests(ipname)` (peripheral tab); plugin derives diagnostics from flow occupancy (`flow.getMappedRequest()`) and a second host predicate `dma.incompatibleRequests(a, b)` (mutually-exclusive request pairs, independent of occupancy):
```java
requests = this.ipname.startsWith("DMA") || this.ipname.startsWith("BDMA") ? this.dma.getAllControllerDMARequests(this.ipname) : this.dmaSet.getAllPeripheralDMARequests(this.ipname);
...
this.diagnostic[pos] = "Conflicts with ";
for (DMAFlow flow : this.dma.getFlows(str)) {
    UserDMARequest req = flow.getMappedRequest();
...
    if (!this.dma.incompatibleRequests(str, req.getRequestName())) continue;
```
DmaPanel.java:1119-1160. NEW_INSIGHT: conflict rule is two-tier — (i) all compatible flows occupied, (ii) pairwise request incompatibility.

1e. Request keying CONFIRMS_OURS: keys are full db request names (`getRequestName()` e.g. printed as "UART4_RX" rows in report, Dma.java:151), MEMTOMEM special-cased (`mem2mem = "MEMTOMEM"`, availability via `this.dma.isAvailable(mem2mem, this.panelId, true)`, DmaPanel.java:1114; mem2mem tab bound to `this.dma.getMemToMemControllerName()`, DmaPanel.java:186 — host knows only DMA2 does M2M on F4). NEW_INSIGHT: `UserDMARequest.isMandatoryRequest()` exists — mandatory requests can't be deleted (DmaPanel.java:1292,1623).

## Q2. Codegen contribution — verdict: NEW_INSIGHT (ip_dma contributes NOTHING to codegen; all in absent host)

2a. ip_dma has zero codegen: no FTL, no MX_DMA_Init/LINKDMA/hdma strings anywhere in the plugin tree (grep above). Its only output artifact is the PDF report (`getReport`/`fillDMATable`, Dma.java:89-179). MX_DMA_Init content, clock-enable order, hdma_ naming, LINKDMA emission are all in host `com.st.microxplorer.codegenerator` — ABSENT from this tree; cannot be validated or contradicted here. Our P3 plan for those must be validated against emitted C output, not these sources.

2b. What the plugin-side contract does reveal:
- Persisted model = per-request parameter set (`Mode, MemInc, PeriphInc, MemDataAlignment, PeriphDataAlignment, FIFOMode, FIFOThreshold, MemBurst, PeriphBurst` — DmaPanel.java:236) + `Instance` (flow) + `Direction` + `Priority`, snapshot via opaque `dma.storeConfiguration(ipname)` / `restoreConfiguration` (DmaPanel.java:307, 2059, 2090).
- Templates key on requestName+flowName: STM32_WPAN registers codegen semaphores `sem = dmaRequest.getName() + "_" + dmaRequest.getFlowName()`:
```java
if (!dmarequestconfig.getEmitterName().startsWith("LPUART") && !dmarequestconfig.getEmitterName().startsWith("USART") || this.ip.parser.checkCondition(sem = dmaRequest.getName() + "_" + dmaRequest.getFlowName())) continue;
this.ip.parser.addSemaphore(sem, (IMXSemaphore)new SemaphoreTrue(sem));
```
D:/embedded_agent/java_code/decompiled/ip_stm32_wpan/com/st/microxplorer/plugins/ip/stm32_wpan/STM32_WPAN.java:1597-1599. Flow names are literal like `DMA1_Stream5`/`DMAx_CHn` (RifView strips `dmaInstance + "_CH"`, D:/embedded_agent/java_code/decompiled/ipmanager/com/st/microxplorer/plugins/rifgui/RifView.java:420; `value.startsWith(request.dma.getName())` DmaPanel.java:411).
- DMA↔peripheral init-ordering dependency is registered in the host IP model (seen in ip_dma3): `ip.addIPDependency(dmaService.getInstanceName()); ... dmaip.addIPDependency(ip.getInstanceName());` D:/embedded_agent/java_code/decompiled/ip_dma3/com/st/microxplorer/plugins/ip/dma3/Dma3.java:58-61. Supports our "MX_DMA_Init ordered relative to peripheral inits via dependency graph" but the F4 ip_dma plugin itself does not register it (host presumably does).

## Q3. DMA NVIC rows — verdict: CONFIRMS_OURS (+NEW_INSIGHT on per-vector codegen flags)

3a. ip_dma does NOT touch NVIC — its hook is a decompiled EMPTY stub, so request-add→IRQ-enable coupling is entirely host-side (DMAService↔NVICService):
```java
private void updateDmaInterrupts() {
}
```
DmaPanel.java:399-400.

3b. NVIC row model (ip_nvic): rows are host `NvicVector` objects from `nvic.getHwSortedVectors(instanceName)`; per-vector state written back through `NVICService.setInterruptParameters` overloads carrying exactly: enabled, enabledByUser, preemption prio, sub prio, prio-modified-by-user, usesOsFunctions, forced, halHandlerNeeded; plus codegen flags codeOutsideMspInit/irqHandlerGenerated/halHandlerNeeded; plus rank:
```java
this.nvic.setInterruptParameters(vector.getName(), vector.isEnabled(), vector.isEnabledByUser(), vector.getInterruptPreemptionPriority(), vector.getInterruptSubPriority(), vector.isPreemptionPriorityModifiedByUser(), vector.usesOsFunctions(), vector.isForced(), vector.isHalHandlerNeeded());
this.nvic.setInterruptParameters(vector.getName(), vector.isCodeOutsideMspInit(), vector.isIrqHandlerGenerated(), vector.isHalHandlerNeeded());
this.nvic.setInterruptParameters(vector.getName(), vector.getRank());
```
D:/embedded_agent/java_code/decompiled/ip_nvic/com/st/microxplorer/plugins/ip/nvic/NvicTable.java:142-144.

3c. NEW_INSIGHT for our it.c emission: the Code-generation tab columns are `{"Enabled interrupt table", "", "Generate Enable in Init", "", "Call HAL handler"}` with checkbox headers "Select for init sequence ordering" (col1) and "Generate IRQ handler" (col3) (NvicCodeSelectionTable.java:47,64,67); handler emission is per-vector `isIrqHandlerGenerated`, HAL_DMA_IRQHandler call is per-vector `isHalHandlerNeeded` (only editable if `halHandlerExists() && isIrqHandlerGenerated`, NvicCodeSelectionTable.java:394), init-order rank via `curVector.setRank(++rank); this.nvic.setRankMax(rank);` (NvicCodeOrderTable.java:122-127). Our P3 should model DMA stream IRQ rows with these four booleans + (preempt,sub) prio, defaulting to enabled+generate-handler+call-HAL.

3d. NEW_INSIGHT: global NVIC checkbox "Force DMA channels Interrupts" → `nvic.setNeedForceDmaVector(bool)` (host decides which DMA vectors become forced; forced vectors survive restoreDefault, NvicTable.java:152) — NvicPanel.java:263,1083.

## Q4. F1 channel vs F4 stream — verdict: CONFIRMS_OURS (plugin is family-agnostic; differences are data-driven)

Single `DmaPanel` handles both; hardware unit is abstracted as "flow" (`DMAFlow`). Family differences enter only via host/db:
- Column header is host-supplied: `new String[]{"DMA Request", this.dmaSet.getFlowType(), "Direction", "Priority"}` (DmaPanel.java:543) → "Channel" on F1, "Stream" on F4 (report hardcodes "Stream" header only in the PDF, Dma.java:139).
- F4 FIFO/burst UI gated by host capability `dmaSet.hasFifo()` / `dma.hasFifo()`: param list is `("Mode","MemInc","PeriphInc","MemDataAlignment","PeriphDataAlignment")` without FIFO vs +`("FIFOMode","FIFOThreshold","MemBurst","PeriphBurst")` with (DmaPanel.java:236). F1 (no FIFO) gets the short list. Mem2mem forces FIFO on ("DMDIS bit ... forced to 1 by hardware for memory-to-memory transfers", DmaPanel.java:1384).
- DMAMUX families are a service subtype: `if (this.dma instanceof DMAMuxService && !this.peripheralPanel ...)` adds request-generator/synchronization panels (DmaPanel.java:703-706); GPDMA (U5/H5) is `DMA3Service` handled by ip_dma3 which renders no table at all — just "requests should be configured in GPDMA1" redirect buttons (Dma3.java:52).
- `this.dma.areControllersIndependent()` (DmaPanel.java:1738): when false, a flow change forces full table rebuild — host models families where controllers share flow space.
CONCLUSION for our Rust engine: one allocator over db-declared flows with per-flow-type labels and a hasFifo capability flag reproduces both F1 and F4; no family-specific Java allocation tables exist plugin-side.

## Misc contract notes
- Non-CUBE contexts (MP1 Linux device-tree) suppress the 4-column table entirely (`setLinuxDeviceTreeDisplay()` → `fourColumnTable=false`, DmaPanel.java:2265-2273) and the report prints Stream "N/A" when `!dmaRequest.isRequestForCubeContext()` (Dma.java:155-156) — safe to ignore for F4.
- Per-request error state: `request.setWrongValue/getWrongValues` for burst/threshold vs data-width incompatibilities (validity conditions come from RefParameter `paramValue.getErrorCondition()` + `request.checkErrorCondition(condition)`, DmaPanel.java:798-800) — these are db `ErrorCondition` expressions, worth honoring in our engine's DMA param validation.
- Doc chapter (D:/embedded_agent/java_code/decompiled/_STM32CubeMX_架构与逻辑分析.md:1089) only classifies DMA as "family A self-drawn MVC operating DMAService directly"; it contains no allocation/codegen detail beyond what is verified above.