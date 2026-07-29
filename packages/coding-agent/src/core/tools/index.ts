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
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export { resolveReadPath, resolveToCwd } from "./path-utils.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
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
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import type { ToolDefinition } from "./types.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep"]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
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
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

/** 编码用的五件套,顺序与 pi 一致。 */
export function createCodingToolDefinitions(env: ExecutionEnv, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(env, options?.read),
		createBashToolDefinition(env, options?.bash),
		createEditToolDefinition(env, options?.edit),
		createWriteToolDefinition(env, options?.write),
		createGrepToolDefinition(env, options?.grep),
	];
}

export function createCodingTools(env: ExecutionEnv, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(env, options?.read),
		createBashTool(env, options?.bash),
		createEditTool(env, options?.edit),
		createWriteTool(env, options?.write),
		createGrepTool(env, options?.grep),
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
	};
}
