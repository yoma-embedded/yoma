/**
 * 工具链清单的公共类型 + 纯函数:解析、按 side 筛选、取安装指引。
 *
 * 只做这三件事,不碰文件系统 —— 落盘/读账本是 ledger.ts 的事,PATH / 已知安装
 * 位置 / 注册表扫描是 locations.ts 的事,版本比较是 version.ts 的事,把它们攒成
 * 结论是 resolve.ts 的事。这个边界是故意的:manifest 的形状是所有消费方的公共
 * 契约,谁都不该在自己的模块里重新发明一遍 ToolchainManifest。
 */

export type ToolSide = "mother" | "runner" | "both";
export type PlatformKey = "win32" | "darwin" | "linux";

export interface ProviderSpec {
	name?: string;
	install?: Partial<Record<PlatformKey, string>>;
}

export interface ToolSpec {
	id: string;
	/** 可执行文件名,不带扩展名 —— PATHEXT / `.exe` 展开是 locations.ts 的事,不是这里。 */
	bin?: string[];
	/** 版本范围,如 ">=3.22"、"^3.11"、"12"。语法由 version.ts 的 satisfies() 认。 */
	version?: string;
	/** 缺省 "mother"。 */
	side?: ToolSide;
	optional?: boolean;
	/** providers 的键,借它的 install 作为 installHint() 的回退。 */
	from?: string;
	/** 覆盖(不是合并)provider 的 install。 */
	install?: Partial<Record<PlatformKey, string>>;
	/** 值里的 "{bin}" 会被替换成解析到的第一个 bin 绝对路径 —— 替换逻辑在 resolve.ts。 */
	exports?: Record<string, string>;
	/** 非可执行产物(如动态库),只做存在性说明,不参与探测顺序。 */
	provides?: string[];
	/** 探测时优先读的环境变量名,按声明顺序尝试。 */
	env?: string[];
	/** 工位端要装的 pip 包名;mother 侧不看这个字段。 */
	runnerPackages?: string[];
	why?: string;
}

export interface SetupStep {
	run: string;
	cwd?: string;
	/** shell 条件命令;成立(exit 0)就跳过这一步。 */
	unless?: string;
	optional?: boolean;
	why?: string;
}

export interface ToolchainManifest {
	schema: "yoma/toolchain@1";
	providers?: Record<string, ProviderSpec>;
	tools: ToolSpec[];
	setup?: SetupStep[];
}

/** `<工程>/.my-pi/toolchain.json` —— 提交进库,只说"要什么",零绝对路径。 */
export const MANIFEST_RELATIVE = ".my-pi/toolchain.json";
/** `<工程>/.my-pi/toolchain.local.json` —— 不提交,项目级覆盖(可选)。 */
export const LOCAL_RELATIVE = ".my-pi/toolchain.local.json";

const SCHEMA_TAG = "yoma/toolchain@1";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── jsonc-lite:只剥 `//` 行注释 ──────────────────────────────────────────────
//
// 不引依赖(仓里没有 jsonc 解析库,为几行代码加一条不划算)。逐字符走一遍、
// 认清字符串边界就够:字符串里的 `//`(install 提示里常见的 URL,比如
// "https://developer.arm.com")必须原样保留,不能被当成注释起点截断。块注释、
// 尾逗号清单里用不到,不做。

function stripLineComments(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			// i 现在停在换行符或文本末尾;外层 for 的 i++ 会跨过它,所以换行符要在
			// 这里补回 out,否则被注释隔开的两行会粘成一行。
			if (i < text.length) out += "\n";
			continue;
		}
		out += c;
	}
	return out;
}

// ─── 绝对路径探测 ─────────────────────────────────────────────────────────────
//
// 清单要在两台机器上被读,任何一处硬编码的绝对路径在另一台机器上大概率指向
// 不存在的文件。按"独占一个由空白或字符串起点分隔的 token,以 / 或盘符开头"
// 识别,而不是要求整个字段值就是路径 —— 这样才能抓住"顺手写在 install 提示
// 句子里的那一小段",不只是字段本身整体就是路径的情况。要求 token 前面是空白
// 或字符串起点,是为了不把 install 提示里常见的 "https://developer.arm.com"
// 这类 URL 误判成绝对路径(斜杠前面是 ":"而不是空白)。
//
// 三种写法都要认。UNC(`\\server\share\...`)是漏过一次的:它和盘符路径在
// Windows 上是并列的两种绝对路径,而清单里最可能出现它的地方恰恰是 install/why
// 里顺手写的一句"从 \\buildserver\tools\JLink 拷过来" —— 那台构建服务器在别人
// 的机器上根本不可达,正是这道闸门存在的全部理由。

const ABS_PATH_TOKEN = /(?:^|\s)(\/\S+|[A-Za-z]:[\\/]\S*|\\\\\S+)/;

function findAbsolutePath(value: unknown, at: string): { at: string; snippet: string } | undefined {
	if (typeof value === "string") {
		const hit = ABS_PATH_TOKEN.exec(value);
		return hit ? { at, snippet: hit[1] } : undefined;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = findAbsolutePath(value[i], `${at}[${i}]`);
			if (hit) return hit;
		}
		return undefined;
	}
	if (isPlainObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			const hit = findAbsolutePath(child, at ? `${at}.${key}` : key);
			if (hit) return hit;
		}
	}
	return undefined;
}

// ─── 解析 + 校验 ──────────────────────────────────────────────────────────────

