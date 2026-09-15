import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 假可执行文件:逻辑写成 JS,由当前 Node 跑。Windows 用系统 .NET 编译一次可直接启动的 .exe,
 * 直接传 argv、转发 stdio 与退出码,不经过 cmd.exe;POSIX 用 sh exec 包装。
 *
 * 旧 .cmd 夹具在 Node 的无 shell spawn 中报 EINVAL。修夹具,不让产品引擎为测试改走 shell。
 *
 * 脚本约定:`process.argv.slice(2)` 就是调用方传的参数;输出用 console.log / console.error;
 * 退出码用 `process.exitCode = n` 然后让脚本自然结束(stdout 一定刷完)。
 */
let windowsLauncher: Buffer | undefined;

function nativeLauncher(): Buffer {
	if (windowsLauncher) return windowsLauncher;
	const dir = mkdtempSync(join(tmpdir(), "yoma-fake-exe-"));
	try {
		const source = join(dir, "launcher.cs");
		const output = join(dir, "launcher.exe");
		writeFileSync(source, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
class Launcher {
  static string Quote(string value) {
    var text = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      text.Append(c);
      slashes = 0;
    }
    return text.Append('\\', slashes * 2).Append('"').ToString();
  }
  static int Main(string[] args) {
    var script = Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".mjs");
    var arguments = Quote(script);
    foreach (var arg in args) arguments += " " + Quote(arg);
    var start = new ProcessStartInfo(@"${process.execPath.replaceAll('"', '""')}", arguments);
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardInput = start.RedirectStandardOutput = start.RedirectStandardError = true;
    using (var child = Process.Start(start)) {
      Task.Run(() => { try {
        var input = Console.OpenStandardInput();
        var output = child.StandardInput.BaseStream;
        var buffer = new byte[8192];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
          output.Write(buffer, 0, count);
          output.Flush();
        }
        child.StandardInput.Close();
      } catch (IOException) {} });
      var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit();
      Task.WaitAll(new[] { stdout, stderr }, 1000);
      return child.ExitCode;
    }
  }
}`);
		execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
			["/nologo", "/target:exe", `/out:${output}`, source], { windowsHide: true, timeout: 30_000 });
		return windowsLauncher = readFileSync(output);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	}
}

export function writeFakeExe(dir: string, name: string, js: string): string {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, `${name}.mjs`);
	writeFileSync(script, js);
	const launcher = join(dir, fakeExeName(name));
	if (process.platform === "win32") {
		writeFileSync(launcher, nativeLauncher());
	} else {
		writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(launcher, 0o755);
	}
	return launcher;
}

/** 启动器在磁盘上的文件名:Windows 是 `<name>.exe`,其余平台就是 `<name>`。 */
export function fakeExeName(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

/** 最常用的假货:把收到的参数原样打出来(`argv: a b c`),退出 0。 */
export const ECHO_ARGV_JS = `console.log("argv: " + process.argv.slice(2).join(" "));\n`;

// Compiling the fixture is setup, not part of the operation under test. On a busy
// Windows runner csc can take longer than Vitest's default 5 s test deadline.
// Keep the compiler's own 30 s limit and reuse the resulting bytes in this worker.
if (process.platform === "win32") nativeLauncher();
