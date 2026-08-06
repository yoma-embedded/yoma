#!/usr/bin/env bun
/**
 * 打包前的 engines 校验 + 实体化 —— 把三种"静默出坏包"的方式变成响亮的失败/警告。
 *
 * 背景:仓库根的 `engines` 是指向 ../my-pi/engines 的软链,bin/ 和 data/ 里又全是
 * 指向各引擎构建产物的软链。三个坑:
 *
 *   1. **没在 my-pi 跑过 `bun engines/build.ts`** → 软链悬空 → 这里直接失败。
 *   2. **electron-builder 对 extraResources 里的软链是原样保留,不 dereference**
 *      (实测:打出来的 Yoma.app 里 engines/bin/board_ir 还是一条指向
 *      ../controller_map/.venv/bin/board_ir 的断链,签名阶段 stat ENOENT)。
 *      → 所以这里把 engines **实体化**拷进 `.engines-stage/`(跟随软链、保留权限位),
 *      electron-builder 的 extraResources 指向暂存目录而不是原始软链。
 *   3. **venv console script**(shebang 指向构建机绝对路径)→ 拷到别人电脑上
 *      "bad interpreter" 必坏。根治要 my-pi 侧把 Python 引擎做成自包含产物,
 *      我们不改内核 → 响亮警告并列出受影响的工具。
 */

import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const localEnginesDir = path.resolve(desktopDir, "..", "..", "engines")
const stageDir = path.join(desktopDir, ".engines-stage")
const cacheDir = path.join(desktopDir, ".engines-cache")

/**
 * 打包目标平台,由 package.json 的脚本传入(package:win → win32),缺省当前平台。
 * 引擎是原生二进制,mac 的 Mach-O 装进 Windows 安装包一样"打包成功",用户点开才炸 ——
 * 所以按魔数校验格式匹配。my-pi 的内核在 win32 上按 `${name}.exe` 找引擎
 * (coding-agent/core/tools/engines.ts),所以 Windows 产物还必须带 .exe 后缀。
 *
 * YOMA_ALLOW_FOREIGN_ENGINES=1 是显式逃生口:只在"引擎还没有对应平台产物,
 * 但想先验证安装器机械流程"时用,产出的包引擎全坏,**不能分发**。
 */
const TARGET = process.argv[2] ?? process.platform
const ALLOW_FOREIGN = process.env.YOMA_ALLOW_FOREIGN_ENGINES === "1"
const EXPECTED: Record<string, { format: BinFormat; label: string }> = {
  darwin: { format: "macho", label: "Mach-O" },
  win32: { format: "pe", label: "PE(.exe)" },
  linux: { format: "elf", label: "ELF" },
}
const expected = EXPECTED[TARGET]
if (!expected) {
  console.error(`[stage-engines] 未知目标平台 ${TARGET}(认识 darwin/win32/linux)`)
  process.exit(1)
}

type BinFormat = "macho" | "pe" | "elf" | "script" | "other"

function detectFormat(head: Buffer): BinFormat {
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return "script" // #!
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return "pe" // MZ
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "elf"
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0)
    // MH_MAGIC_64 两种字节序 + universal binary
    if (magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcafebabe) return "macho"
  }
  return "other"
}

/**
 * 失败并给出**对得上症状**的下一步。
 *
 * hint 可覆盖:默认那句"去 my-pi 跑 build.ts"只适用于"本地产物缺失/悬空",
 * 拿它去回答"校验和不符"会把人引向完全错误的方向(实测自己就差点被自己误导)。
 */
function fail(message: string, hint = "先在 my-pi 仓库跑 `bun engines/build.ts`(为目标平台),再回来打包。"): never {
  console.error(`\n[stage-engines] ${message}`)
  console.error(`[stage-engines] ${hint}\n`)
  process.exit(1)
}

