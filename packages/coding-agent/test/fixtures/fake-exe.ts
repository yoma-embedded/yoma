import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 假可执行文件(假引擎、假日志源、假烧录器):逻辑写成一段 JS,由当前这个 bun 跑,外面按平台包一层启动器。
 *
 *   - POSIX:`<dir>/<name>` 是 `#!/bin/sh` + `exec "<bun>" "<dir>/<name>.js" "$@"`,chmod 755
 *   - Windows:`<dir>/<name>.cmd` 是 `@"<bun>" "<dir>/<name>.js" %*` —— libuv 能直接 spawn .cmd,
 *     退出码与 stdout/stderr 原样透出;engineBin 在 .exe 缺席时也认 .cmd
 *
 * 从前这些假货都是 `#!/bin/sh` 脚本,Windows 上根本起不来(没有 sh,`.sh` 也不是可执行文件),
 * 于是 coding-agent 的引擎与日志两组单测在 Windows 上一个都跑不了 —— 而 CI 的 Windows 岗又不跑它们。
 *
 * 脚本约定:`process.argv.slice(2)` 就是调用方传的参数;输出用 console.log / console.error;
 * 退出码用 `process.exitCode = n` 然后让脚本自然结束(stdout 一定刷完)。
 * 已知限制:Windows 启动器经过 cmd.exe,参数里的 `&` `|` `<` `>` `^` 会被它当语法。测试的参数
 * 没有这些字符;真引擎在 Windows 上是 .exe,不走这条路。
 */
export function writeFakeExe(dir: string, name: string, js: string): string {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, `${name}.js`);
	writeFileSync(script, js);
	const launcher = join(dir, fakeExeName(name));
	if (process.platform === "win32") {
		writeFileSync(launcher, `@"${process.execPath}" "${script}" %*\r\n`);
	} else {
		writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(launcher, 0o755);
	}
	return launcher;
}

/** 启动器在磁盘上的文件名:Windows 是 `<name>.cmd`,其余平台就是 `<name>`。 */
export function fakeExeName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

/** 最常用的假货:把收到的参数原样打出来(`argv: a b c`),退出 0。 */
export const ECHO_ARGV_JS = `console.log("argv: " + process.argv.slice(2).join(" "));\n`;
