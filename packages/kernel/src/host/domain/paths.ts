/**
 * 工具的路径解析。
 *
 * 只有两个函数,但 fromMsysPath 是 Windows 上唯一一道防线:模型在 bash 工具里看到的 pwd 是
 * Git Bash(MSYS)形状的 "/d/proj",它会原样把那个串喂给 flash / read 等别的工具,而 Node 的
 * path.resolve 会把它当成当前盘的根目录子路径,于是解析出 "D:\d\proj" 然后 ENOENT —— 错误文本
 * 里看不出是路径翻译问题,只看得到"文件不存在"。
 *
 * 与 attic 版的差异:那版是 async、走注入的 FileSystem(env.absolutePath,为了远程/沙箱文件系统
 * 也成立)。这里改成纯同步:host/tools 下的硬件工具本来就只在本机起子进程(探针插在这台机器上),
 * 多一层 Result + await 换不来任何可移植性。
 */

import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 按 process.platform 取实现,而不是宿主的 path:测试才能在 macOS 上真跑 Windows 分支。 */
function platformPath(): path.PlatformPath {
  return process.platform === "win32" ? path.win32 : path.posix
}

/**
 * Git Bash(MSYS)风格的盘符路径,Windows 上翻译成真实盘符:"/d/foo" → "D:/foo"。
 * 非 win32 上原样返回 —— POSIX 的 "/d/foo" 就是一个正经绝对路径,翻译它才是错的。
 */
export function fromMsysPath(filePath: string): string {
  if (process.platform !== "win32") return filePath
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(filePath)
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : filePath
}

/**
 * gitignore 味的 glob:不含 `/` 的 pattern 只看文件名(任意深度都算),含 `/` 的锚在搜索根,`**` 跨目录。
 *
 * 为什么不把 glob 交给 rg 的 --glob:那是 override 层,压在 .gitignore 之上 —— 2026-09-12 实测
 * `rg --files --glob '*'` 会把 node_modules/ 与 *.log 整个放回来。所以 rg 只负责"尊重 .gitignore 地
 * 列文件",挑哪些留下在这里做。坏 pattern(没闭合的 `[`)不抛,当作匹不到。
 *
 * **全平台都不分大小写**:Node 的 matchesGlob 在 mac / Windows 上不分、Linux 上分,同一条 pattern 两个
 * CI 岗给不同结果;而模型手里的文件名本来就大小写混杂(Keil 工程的 Main.C、Core/Src)。两边都小写后比。
 */
export function matchesToolGlob(relativePosixPath: string, pattern: string): boolean {
  const cleaned = (pattern.startsWith("./") ? pattern.slice(2) : pattern).toLowerCase()
  const target = relativePosixPath.toLowerCase()
  if (!cleaned.includes("/")) return path.posix.matchesGlob(path.posix.basename(target), cleaned)
  return path.posix.matchesGlob(target, cleaned)
}

/**
 * 目录在不在 git 仓库里(向上找 .git)。rg 跟 fd 一样:仓库外默认**不**读 .gitignore,要 --no-require-git
 * 才读;仓库内用默认行为,父级 .gitignore 会停在嵌套子仓库的边界上。grep 与 find 共用这一条判断 ——
 * 2026-09-12 审稿抓到 grep 漏了它,于是解压的 SDK 目录里 node_modules 把 limit 吃满。
 */
export function insideGitRepo(start: string): boolean {
  let current = start
  while (true) {
    if (existsSync(path.join(current, ".git"))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * 解析成绝对路径,不要求存在。相对路径一律对着会话的 cwd 解,不是进程的 cwd。
 * 与 read / edit / write(内核的 resolveToolPath)吃同样的写法:"~"、"~/x"、"file://…";绝对路径也
 * 过一遍 resolve 把 ".." 收掉 —— flash-state.json 里记的是这个串,gdb 将来拿它做字符串比对。
 */
export function resolveToCwd(cwd: string, filePath: string): string {
  const p = platformPath()
  let translated = fromMsysPath(filePath)
  if (filePath.startsWith("file://")) {
    // 畸形的 file URL(带主机名、坏转义)当普通路径:抛裸的 TypeError 只会让模型看到一条看不懂的错,
    // 当路径走下去则落成确定的 "elfPath not found: …"。内核的 resolveToolPath 同一处理。
    try {
      translated = fileURLToPath(filePath)
    } catch {
      translated = filePath
    }
  }
  if (translated === "~" || translated.startsWith("~/") || (process.platform === "win32" && translated.startsWith("~\\"))) {
    translated = p.join(os.homedir(), translated.slice(1))
  }
  return p.isAbsolute(translated) ? p.resolve(translated) : p.resolve(cwd, translated)
}