// ---- 引擎从哪来 --------------------------------------------------------
//
// 三条路,按优先级:
//   1. YOMA_ENGINES_DIR —— 显式指定目录,一切照它;
//   2. YOMA_ENGINES_BUNDLE —— 显式指定一个 bundle 压缩包(离线打包 / 验证用);
//   3. 本地 ../../engines(开发机的软链)—— **仅当它满足目标平台**;
//   4. 预编译产物 —— 按 engines.lock.json 钉住的 tag 从 my-pi 的 Release 下载。
//
// 第 4 条是"在 Mac 上打 Windows 包"能成立的关键:本地那份永远是 Mach-O,
// 以前只能靠 YOMA_ALLOW_FOREIGN_ENGINES=1 打出一个引擎全坏的包。
//
// 私有仓的 Release 资产要鉴权,但**下载发生在打包期**(开发机或 CI,手上有凭据),
// 终端用户拿到的是安装包里已经躺好的文件,不需要任何令牌。

const TARGET_ARCH = process.argv[3] ?? (TARGET === "win32" ? "x64" : process.arch)

function bundleName(target: string, arch: string): string {
  const key = `${target}-${arch}`
  return target === "win32" ? `engines-${key}.zip` : `engines-${key}.tar.gz`
}

function run(cmd: string[], cwd?: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
  return { ok: proc.exitCode === 0, out: `${proc.stdout.toString()}${proc.stderr.toString()}` }
}

function extract(archive: string, into: string): void {
  mkdirSync(into, { recursive: true })
  // .tar.gz 用 tar;.zip 优先 unzip,退回 bsdtar(macOS/Win11 的 tar 能读 zip,GNU tar 不能)。
  const attempts = archive.endsWith(".zip")
    ? [["unzip", "-q", archive, "-d", into], ["tar", "-xf", archive, "-C", into]]
    : [["tar", "-xzf", archive, "-C", into]]
  for (const cmd of attempts) {
    const result = run(cmd)
    if (result.ok) return
    if (cmd === attempts[attempts.length - 1]) fail(`解压 ${path.basename(archive)} 失败:\n${result.out}`)
  }
}

/** 校验 bundle 自带的 manifest —— 挡住下载被截断/被改这类"文件在但内容不对"。 */
function verifyManifest(root: string): void {
  const manifestFile = path.join(root, "manifest.json")
  if (!existsSync(manifestFile)) {
    console.warn("[stage-engines] ⚠ 预编译产物里没有 manifest.json,跳过完整性校验")
    return
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    bin?: Record<string, { sha256?: string }>
  }
  for (const [name, info] of Object.entries(manifest.bin ?? {})) {
    const file = path.join(root, "bin", name)
    if (!existsSync(file)) {
      fail(`预编译产物缺 bin/${name}(manifest 里列了它)`, `这份 Release 产物不完整,重新构建对应 tag。`)
    }
    if (!info.sha256) continue
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex")
    if (actual !== info.sha256) {
      fail(
        `bin/${name} 校验和与 manifest 不符`,
        `产物在传输中被截断或被改动过。删掉 packages/desktop/.engines-cache 重新取一次;` +
          `还不行就是那次 Release 的产物本身有问题,重新构建 tag。`,
      )
    }
  }
}

/** 本地 engines 是否满足目标平台。不满足就该去取预编译产物,而不是打一个坏包。 */
function localSatisfiesTarget(): boolean {
  const binDir = path.join(localEnginesDir, "bin")
  if (!existsSync(binDir)) return false
  let native = 0
  for (const name of readdirSync(binDir).filter((n) => !n.startsWith("."))) {
    try {
      const head = readFileSync(path.join(binDir, name))
      if (detectFormat(head) !== expected.format) continue
      if (TARGET === "win32" && !name.toLowerCase().endsWith(".exe")) continue
      native += 1
    } catch {
      return false // 悬空软链等
    }
  }
  return native > 0
}