export type ParseManifestResult = { ok: true; manifest: ToolchainManifest } | { ok: false; error: string };

/**
 * 解析 + 校验。失败给人话错误(指名道姓哪个字段),不抛裸 SyntaxError ——
 * 这句话是模型和用户看到的第一道诊断,"Unexpected token } in JSON at position
 * 812" 没人知道该改清单里的哪一行。
 */
export function parseManifest(text: string): ParseManifestResult {
	let parsed: unknown;
	try {
		// 开头的 BOM(码点 U+FEFF)是 Windows 编辑器常留的手笔;JSON.parse 见了
		// 直接炸,报出来的错跟内容毫无关系,不如先剥掉。用 fromCharCode(0xfeff)
		// 构造,不在源码里直接敲那个字符 —— 它是零宽的,diff/编辑器里都看不见,
		// 复制粘贴时极易连着一起被吃掉或漏掉,不如干脆别让它出现在源文件里。
		const BOM = String.fromCharCode(0xfeff);
		const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;
		parsed = JSON.parse(stripLineComments(withoutBom));
	} catch (error) {
		return { ok: false, error: `${MANIFEST_RELATIVE} is not valid JSON: ${(error as Error).message}` };
	}

	if (!isPlainObject(parsed)) {
		return { ok: false, error: `${MANIFEST_RELATIVE}: must be a JSON object` };
	}

	const schema = parsed.schema;
	if (schema !== SCHEMA_TAG) {
		return {
			ok: false,
			error: `${MANIFEST_RELATIVE}: "schema" must be "${SCHEMA_TAG}" (got ${JSON.stringify(schema)})`,
		};
	}

	// 全文档扫一遍绝对路径,顺序排在结构校验之前:这是最容易被顺手写坏的一条
	// (install 提示随手抄一句本机路径),而且与 tools/providers 的形状是否合法
	// 无关,越早报越好。
	const abs = findAbsolutePath(parsed, "");
	if (abs) {
		return {
			ok: false,
			error:
				`${MANIFEST_RELATIVE}: ${abs.at || "(root)"} contains an absolute path ("${abs.snippet}") — this ` +
				"manifest is read on two machines, so it can't hardcode a path that only exists on one of them",
		};
	}

	const rawTools = parsed.tools;
	if (!Array.isArray(rawTools)) {
		return { ok: false, error: `${MANIFEST_RELATIVE}: "tools" must be an array` };
	}

	const seenIds = new Map<string, number>();
	for (let i = 0; i < rawTools.length; i++) {
		const tool: unknown = rawTools[i];
		if (!isPlainObject(tool)) {
			return { ok: false, error: `${MANIFEST_RELATIVE}: tools[${i}] must be an object` };
		}
		const id = tool.id;
		if (typeof id !== "string" || id.trim() === "") {
			return { ok: false, error: `${MANIFEST_RELATIVE}: tools[${i}].id must be a non-empty string` };
		}
		const prior = seenIds.get(id);
		if (prior !== undefined) {
			return {
				ok: false,
				error: `${MANIFEST_RELATIVE}: duplicate tool id "${id}" (tools[${prior}] and tools[${i}])`,
			};
		}
		seenIds.set(id, i);
	}

	const rawProviders = parsed.providers;
	if (rawProviders !== undefined && !isPlainObject(rawProviders)) {
		return { ok: false, error: `${MANIFEST_RELATIVE}: "providers" must be an object` };
	}
	const providerIds = new Set(isPlainObject(rawProviders) ? Object.keys(rawProviders) : []);

	for (const raw of rawTools) {
		if (!isPlainObject(raw)) continue; // 上面已经报过错,这里只是让 TS 满意
		const from = raw.from;
		if (typeof from === "string" && !providerIds.has(from)) {
			return {
				ok: false,
				error: `${MANIFEST_RELATIVE}: tools[id="${String(raw.id)}"].from references unknown provider "${from}"`,
			};
		}
	}

	return { ok: true, manifest: parsed as unknown as ToolchainManifest };
}

// ─── side 筛选 ───────────────────────────────────────────────────────────────

/**
 * 按 side 筛子集;side 缺省视为 "mother","both" 两边都进。providers 一并裁到
 * 筛后的 tools 还在用的那些 —— 不裁的话 runner 侧的清单会带着一堆它永远用不到、
 * 只属于 mother 工具链的安装指引,将来塞进系统提示词(promptSectionFor)全是噪音。
 */
export function manifestForSide(m: ToolchainManifest, side: "mother" | "runner"): ToolchainManifest {
	const tools = m.tools.filter((tool) => {
		const toolSide = tool.side ?? "mother";
		return toolSide === side || toolSide === "both";
	});
	if (!m.providers) return { ...m, tools };
	const used = new Set(tools.map((tool) => tool.from).filter((from): from is string => from !== undefined));
	const providers = Object.fromEntries(Object.entries(m.providers).filter(([id]) => used.has(id)));
	return { ...m, tools, providers };
}

// ─── 安装指引 ────────────────────────────────────────────────────────────────

/** 取安装指引:tool.install[platform] ?? providers[tool.from].install[platform]。 */
export function installHint(m: ToolchainManifest, tool: ToolSpec, platform: string): string | undefined {
	const key = platform as PlatformKey;
	return tool.install?.[key] ?? (tool.from ? m.providers?.[tool.from]?.install?.[key] : undefined);
}
