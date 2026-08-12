/**
 * write 工具。移植自 pi coding-agent/src/core/tools/write.ts。
 *
 * 与 pi 的差异:写入走注入的 FileSystem;父目录由 NodeExecutionEnv.writeFile 自己建
 * (pi 是在工具里显式 mkdir),去掉 TUI 渲染器。
 */
import type { FileSystem } from "@yoma/my-pi";
import { type Static, Type } from "typebox";
import { throwIfAborted, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	path: string;
	bytes: number;
	/** 之前不存在则为 true,给 UI 区分"新建"和"覆盖"。 */
	created: boolean;
	/** 覆盖前的内容;新建时为 null。与 EditToolDetails 一样,给 ACP 的结构化 diff 用。 */
	oldContent: string | null;
	/** 写入后的内容。没有它 Zed 只能画出一个空 diff。 */
	newContent: string;
}

export function createWriteToolDefinition(
	env: FileSystem,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		// 同一文件的写入必须串行,理由见 file-mutation-queue.ts。
		executionMode: "sequential",
		async execute(_toolCallId, { path, content }, signal) {
			const absolutePath = await resolveToCwd(env, path);
			return withFileMutationQueue(env, absolutePath, async () => {
				// 每个 await 之后查一次中断,理由见 throwIfAborted。
				throwIfAborted(signal);
				const existed = await env.exists(absolutePath);
				throwIfAborted(signal);

				const created = !(existed.ok && existed.value);
				// 覆盖时先把旧内容读出来,否则 ACP 那边只能画出"从空白变成新内容"的假 diff。
				// 读失败(二进制、权限)不阻断写入,退化成新建的表现即可。
				let oldContent: string | null = null;
				if (!created) {
					const previous = await env.readTextFile(absolutePath);
					if (previous.ok) oldContent = previous.value;
					throwIfAborted(signal);
				}

				const writeResult = await env.writeFile(absolutePath, content);
				if (!writeResult.ok) throw new Error(writeResult.error.message);
				throwIfAborted(signal);

				return {
					content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: {
						path: absolutePath,
						bytes: content.length,
						created,
						oldContent,
						newContent: content,
					},
				};
			});
		},
	};
}

export function createWriteTool(env: FileSystem) {
	return wrapToolDefinition(createWriteToolDefinition(env));
}
