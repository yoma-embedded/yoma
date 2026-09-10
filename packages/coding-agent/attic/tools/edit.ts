/**
 * edit 工具。移植自 pi coding-agent/src/core/tools/edit.ts。
 *
 * 与 pi 的差异:文件访问走注入的 FileSystem;去掉 TUI 渲染器与预览组件;
 * details 里换成结构化的 oldContent/newContent —— ACP 的 tool_call_update
 * 直接吃这两个字段,由 Zed 画 diff,不需要我们生成带颜色的终端字符串。
 */
import type { FileSystem } from "@yoma/agent";
import { type Static, Type } from "typebox";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	findFirstChangedLine,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { throwIfAborted, withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	path: string;
	/** 改动前的内容(已归一化为 LF),给 ACP 的结构化 diff 用。 */
	oldContent: string;
	/** 改动后的内容(已归一化为 LF)。 */
	newContent: string;
	/** 标准 unified patch。 */
	patch: string;
	/** 新文件里第一处改动的行号,给编辑器跳转定位。 */
	firstChangedLine?: number;
}

function isSingleEdit(v: unknown): v is Edit {
	return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Edit).oldText === "string" && typeof (v as Edit).newText === "string";
}

/** 兼容模型的常见畸形入参:edits 传成 JSON 字符串(数组或单条),以及旧的顶层 oldText/newText 形式。 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// 有的模型会把 edits 发成 JSON 字符串,里面可能是数组也可能是单条。
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isSingleEdit(parsed)) args.edits = [parsed];
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	env: FileSystem,
): ToolDefinition<typeof editSchema, EditToolDetails> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = await resolveToCwd(env, path);

			return withFileMutationQueue(env, absolutePath, async () => {
				// 每个 await 之后查一次中断,理由见 throwIfAborted。
				throwIfAborted(signal);

				const readResult = await env.readTextFile(absolutePath);
				if (!readResult.ok) {
					throwIfAborted(signal);
					throw new Error(`Could not edit file: ${path}. Error code: ${readResult.error.code}.`);
				}
				const rawContent = readResult.value;
				throwIfAborted(signal);

				// 匹配前先剥掉 BOM —— 模型不会在 oldText 里带上这个不可见字符。
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted(signal);

				// 写回时把 BOM 和原来的行尾风格还原,免得一次 edit 顺手改掉整个文件的行尾。
				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				const writeResult = await env.writeFile(absolutePath, finalContent);
				if (!writeResult.ok) throw new Error(writeResult.error.message);
				throwIfAborted(signal);

				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text" as const,
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: {
						path: absolutePath,
						oldContent: baseContent,
						newContent,
						patch,
						firstChangedLine: findFirstChangedLine(baseContent, newContent),
					},
				};
			});
		},
	};
}

export function createEditTool(env: FileSystem) {
	return wrapToolDefinition(createEditToolDefinition(env));
}
