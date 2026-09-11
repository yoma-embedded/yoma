/**
 * 工具定义层。
 *
 * pi 的 ToolDefinition(coding-agent/src/core/extensions/types.ts)比 AgentTool 多两类字段:
 * 1. 提示词元数据(promptSnippet / promptGuidelines)—— 喂给系统提示词生成器(M9)
 * 2. TUI 渲染器(renderCall / renderResult)
 *
 * yoma 保留第 1 类、去掉第 2 类:没有 TUI,而且渲染信息最终要经 ACP 传给 Zed,
 * 靠的是结构化的 `details`,不是终端字符串。
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@yoma/agent";
import type { Static, TSchema } from "typebox";

export interface ToolDefinition<TParameters extends TSchema = TSchema, TDetails = any> {
	name: string;
	/** UI 展示用的人类可读名字。 */
	label: string;
	/** 给模型看的完整说明。 */
	description: string;
	/** 系统提示词里的一句话摘要。 */
	promptSnippet?: string;
	/** 系统提示词里追加的使用守则。 */
	promptGuidelines?: string[];
	parameters: TParameters;
	/** schema 校验之前对原始参数做兼容整形。 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	executionMode?: ToolExecutionMode;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

/** 把 ToolDefinition 收窄成内核运行时要的 AgentTool。 */
export function wrapToolDefinition<TParameters extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: definition.execute,
	};
}

export function wrapToolDefinitions(definitions: ToolDefinition<any, any>[]): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition));
}
