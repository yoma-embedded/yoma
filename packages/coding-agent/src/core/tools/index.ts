/**
 * 工具集装配。对应 pi coding-agent/src/core/tools/index.ts。
 *
 * 与 pi 的差异:工厂第一个参数是注入的 ExecutionEnv 而不是 cwd 字符串 ——
 * cwd 从 env.cwd 拿,文件与进程访问都经由 env,于是同一套工具对远程/沙箱环境也成立。
 * 这正是 pi 用 ReadOperations/WriteOperations/GrepOperations/BashOperations 四套
 * 可插拔接口达成的目的,my-pi 用一个能力接口一次性覆盖。
 *
 * 尚未移植:find(依赖 fd 二进制)、ls。等真用到再补。
 */
export {
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
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
	type EditToolOptions,
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
	type GdbToolOptions,
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
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	ripgrepAvailable,
} from "./grep.ts";
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
	type LogToolOptions,
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
export { resolveReadPath, resolveToCwd } from "./path-utils.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
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
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool, ExecutionEnv } from "@yoma/my-pi";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createDatasheetTool, createDatasheetToolDefinition } from "./datasheet.ts";
import { createFlashTool, createFlashToolDefinition, type FlashToolOptions } from "./flash.ts";
import { createGdbTool, createGdbToolDefinition, type GdbToolOptions } from "./gdb.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions, ripgrepAvailable } from "./grep.ts";
import { createLogTool, createLogToolDefinition, type LogToolOptions } from "./log.ts";
import { createNetlistTool, createNetlistToolDefinition, type NetlistToolOptions } from "./netlist.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createStm32ConfigTool, createStm32ConfigToolDefinition, type Stm32ConfigToolOptions } from "./stm32config.ts";
import type { ToolDefinition } from "./types.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "stm32config"
	| "netlist"
	| "flash"
	| "datasheet"
	| "log"
	| "gdb";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"stm32config",
	"netlist",
	"flash",
	"datasheet",
	"log",
	"gdb",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	stm32config?: Stm32ConfigToolOptions;
	netlist?: NetlistToolOptions;
	flash?: FlashToolOptions;
	log?: LogToolOptions;
	gdb?: GdbToolOptions;
}

export function createToolDefinition(toolName: ToolName, env: ExecutionEnv, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(env, options?.read);
		case "bash":
			return createBashToolDefinition(env, options?.bash);
		case "edit":
			return createEditToolDefinition(env, options?.edit);
		case "write":
			return createWriteToolDefinition(env, options?.write);
		case "grep":
			return createGrepToolDefinition(env, options?.grep);
		case "stm32config":
			return createStm32ConfigToolDefinition(env, options?.stm32config);
		case "netlist":
			return createNetlistToolDefinition(env, options?.netlist);
		case "flash":
			return createFlashToolDefinition(env, options?.flash);
		case "datasheet":
			return createDatasheetToolDefinition(env);
		case "log":
			return createLogToolDefinition(env, options?.log);
		case "gdb":
			return createGdbToolDefinition(env, options?.gdb);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, env: ExecutionEnv, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(env, options?.read);
		case "bash":
			return createBashTool(env, options?.bash);
		case "edit":
			return createEditTool(env, options?.edit);
		case "write":
			return createWriteTool(env, options?.write);
		case "grep":
			return createGrepTool(env, options?.grep);
		case "stm32config":
			return createStm32ConfigTool(env, options?.stm32config);
		case "netlist":
			return createNetlistTool(env, options?.netlist);
		case "flash":
			return createFlashTool(env, options?.flash);
		case "datasheet":
			return createDatasheetTool(env);
		case "log":
			return createLogTool(env, options?.log);
		case "gdb":
			return createGdbTool(env, options?.gdb);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/**
 * 编码用的五件套,顺序与 pi 一致 —— 但 grep 只在 ripgrep 真的在的时候才注册,
 * 理由见 grep.ts 的 ripgrepAvailable()。
 */
export function createCodingToolDefinitions(env: ExecutionEnv, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(env, options?.read),
		createBashToolDefinition(env, options?.bash),
		createEditToolDefinition(env, options?.edit),
		createWriteToolDefinition(env, options?.write),
		...(ripgrepAvailable(options?.grep?.rgPath) ? [createGrepToolDefinition(env, options?.grep)] : []),
	];
}

export function createCodingTools(env: ExecutionEnv, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(env, options?.read),
		createBashTool(env, options?.bash),
		createEditTool(env, options?.edit),
		createWriteTool(env, options?.write),
		...(ripgrepAvailable(options?.grep?.rgPath) ? [createGrepTool(env, options?.grep)] : []),
	];
}

/**
 * 嵌入式引擎工具组,顺序即流水线:
 * netlist(原理图)→ datasheet(查手册,全在线)→ stm32config(驱动)→ flash(烧录)
 * → log(看板子真正打了什么)→ gdb(日志不够时进去看寄存器和栈,闭环的最后一环)。
 * 与编码五件套分开装配:引擎未构建/服务器未配置时工具仍会注册,
 * 调用时才返回修复指引(与 yoma 行为一致)。
 */
export function createEmbeddedToolDefinitions(env: ExecutionEnv, options?: ToolsOptions): ToolDef[] {
	return [
		createNetlistToolDefinition(env, options?.netlist),
		createDatasheetToolDefinition(env),
		createStm32ConfigToolDefinition(env, options?.stm32config),
		createFlashToolDefinition(env, options?.flash),
		createLogToolDefinition(env, options?.log),
		createGdbToolDefinition(env, options?.gdb),
	];
}

export function createEmbeddedTools(env: ExecutionEnv, options?: ToolsOptions): Tool[] {
	return [
		createNetlistTool(env, options?.netlist),
		createDatasheetTool(env),
		createStm32ConfigTool(env, options?.stm32config),
		createFlashTool(env, options?.flash),
		createLogTool(env, options?.log),
		createGdbTool(env, options?.gdb),
	];
}

export function createReadOnlyTools(env: ExecutionEnv, options?: ToolsOptions): Tool[] {
	return [createReadTool(env, options?.read), createGrepTool(env, options?.grep)];
}

export function createAllTools(env: ExecutionEnv, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(env, options?.read),
		bash: createBashTool(env, options?.bash),
		edit: createEditTool(env, options?.edit),
		write: createWriteTool(env, options?.write),
		grep: createGrepTool(env, options?.grep),
		stm32config: createStm32ConfigTool(env, options?.stm32config),
		netlist: createNetlistTool(env, options?.netlist),
		flash: createFlashTool(env, options?.flash),
		datasheet: createDatasheetTool(env),
		log: createLogTool(env, options?.log),
		gdb: createGdbTool(env, options?.gdb),
	};
}
