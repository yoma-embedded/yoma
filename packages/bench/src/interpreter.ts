/**
 * 判据脚本的解释器解析 —— 让同一份 job.json 在 Mac 和 Windows 上都能跑。
 *
 * ## 为什么需要它
 *
 * 判据是**两台机器共用**的任务书的一部分,而"用什么命令跑这个脚本"是**本机事实**:
 * macOS 上是 `python3`,Windows 上叫 `python` 或者只有 `py -3`;`.sh` 在 Windows 上
 * 要 git-bash 才有。把 `python3 .bench/checks/alive.py` 写进 job.json,等于把出题人
 * 那台机器的环境钉进了任务书,换台机器判据一律"命令起不来"——而那个报错长得和
 * "板子没插"一模一样(grader 会把它归成环境错误,mother 直接 park)。
 *
 * 所以 job 里只声明**脚本路径**,argv[0] 由**跑判据的那台机器**当场解析。
 *
 * ## 只查 PATH,不试着起进程
 *
 * 探测方式是扫 `PATH` 看文件在不在(Windows 上按 `PATHEXT` 补后缀),而不是
 * "spawn 一下看报不报 ENOENT" —— 后者对 `.ps1`、`cmd /c` 这类包装器会把真实的
 * 脚本执行也跑一遍,判据的副作用不能在探测阶段发生。
 */

import { accessSync, constants, existsSync, statSync } from "node:fs"
import path from "node:path"

/** 解释器候选:argv 前缀。空数组 = 直接执行脚本自身(靠 shebang 或可执行位)。 */
interface Candidate {
  argv: string[]
  /** 找不到时报给人看的名字。 */
  label: string
}

/**
 * 按扩展名给出候选,顺序即优先级。
 *
 * `.py` 在 Windows 上把 `py -3` 排在最前:官方安装器装的就是它,而 `python` 在
 * 没勾"Add to PATH"的机器上根本不在 PATH 里(还可能是微软商店那个只会弹广告的桩)。
 */
function candidatesFor(extension: string): Candidate[] {
  const win = process.platform === "win32"
  switch (extension) {
    case ".py":
      return win
        ? [{ argv: ["py", "-3"], label: "py -3" }, { argv: ["python"], label: "python" }, { argv: ["python3"], label: "python3" }]
        : [{ argv: ["python3"], label: "python3" }, { argv: ["python"], label: "python" }]
    case ".sh":
      return [{ argv: ["bash"], label: "bash" }, { argv: ["sh"], label: "sh" }]
    case ".js":
    case ".mjs":
    case ".cjs":
      return [{ argv: ["node"], label: "node" }, { argv: ["bun"], label: "bun" }]
    case ".ts":
      return [{ argv: ["bun"], label: "bun" }, { argv: ["node"], label: "node" }]
    case ".ps1":
      return win
        ? [
            { argv: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"], label: "powershell" },
            { argv: ["pwsh", "-NoProfile", "-File"], label: "pwsh" },
          ]
        : [{ argv: ["pwsh", "-NoProfile", "-File"], label: "pwsh" }]
    case ".bat":
    case ".cmd":
      return win ? [{ argv: ["cmd", "/c"], label: "cmd" }] : []
    default:
      // 没有扩展名(或不认识的):当成自带 shebang / 可执行位的程序直接跑。
      return [{ argv: [], label: "" }]
  }
}

/** PATH 上找得到这个可执行文件吗。Windows 上要按 PATHEXT 补后缀。 */
export function onPath(name: string): boolean {
  if (name.includes("/") || name.includes("\\")) return existsSync(name)
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""]
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      try {
        if (!statSync(candidate).isFile()) continue
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK)
        return true
      } catch {
        // 下一个。
      }
    }
  }
  return false
}

export type InterpreterResolution =
  | { ok: true; argv: string[] }
  | { ok: false; error: string }

/**
 * 把"脚本路径 + 参数"解析成本机能直接 spawn 的 argv。
 *
 * `scriptPath` 必须是已经解析好的绝对路径(边界检查由调用方做 —— 它才知道工作区在哪)。
 */
export function resolveScriptArgv(scriptPath: string, args: readonly string[] = []): InterpreterResolution {
  if (!existsSync(scriptPath)) {
    return { ok: false, error: `判据脚本不存在:${scriptPath}` }
  }
  const extension = path.extname(scriptPath).toLowerCase()
  const candidates = candidatesFor(extension)
  if (!candidates.length) {
    return { ok: false, error: `这台机器(${process.platform})上跑不了 ${extension} 脚本` }
  }

  for (const candidate of candidates) {
    if (candidate.argv.length === 0) {
      // 直接执行:POSIX 上要有可执行位,否则给出能照抄的修法(chmod 是最常见的漏项)。
      if (process.platform !== "win32") {
        try {
          accessSync(scriptPath, constants.X_OK)
        } catch {
          return { ok: false, error: `${scriptPath} 没有可执行位,而它没有扩展名可推断解释器 —— 补 \`chmod +x\`,或者给文件加上 .py/.sh 之类的后缀` }
        }
      }
      return { ok: true, argv: [scriptPath, ...args] }
    }
    if (onPath(candidate.argv[0]!)) {
      return { ok: true, argv: [...candidate.argv, scriptPath, ...args] }
    }
  }

  const tried = candidates.map((candidate) => candidate.label).join(" / ")
  return { ok: false, error: `这台机器上找不到能跑 ${extension} 的解释器(试过 ${tried})—— 装一个,或者把判据换成本机有的脚本类型` }
}
