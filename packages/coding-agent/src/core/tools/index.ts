/**
 * 工具集装配。对应 pi coding-agent/src/core/tools/index.ts。
 *
 * 与 pi 的差异:工厂第一个参数是注入的 ExecutionEnv 而不是 cwd 字符串 ——
 * cwd 从 env.cwd 拿,文件与进程访问都经由 env,于是同一套工具对远程/沙箱环境也成立。
 * 这正是 pi 用 ReadOperations/WriteOperations/BashOperations 那几套
 * 可插拔接口达成的目的,my-pi 用一个能力接口一次性覆盖。
 *
 * 装配面只有两个工厂:编码四件套 + 嵌入式六件套。按名挑选、聚合 Options、
 * grep(依赖外部 ripgrep,本仓永远不可用)等历史装配面在 2026-08 的精简中删除;
 * 单工具工厂仍然从各自模块导出,测试和特殊装配直接用它们。
 */
export {
	type BashToolDetails,
	type BashToolInput,
	createBashTool,
	createBashToolDefinition,
} from "./bash.ts";
export {
	clampChars,
	clampTopK,
	createDatasheetTool,
	createDatasheetToolDefinition,
	type DatasheetToolDetails,
	type DatasheetToolInput,
	encodeRel,
	formatCitation,
	type SearchHit,
} from "./datasheet.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
} from "./edit.ts";
export {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	findFirstChangedLine,
	fuzzyFindText,
	generateUnifiedPatch,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	buildFlashArgs,
	createFlashTool,
	createFlashToolDefinition,
	FLASH_ACTIONS,
	type FlashAction,
	type FlashToolDetails,
	type FlashToolInput,
	type FlashToolOptions,
} from "./flash.ts";
export {
	buildServerArgv,
	classifyEval,
	createGdbTool,
	createGdbToolDefinition,
	elfMachine,
	type EvalClass,
	type ExecOp,
	EXEC_OPS,
	GDB_ACTIONS,
	GDB_SERVERS,
	type GdbAction,
	type GdbServerKind,
	GdbSession,
	type GdbToolDetails,
	type GdbToolInput,
	hexToWords,
	parseConnect,
	pickFreePort,
	preferredGdbNames,
	renderBanner,
	resolveGdbPath,
	SERVER_CAPS,
	type ServerCaps,
	spawnServer,
	waitForServerReady,
} from "./gdb.ts";
export {
	clip,
	type CoreId,
	decodeBreakpointUnits,
	decodeCpuid,
	decodeDfsr,
	decodeDhcsr,
	decodeException,
	decodeExcReturn,
	decodeFault,
	decodeStackedFrame,
	decodeWatchpointUnits,
	escapeCString,
	type ExcReturnInfo,
	type FaultDecode,
	type Flag,
	type Frame,
	frameOf,
	frameRecords,
	type FrameResult,
	hex,
	MAX_RECORD_CHARS,
	type MiRecord,
	type MiTuple,
	type MiValue,
	miNumber,
	miString,
	miTuple,
	parseMiValue,
	parseRecord,
	parseResults,
	parseResultsStrict,
	type RecordKind,
	renderFrame,
	renderFrames,
	SCB,
	type StackedFrame,
	unwrapList,
} from "./gdb-mi.ts";
export {
	buildAttachArgs,
	createLogTool,
	createLogToolDefinition,
	foldLines,
	LOG_ACTIONS,
	LogCapture,
	type LogAction,
	type LogLine,
	type LogToolDetails,
	type LogToolInput,
	renderRows,
	selectForDisplay,
	splitArgv,
	splitChunk,
} from "./log.ts";
export {
	createNetlistTool,
	createNetlistToolDefinition,
	type NetlistToolDetails,
	type NetlistToolInput,
	type NetlistToolOptions,
	sanitizeStem,
} from "./netlist.ts";
export { fromMsysPath, resolveReadPath, resolveToCwd } from "./path-utils.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
} from "./read.ts";
export {
	buildStm32ConfigArgs,
	createStm32ConfigTool,
	createStm32ConfigToolDefinition,
	STM32CONFIG_COMMANDS,
	type Stm32ConfigCommand,
	type Stm32ConfigToolDetails,
	type Stm32ConfigToolInput,
	type Stm32ConfigToolOptions,
} from "./stm32config.ts";
export { type ToolDefinition, wrapToolDefinition, wrapToolDefinitions } from "./types.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolDetails,
	type WriteToolInput,
} from "./write.ts";

import type { ExecutionEnv } from "@yoma/my-pi";
import { createBashToolDefinition } from "./bash.ts";
import { createDatasheetToolDefinition } from "./datasheet.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createFlashToolDefinition } from "./flash.ts";
import { createGdbToolDefinition } from "./gdb.ts";
import { createLogToolDefinition } from "./log.ts";
import { createNetlistToolDefinition } from "./netlist.ts";
import { createReadToolDefinition } from "./read.ts";
import { createStm32ConfigToolDefinition } from "./stm32config.ts";
import type { ToolDefinition } from "./types.ts";
import { createWriteToolDefinition } from "./write.ts";

export type ToolDef = ToolDefinition<any, any>;

/** 编码四件套,顺序与 pi 一致。 */
export function createCodingToolDefinitions(env: ExecutionEnv): ToolDef[] {
	return [
		createReadToolDefinition(env),
		createBashToolDefinition(env),
		createEditToolDefinition(env),
		createWriteToolDefinition(env),
	];
}

/**
 * 嵌入式引擎工具组,顺序即流水线:
 * netlist(原理图)→ datasheet(查手册,全在线)→ stm32config(驱动)→ flash(烧录)
 * → log(看板子真正打了什么)→ gdb(日志不够时进去看寄存器和栈,闭环的最后一环)。
 * 与编码四件套分开装配:引擎未构建/服务器未配置时工具仍会注册,
 * 调用时才返回修复指引(与 yoma 行为一致)。
 */
export function createEmbeddedToolDefinitions(env: ExecutionEnv): ToolDef[] {
	return [
		createNetlistToolDefinition(env),
		createDatasheetToolDefinition(env),
		createStm32ConfigToolDefinition(env),
		createFlashToolDefinition(env),
		createLogToolDefinition(env),
		createGdbToolDefinition(env),
	];
}
