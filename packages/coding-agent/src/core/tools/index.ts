/**
 * 工具集装配。对应 pi coding-agent/src/core/tools/index.ts。
 *
 * 与 pi 的差异:工厂第一个参数是注入的 ExecutionEnv 而不是 cwd 字符串 ——
 * cwd 从 env.cwd 拿,文件与进程访问都经由 env,于是同一套工具对远程/沙箱环境也成立。
 * 这正是 pi 用 ReadOperations/WriteOperations/BashOperations 那几套
 * 可插拔接口达成的目的,yoma 用一个能力接口一次性覆盖。
 *
 * 装配面只有两个工厂:编码工具组(四件套 + toolchain)+ 嵌入式六件套。按名挑选、
 * 聚合 Options、grep(依赖外部 ripgrep,本仓永远不可用)等历史装配面在 2026-08
 * 的精简中删除;单工具工厂仍然从各自模块导出,测试和特殊装配直接用它们。
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
export {
	createExamplesTool,
	createExamplesToolDefinition,
	EXAMPLES_ACTIONS,
	type ExamplesAction,
	type ExamplesToolDetails,
	type ExamplesToolInput,
	type ExamplesToolOptions,
} from "./examples.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFlashTool,
	createFlashToolDefinition,
	FLASH_STATE_FILE,
	type FlashState,
	type FlashToolDetails,
	type FlashToolInput,
	readFlashState,
	sha256File,
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
	createLogTool,
	createLogToolDefinition,
	foldLines,
	LOG_ACTIONS,
	LogCapture,
	type LogAction,
	type LogLine,
	type LogSource,
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
	buildSttyArgs,
	DEFAULT_BAUD,
	listSerialPorts,
	normalizeSerialPort,
	parsePortLines,
	powershellArgv,
	prepareSerial,
	serialArgv,
	serialOpenConfirmMs,
	type SerialPortInfo,
	unsupportedBaud,
	windowsReaderScript,
} from "./serial.ts";
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
export {
	createToolchainTool,
	createToolchainToolDefinition,
	TOOLCHAIN_ACTIONS,
	type ToolchainAction,
	type ToolchainToolDetails,
	type ToolchainToolInput,
	type ToolchainToolOptions,
} from "./toolchain.ts";
export { type ToolDefinition, wrapToolDefinition, wrapToolDefinitions } from "./types.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolDetails,
	type WriteToolInput,
} from "./write.ts";

import type { ExecutionEnv } from "@yoma/agent";
import { createBashToolDefinition } from "./bash.ts";
import { createDatasheetToolDefinition } from "./datasheet.ts";
import { createEditToolDefinition } from "./edit.ts";
import { createExamplesToolDefinition } from "./examples.ts";
import { createFlashToolDefinition } from "./flash.ts";
import { createGdbToolDefinition } from "./gdb.ts";
import { createLogToolDefinition } from "./log.ts";
import { createNetlistToolDefinition } from "./netlist.ts";
import { createReadToolDefinition } from "./read.ts";
import { createStm32ConfigToolDefinition } from "./stm32config.ts";
import { createToolchainToolDefinition, type ToolchainToolOptions } from "./toolchain.ts";
import type { ToolDefinition } from "./types.ts";
import { createWriteToolDefinition } from "./write.ts";

export type ToolDef = ToolDefinition<any, any>;

/**
 * 编码四件套 + toolchain,顺序前四与 pi 一致。toolchain 归在这一档而不是嵌入式
 * 六件套:它解决的是"这台机器能不能编译/调试这个项目",跟 netlist/datasheet/
 * flash/log/gdb 那条"板子在手上之后"的流水线是两回事,反而更接近 bash 会撞见的
 * 那类问题(命令找不到)。
 *
 * options.toolchain 是给 kernel host 这类生产调用方的注入口:host 自己拿着
 * configDir / toolchainSide / manifestText(工位端没有项目检出,清单经信箱送来),
 * 不注入的话,系统提示词里是 runner 筛过的清单,agent 自己跑 toolchain check 却按
 * mother + 真实 ~/.yoma + 磁盘清单来答 —— 两边自相矛盾,工位端直接报"没有清单"。
 * 不传 options 时全部走默认值(ACP 适配器与测试的既有行为,一个字节不变)。
 */
export function createCodingToolDefinitions(env: ExecutionEnv, options?: { toolchain?: ToolchainToolOptions }): ToolDef[] {
	return [
		createReadToolDefinition(env),
		createBashToolDefinition(env),
		createEditToolDefinition(env),
		createWriteToolDefinition(env),
		createToolchainToolDefinition(env, options?.toolchain),
		// examples 与 toolchain 同档:回答"这个工程从哪来"(种子起步),不依赖 engines。
		createExamplesToolDefinition(env),
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
