/**
 * toolchain 工具:项目声明需要哪些主机工具链(.yoma/toolchain.json),这台机器上
 * 有什么(core/toolchain/resolve.ts 的七档探测),两者对不上时怎么问用户、怎么记
 * 住答案——三个动作分别是"看现状""强制重新看一遍并记住""把用户的回答记下来"。
 *
 * 与 flash/stm32config 等引擎工具不同:这里不 spawn engines/ 下的二进制,探测 /
 * 账本 / 版本探针全部在 core/toolchain/ 子系统里(它自己直接用 node:child_process,
 * 不经 engines.ts 的 runEngine)。这个文件只是薄薄一层"参数 -> 调用 -> 渲染成人话"。
 *
 * check 与 resolve 共享同一条解析 + 渲染路径,区别只有两点:resolve 传 skipLedger
 * 让这一次解析看不见账本,然后把新鲜结果写回真正的账本(见 rememberFreshResults);
 * check 是纯读,谁都不写。
 */
import type { AgentToolResult, ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import { recordToolchainPath, rememberFreshResults } from "../toolchain/actions.ts";
import { type ResolvedTool, resolveToolchain, type ToolchainResolution } from "../toolchain/resolve.ts";
import { MANIFEST_RELATIVE } from "../toolchain/schema.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

export const TOOLCHAIN_ACTIONS = ["check", "resolve", "set"] as const;

export type ToolchainAction = (typeof TOOLCHAIN_ACTIONS)[number];

const toolchainSchema = Type.Object({
	// 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
	action: Type.Optional(
		Type.Union([Type.Literal("check"), Type.Literal("resolve"), Type.Literal("set")], {
			description:
				"check (default): report every declared tool's status on this machine. resolve: skip the cached ledger, probe fresh, and remember what is found. set: record a path the user gave you for one tool id (requires id and path).",
		}),
	),
	id: Type.Optional(
		Type.String({ description: 'Tool id from toolchain.json, e.g. "arm-gcc". Required for action:"set".' }),
	),
	path: Type.Optional(
		Type.String({ description: 'Absolute path to the executable the user pointed you at. Required for action:"set".' }),
	),
});

export type ToolchainToolInput = Static<typeof toolchainSchema>;

export interface ToolchainToolDetails {
	action: ToolchainAction;
	ok: boolean;
	side?: "mother" | "runner";
	/** check / resolve 才有:每个声明工具的完整解析结果。 */
	tools?: ResolvedTool[];
	/** set 才有:被记录的工具 id。 */
	id?: string;
}

export interface ToolchainToolOptions {
	/** 账本目录,默认 ~/.yoma(与 ledger.ts 的 defaultConfigDir 同义)。测试与工位端注入。 */
	configDir?: string;
	/** 默认 "mother"(resolveToolchain 自己的默认值)。工位端场景由调用方注入 "runner"。 */
	side?: "mother" | "runner";
	/** 默认 process.platform;测试用它覆盖平台相关的探测分支。 */
	platform?: string;
	/** 默认 process.env;测试用它隔离真实环境变量、注入假 PATH。 */
	env?: NodeJS.ProcessEnv;
	/**
	 * 清单原文,绕开"从 cwd 读 .yoma/toolchain.json"。**工位端必须注入**:它没有项目
	 * 检出,清单是经信箱送来的 —— 不注入的话,系统提示词里是 runner 筛过的清单,而
	 * agent 自己跑 toolchain check 却报"没有清单",两边自相矛盾(实测踩过)。
	 */
	manifestText?: string;
}

const DESCRIPTION = `Resolves the project's declared host toolchain (compiler, cmake, ninja, debug-probe drivers, python, ...) against what is actually installed on this machine, using the project's ${MANIFEST_RELATIVE} manifest.

Actions:
- check (default): report each declared tool's status — ok / missing / version mismatch / ambiguous — with its resolved path, version, and how it was found (cached ledger, PATH, a known install location, ...). Missing or wrong-version tools come with an install hint when the manifest has one.
- resolve: like check, but skips the cached ledger and probes fresh, then remembers what it finds for every later session on this machine.
- set (id, path): after asking the user where a tool lives and getting an answer, call this with the tool's id and the path they gave you. It verifies the path exists and actually reports a version before recording it — a bad path is rejected with a clear reason, not silently accepted.

When to reach for this: the moment a command fails with "command not found", "'cmake' is not recognized as an internal or external command" (or the Chinese-Windows wording, "不是内部或外部命令"), or the build system reports it can't find a compiler, run \`toolchain check\` FIRST. Do not go hunting for the binary yourself with where/which, do not guess an install path, and never hard-code a path into a script or command — an ad-hoc find like that is never remembered and silently drifts the moment this project is built on a different machine, which is exactly the failure mode this tool exists to prevent. If check reports a tool missing or the wrong version, relay its install hint to the user; once they tell you where the right one actually is, call \`toolchain set\`.

If the project has no ${MANIFEST_RELATIVE}, check says so and asks whether to draft one from the build files — never generate it unprompted, only after the user says yes.`;

// ─── 渲染:ResolvedTool -> 人话一行 ─────────────────────────────────────────────

function renderLine(t: ResolvedTool): string {
	const label = t.optional ? `${t.id} (optional)` : t.id;
	const need = t.wanted ? ` (needs ${t.wanted})` : "";
	switch (t.status) {
		case "ok": {
			const primary = Object.values(t.bin)[0] ?? "(unknown path)";
			return `- ${label}: OK${need} — ${primary}, version ${t.version ?? "unknown"}, via ${t.source ?? "unknown"}`;
		}
		case "missing": {
			const advice = t.hint
				? `install hint: ${t.hint}`
				: "no install hint for this platform — ask the user how it's normally installed here";
			return `- ${label}: MISSING${need} — ${advice}`;
		}
		case "version-mismatch": {
			const at = t.candidates?.[0];
			const found = t.version ? `found ${t.version}${at ? ` at ${at}` : ""}` : "found an unrecognized version";
			const advice = t.hint ? `; upgrade hint: ${t.hint}` : "";
			return `- ${label}: VERSION MISMATCH${need} — ${found}${advice}`;
		}
		case "ambiguous": {
			const list = (t.candidates ?? []).join(", ") || "(no candidates recorded)";
			return `- ${label}: AMBIGUOUS${need} — multiple installs with inconsistent versions: ${list}. Ask the user which one to use, don't guess.`;
		}
	}
}

function renderResolution(resolution: ToolchainResolution, action: ToolchainAction): AgentToolResult<ToolchainToolDetails> {
	if (!resolution.manifest) {
		const text =
			`No toolchain manifest found (expected ${MANIFEST_RELATIVE}) — this project hasn't declared any host toolchain requirements.\n\n` +
			"Want me to draft one from the build files (CMakeLists.txt, Makefile, ...)? Ask the user first — don't generate it unprompted.";
		return { content: [{ type: "text", text }], details: { action, ok: true } };
	}

	const freshNote = action === "resolve" ? " — freshly probed, saved to the toolchain ledger" : "";
	const header = `Toolchain requirements from ${resolution.manifestPath ?? MANIFEST_RELATIVE} (side: ${resolution.side})${freshNote}:`;
	const body =
		resolution.tools.length > 0
			? resolution.tools.map(renderLine).join("\n")
			: `(no tools declared for side "${resolution.side}")`;
	const attention = resolution.needsAttention.filter((t) => !t.optional);
	const summary =
		attention.length > 0
			? `Required tools needing attention: ${attention.map((t) => t.id).join(", ")}.`
			: "All required tools resolved.";

	return {
		content: [{ type: "text", text: [header, body, summary].join("\n") }],
		details: { action, ok: resolution.ok, side: resolution.side, tools: resolution.tools },
	};
}

// ─── set 动作 ────────────────────────────────────────────────────────────────

/**
 * 参数校验留在工具层(缺参是模型没按 schema 来,话术要教它怎么补);路径验证与写
 * 账本在 toolchain/actions.ts 的 recordToolchainPath —— 与桌面端 RPC 同一套实现,
 * 两个入口的拒绝理由、账本形态因此不可能分叉。
 */
async function runSet(
	params: ToolchainToolInput,
	configDir: string | undefined,
): Promise<AgentToolResult<ToolchainToolDetails>> {
	const id = params.id?.trim();
	if (!id) throw new Error('toolchain set requires "id" (the tool id from toolchain.json, e.g. "arm-gcc")');
	const rawPath = params.path?.trim();
	if (!rawPath) throw new Error('toolchain set requires "path" (the absolute path the user gave you)');

	const recorded = await recordToolchainPath({ id, path: rawPath, configDir });

	const text = `Recorded ${recorded.id} -> ${recorded.binPath} (version ${recorded.version}) in the toolchain ledger. Every later session on this machine will find it automatically — no need to ask again.`;
	return { content: [{ type: "text", text }], details: { action: "set", ok: true, id } };
}

// ─── 工厂 ────────────────────────────────────────────────────────────────────

export function createToolchainToolDefinition(
	env: ExecutionEnv,
	options?: ToolchainToolOptions,
): ToolDefinition<typeof toolchainSchema, ToolchainToolDetails> {
	return {
		name: "toolchain",
		label: "toolchain",
		description: DESCRIPTION,
		promptSnippet: "Resolve the project's required host toolchains against what's installed on this machine",
		promptGuidelines: [
			'The moment a command fails with "command not found" / "not recognized as an internal or external command" / a missing-compiler error, run toolchain check before searching for the binary yourself — never where/which it or hard-code a guessed path.',
			"If toolchain check reports no manifest, ask the user before drafting .yoma/toolchain.json — never generate it unprompted.",
		],
		parameters: toolchainSchema,
		execute: async (_toolCallId, params) => {
			const action: ToolchainAction = params.action ?? "check";
			if (action === "set") return runSet(params, options?.configDir);

			const resolution = await resolveToolchain({
				projectDir: env.cwd,
				configDir: options?.configDir,
				// resolve 的语义:不信旧记录,重新探一遍(写回仍由 rememberFreshResults 做)。
				skipLedger: action === "resolve",
				side: options?.side,
				platform: options?.platform,
				env: options?.env,
				manifestText: options?.manifestText,
			});

			if (action === "resolve") await rememberFreshResults(resolution, options?.configDir);

			return renderResolution(resolution, action);
		},
	};
}

export function createToolchainTool(env: ExecutionEnv, options?: ToolchainToolOptions) {
	return wrapToolDefinition(createToolchainToolDefinition(env, options));
}
