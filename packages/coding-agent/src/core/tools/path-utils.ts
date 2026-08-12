/**
 * 工具的路径解析。
 *
 * 与 pi 的差异:pi 用 node:fs 的 accessSync/access 探测路径,my-pi 一律走注入的
 * FileSystem 能力(env.exists),这样工具对远程/沙箱文件系统同样成立 ——
 * 也就是 pi 靠 ReadOperations/WriteOperations 那套可插拔接口达到的效果。
 * 绝对化本身交给 env.absolutePath,它已经处理了 `~` 与 `file://`。
 */
import type { FileSystem } from "@yoma/my-pi";

const NARROW_NO_BREAK_SPACE = " ";

function tryMacOSScreenshotPath(filePath: string): string {
	// macOS 截图文件名在 AM/PM 前用的是窄不换行空格,用户手打的是普通空格。
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS 的文件名以 NFD(分解形式)存储,把用户输入转成 NFD 再试一次。
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS 在 "Capture d'écran" 这类名字里用的是 U+2019,用户通常打的是 U+0027。
	return filePath.replace(/'/g, "’");
}

/**
 * Git Bash(MSYS)风格的盘符路径,Windows 上翻译成真实盘符:"/d/foo" → "D:/foo"。
 * 模型在 bash 工具里看到的 pwd 就是这种形状,并且会原样把它喂给 read/netlist
 * 等其他工具;不翻译的话会被解析成 "D:\d\foo" 然后 ENOENT。导出给测试。
 */
export function fromMsysPath(filePath: string): string {
	if (process.platform !== "win32") return filePath;
	const m = /^\/([a-zA-Z])(\/.*)?$/.exec(filePath);
	return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : filePath;
}

/** 解析成绝对路径,不要求存在。 */
export async function resolveToCwd(env: FileSystem, filePath: string): Promise<string> {
	const result = await env.absolutePath(fromMsysPath(filePath));
	return result.ok ? result.value : filePath;
}

async function pathExists(env: FileSystem, path: string): Promise<boolean> {
	const result = await env.exists(path);
	return result.ok ? result.value : false;
}

/**
 * 读取用的路径解析:先按原样解析,不存在时依次尝试几种 macOS 文件名变体。
 * 全都不存在就返回最初解析的结果,让调用方去报"文件不存在"。
 */
export async function resolveReadPath(env: FileSystem, filePath: string): Promise<string> {
	const resolved = await resolveToCwd(env, filePath);
	if (await pathExists(env, resolved)) return resolved;

	// 依次尝试的变体,顺序即语义:先命中先返回。每条为什么存在,见各自的 tryX。
	const nfd = tryNFDVariant(resolved);
	const candidates = [
		tryMacOSScreenshotPath(resolved),
		nfd,
		tryCurlyQuoteVariant(resolved),
		// NFD + 弯引号的组合(法语 macOS 截图 "Capture d'écran" 就是这种)。
		tryCurlyQuoteVariant(nfd),
	];
	for (const candidate of candidates) {
		if (candidate !== resolved && (await pathExists(env, candidate))) return candidate;
	}

	return resolved;
}
