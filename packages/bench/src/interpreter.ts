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

import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, statSync } from "node:fs"
import path from "node:path"

/** 解释器候选:argv 前缀。空数组 = 直接执行脚本自身(靠 shebang 或可执行位)。 */
interface Candidate {
  argv: string[]
  /** 找不到时报给人看的名字。 */
  label: string
  /**
   * 自检 argv(**不含脚本**)。给出来就在 PATH 命中之后真起一次进程,退出码 0 才算数。
   *
   * 为什么光查 PATH 不够:Windows 的"应用执行别名"会在 `%LOCALAPPDATA%\Microsoft\
   * WindowsApps` 下放一个叫 `python.exe` / `python3.exe` 的桩。它在 PATH 上、stat
   * 得到、看起来完全正常,**执行时却打印 "Python was not found; run without arguments
   * to install from the Microsoft Store" 并 exit 9009**(实测,工位机第一次真跑就是
   * 死在这儿)。这种"命中了但跑不了"只能靠真跑一次分辨。
   *
   * 代价是每种解释器一次 ~50ms 的探测,结果按 label 缓存。**只探解释器本身**
   * (`--version`),绝不带上脚本 —— 判据的副作用不能在探测阶段发生。
   * cmd / powershell 没有便宜的自检形式,留空只查 PATH。
   */
  probe?: string[]
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
        ? [
            { argv: ["py", "-3"], label: "py -3", probe: ["py", "-3", "--version"] },
            { argv: ["python"], label: "python", probe: ["python", "--version"] },
            { argv: ["python3"], label: "python3", probe: ["python3", "--version"] },
          ]
        : [
            { argv: ["python3"], label: "python3", probe: ["python3", "--version"] },
            { argv: ["python"], label: "python", probe: ["python", "--version"] },
          ]
    case ".sh":
      return [
        { argv: ["bash"], label: "bash", probe: ["bash", "--version"] },
        { argv: ["sh"], label: "sh" },
      ]
    case ".js":
    case ".mjs":
    case ".cjs":
      return [
        { argv: ["node"], label: "node", probe: ["node", "--version"] },
        { argv: ["bun"], label: "bun", probe: ["bun", "--version"] },
      ]
    case ".ts":
      return [
        { argv: ["bun"], label: "bun", probe: ["bun", "--version"] },
        { argv: ["node"], label: "node", probe: ["node", "--version"] },
      ]
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
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
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

/**
 * 解释器自检:真起一次 `<解释器> --version`,退出码 0 才算能用。
 *
 * 按 label 缓存 —— 一轮判据有好几条,没必要每条都探。缓存活在进程里,而调试台
 * 是"一轮一个子进程",所以不存在"装完 Python 还得重启"的陈旧问题。
 */
const probeCache = new Map<string, boolean>()

/** 自检超时。给得宽松些 —— 它只是"没测出来"的边界,不是判据本身的超时。 */
const PROBE_TIMEOUT_MS = 10_000

export function probeInterpreter(label: string, argv: readonly string[]): boolean {
  const cached = probeCache.get(label)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const outcome = spawnSync(argv[0]!, argv.slice(1), {
      timeout: PROBE_TIMEOUT_MS,
      stdio: "ignore",
      // shell:false 是默认值,这里写出来是提醒:探测和判据一样绝不过 shell。
      shell: false,
      windowsHide: true,
      // **env 必须显式传**:bun 不认运行时改过的 `process.env.PATH`,省略 env 时
      // 它按进程启动那一刻的环境去解析 argv[0](与 `os.homedir()` 同一类行为,
      // 实测:改了 PATH 之后不传 env 仍然解析到旧 PATH 上的那个可执行文件)。
      // 于是自检探到的会是另一个程序,结论对不上真正要跑的那个。
      env: process.env,
    })
    // **只有"跑了、而且明确失败"才算废**:非零退出 / 起不来。
    // 超时的含义是"没测出来",不是"它是桩" —— 那个桩是**秒退** exit 9009 的。
    // 把超时也算成废,机器一忙就会把一个好好的解释器拒掉,整轮判据变成环境错误、
    // 闭环被 park。宁可放过去:解释器真有病的话,判据自己会在它的超时里失败,
    // 结论一样是环境错误,只是慢一点(实测:开发机满载时这里假阳性过)。
    if (outcome.error && (outcome.error as NodeJS.ErrnoException).code === "ETIMEDOUT") ok = true
    else ok = !outcome.error && outcome.status === 0
  } catch {
    // 探测这一步自己出岔子同样不构成"解释器是废的"证据。
    ok = true
  }
  probeCache.set(label, ok)
  return ok
}

/** 测试用:清掉自检缓存。 */
export function resetInterpreterProbeCache(): void {
  probeCache.clear()
}

export type InterpreterResolution = { ok: true; argv: string[] } | { ok: false; error: string }

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
  const brokenOnPath: string[] = []

  for (const candidate of candidates) {
    if (candidate.argv.length === 0) {
      // 直接执行:POSIX 上要有可执行位,否则给出能照抄的修法(chmod 是最常见的漏项)。
      if (process.platform !== "win32") {
        try {
          accessSync(scriptPath, constants.X_OK)
        } catch {
          return {
            ok: false,
            error: `${scriptPath} 没有可执行位,而它没有扩展名可推断解释器 —— 补 \`chmod +x\`,或者给文件加上 .py/.sh 之类的后缀`,
          }
        }
      }
      return { ok: true, argv: [scriptPath, ...args] }
    }
    if (!onPath(candidate.argv[0]!)) continue
    if (candidate.probe && !probeInterpreter(candidate.label, candidate.probe)) {
      // PATH 上有,但真跑起来是废的 —— 记下来,好让最终的报错指向真因。
      brokenOnPath.push(candidate.label)
      continue
    }
    return { ok: true, argv: [...candidate.argv, scriptPath, ...args] }
  }

  const tried = candidates.map((candidate) => candidate.label).join(" / ")
  // "PATH 上根本没有"和"PATH 上有但跑不起来"要分开说:后者在 Windows 上几乎总是
  // 应用执行别名那个桩,而"装一个 Python"是对它无效的建议 —— 人已经"装过"了,
  // 真正要做的是装真的解释器或者关掉别名(设置 → 应用 → 高级应用设置 → 应用执行别名)。
  if (brokenOnPath.length) {
    return {
      ok: false,
      error:
        `${brokenOnPath.join(" / ")} 在 PATH 上找得到,但执行 --version 不成功 —— ` +
        `Windows 上这几乎总是"应用执行别名"的桩(跑起来只会让你去微软商店,exit 9009)。` +
        `装一个真的解释器,或者到 设置 → 应用 → 高级应用设置 → 应用执行别名 里把它关掉。` +
        `(试过:${tried})`,
    }
  }
  return {
    ok: false,
    error: `这台机器上找不到能跑 ${extension} 的解释器(试过 ${tried})—— 装一个,或者把判据换成本机有的脚本类型`,
  }
}