function resolveEnginesDir(): string {
  if (process.env.YOMA_ENGINES_DIR) return path.resolve(process.env.YOMA_ENGINES_DIR)
  // 显式指了 bundle 就用 bundle:人明确说了要哪一份,本地那份不该抢在前面
  // (第一版让本地优先,结果拿本地产物"验证"了预编译路径,等于什么都没验)。
  if (!process.env.YOMA_ENGINES_BUNDLE && localSatisfiesTarget()) return localEnginesDir

  const lock = JSON.parse(readFileSync(path.join(desktopDir, "engines.lock.json"), "utf8")) as {
    repo: string
    tag: string
  }
  const tag = process.env.YOMA_ENGINES_RELEASE ?? lock.tag
  const asset = bundleName(TARGET, TARGET_ARCH)
  const into = path.join(cacheDir, tag, `${TARGET}-${TARGET_ARCH}`)

  if (existsSync(path.join(into, "bin"))) {
    console.log(`[stage-engines] 用缓存的预编译引擎:${into}`)
    verifyManifest(into)
    return into
  }

  // 本地 bundle 逃生口 —— 也是这条路径的测试接缝(不联网就能验解压/校验/实体化全链)。
  const local = process.env.YOMA_ENGINES_BUNDLE
  console.log(
    local
      ? `[stage-engines] 用显式指定的 bundle:${local}`
      : `[stage-engines] 本地 engines 不满足 ${TARGET}/${TARGET_ARCH},取预编译产物 ${lock.repo}@${tag}`,
  )
  const archive = local ? path.resolve(local) : path.join(cacheDir, tag, asset)
  if (local) {
    if (!existsSync(archive)) fail(`YOMA_ENGINES_BUNDLE 指向的文件不存在:${archive}`)
  } else {
    mkdirSync(path.dirname(archive), { recursive: true })
    // gh 带着登录态,私有仓也能下;没有 gh 就明确告诉人装它,别在这儿造第二套鉴权。
    if (!Bun.which("gh")) {
      fail(
        `需要下载预编译引擎,但没装 gh CLI。\n` +
          `[stage-engines] 装 gh 并 \`gh auth login\`(私有仓 Release 要鉴权),\n` +
          `[stage-engines] 或者自己下 ${asset} 后用 YOMA_ENGINES_BUNDLE=<路径> 指过来。`,
      )
    }
    const result = run([
      "gh", "release", "download", tag,
      "--repo", lock.repo,
      "--pattern", asset,
      "--dir", path.dirname(archive),
      "--clobber",
    ])
    if (!result.ok) {
      fail(
        `下载 ${asset} 失败(${lock.repo}@${tag}):\n${result.out}\n` +
          `[stage-engines] 常见原因:tag 还没发布、当前账号对私有仓没权限、该平台的产物没构建。`,
      )
    }
  }

  extract(archive, into)
  if (!existsSync(path.join(into, "bin"))) fail(`预编译产物解压后没有 bin/:${into}`)
  verifyManifest(into)
  return into
}

const enginesDir = resolveEnginesDir()
if (!existsSync(enginesDir)) fail(`找不到 engines 目录:${enginesDir}`)

// ---- 校验 --------------------------------------------------------------

const nonPortable: string[] = []
const foreign: string[] = []
let nativeCount = 0
for (const sub of ["bin", "data"] as const) {
  const dir = path.join(enginesDir, sub)
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => !name.startsWith("."))
  } catch {
    fail(`engines/${sub} 不存在`)
  }
  if (entries.length === 0) fail(`engines/${sub} 是空的 —— 打出去的包会在用户第一次用硬件工具时才炸`)

  for (const name of entries) {
    const target = path.join(dir, name)
    // statSync 跟随软链:悬空软链在这里抛,正好变成响亮失败。
    let stat
    try {
      stat = statSync(target)
    } catch {
      fail(`engines/${sub}/${name} 是悬空软链(构建产物不在)`)
    }
    if (sub !== "bin" || !stat.isFile()) continue
    const head = readFileSync(target)
    const format = detectFormat(head)
    if (format === "script") {
      const shebang = head.subarray(0, Math.min(head.length, 200)).toString("utf8").split("\n")[0]!
      // 解释器脚本在 win32 上根本没有 shebang 语义,算格式不匹配;darwin/linux 上算"出机必坏"警告。
      if (TARGET === "win32") foreign.push(`${name}(解释器脚本)`)
      else nonPortable.push(`${name} → ${shebang}`)
    } else if (format === expected.format) {
      nativeCount += 1
      // 内核在 win32 上按 `${name}.exe` 拼可执行名,不带后缀的 PE 等于不存在。
      if (TARGET === "win32" && !name.toLowerCase().endsWith(".exe")) foreign.push(`${name}(PE 但缺 .exe 后缀)`)
    } else {
      foreign.push(`${name}(${format},目标要 ${expected.label})`)
    }
  }
}

if (foreign.length > 0 || nativeCount === 0) {
  const lines = [
    `目标平台 ${TARGET} 需要 ${expected.label} 引擎,当前 engines/bin 不满足:`,
    ...foreign.map((line) => `  ${line}`),
    ...(nativeCount === 0 ? [`  (没有任何 ${expected.label} 二进制)`] : []),
    `需要 my-pi 侧为 ${TARGET} 构建 engines(win32 命名要带 .exe,内核按 \`\${name}.exe\` 找),`,
    `把仓库根的 engines 指到那份产物再打包。`,
  ]
  if (ALLOW_FOREIGN) {
    console.warn("\n[stage-engines] ⚠⚠ YOMA_ALLOW_FOREIGN_ENGINES=1:忽略平台不匹配继续打包。")
    for (const line of lines) console.warn(`[stage-engines] ⚠⚠ ${line}`)
    console.warn("[stage-engines] ⚠⚠ 这个包的硬件引擎**全部是坏的**,只能用来验证安装器流程,不能分发。\n")
  } else {
    fail(lines.join("\n[stage-engines] "))
  }
}

if (nonPortable.length > 0) {
  console.warn("\n[stage-engines] ⚠ 以下引擎是解释器脚本,shebang 指向本机绝对路径,")
  console.warn("[stage-engines] ⚠ 打进安装包后在**别人的电脑上必坏**(bad interpreter):")
  for (const line of nonPortable) console.warn(`[stage-engines] ⚠   ${line}`)
  console.warn("[stage-engines] ⚠ 根治需要 my-pi 的 engines/build.ts 产出自包含可执行文件。")
  console.warn("[stage-engines] ⚠ 本次继续打包:除这几个工具外其余功能不受影响。\n")
}

// ---- 实体化 ------------------------------------------------------------

rmSync(stageDir, { recursive: true, force: true })
for (const sub of ["bin", "data"] as const) {
  // dereference: 把所有软链(含 data 深处的)替换成真实内容;权限位默认保留,
  // 二进制的可执行位跟着过来。内部若有悬空软链,cpSync 抛错 = 响亮失败。
  cpSync(path.join(enginesDir, sub), path.join(stageDir, sub), { recursive: true, dereference: true })
}

// data 里的文件全部剥掉可执行位。它们是芯片数据库/固件包/文档,不是 mac 可执行文件,
// 但源树里不少带着 755 —— electron-builder 的签名器按可执行位收集"待签二进制",
// 会把几万个数据文件一个一个 codesign(实测签到 CMSIS 文档的 PNG 上,一次打包要跑几小时)。
// 配置里同时给签名器加了 signIgnore,这里是双保险 + 权限卫生。
function stripExecBits(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      stripExecBits(target)
    } else {
      const mode = statSync(target).mode
      if ((mode & 0o111) !== 0) chmodSync(target, mode & ~0o111)
    }
  }
}
stripExecBits(path.join(stageDir, "data"))

// 拷完再验一遍产物:bin 里必须是可执行的真实文件,没有任何残留软链。
const staged = readdirSync(path.join(stageDir, "bin")).filter((name) => !name.startsWith("."))
for (const name of staged) {
  const file = path.join(stageDir, "bin", name)
  const stat = statSync(file)
  if (!stat.isFile()) fail(`.engines-stage/bin/${name} 不是普通文件`)
  // 可执行位断言只在 POSIX 构建机上有意义:NTFS 没有执行位,Node 在 win32 对普通
  // 文件恒返回 100666,chmod 也改不动(Windows 打包机上实测)—— 不守卫的话这条
  // 断言在 Windows 上永远失败,还把人误导去重跑引擎构建。
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0)
    fail(`.engines-stage/bin/${name} 丢了可执行位`)
}

console.log(`[stage-engines] 通过:${staged.length} 个引擎(${staged.join(", ")})已实体化到 .engines-stage/`)
