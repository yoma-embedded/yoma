/**
 * 付费授权闭环的**真进程**端到端:签发 → 导入 → 执行 → 到期阻止新任务 → 续费恢复。
 *
 *   npm run e2e:license -w packages/desktop
 *   npm run e2e:license -w packages/desktop -- --out <desktop 目录> --key <私钥.pem> --key-id <编号>
 *
 * 单测那一层(`licensing.test.ts` / `license.test.ts` / `license-build.test.ts`)已经用**注入时钟**
 * 覆盖过规则本身。这条脚本补的是另一半:真 utilityProcess + 真 MessagePort 帧、真 preload +
 * contextBridge、真守护进程 + 真 turn 子进程,授权用**真的短有效期**(不注入时钟)。
 *
 * ## 两种模式
 *
 * - **自带模式(缺省)**:现场 `generateSigningKey`,`resolveLicenseBuild({…}, { allowTestKeys: true })`
 *   → `licenseDefine` → `buildKernelEntryBundle` + `buildMailboxBundles` 打到临时目录。
 *   renderer 那条腿要一个完整的 desktop 目录布局,所以在临时目录里拼一个
 *   `<tmp>/desktop/out/{main,preload}`:main/kernel.js 是现打的那份,preload 从仓内 `out/` 拷
 *   (它与授权策略无关)。**不碰仓内 out/**。
 * - **对现成商业构建**:`--out <desktop 目录> --key <私钥.pem> --key-id <编号>` —— 不打包,
 *   直接测那个目录里的 `out/main/{kernel.js,mailbox-host.mjs,mailbox-turn-entry.mjs}`,
 *   授权用给定私钥签。这是"验的就是用户会装的那份"。
 *
 * ## 隔离(这条脚本一个字都不许碰开发机真实的 ~/.yoma)
 *
 * 内核那两条腿把**内核子进程**的 HOME / USERPROFILE 指到临时目录(内核的 configDir 默认 `~/.yoma`);
 * 调试台那条腿的 configDir 是守护配置里的字段,直接指临时目录。跑完把整棵临时树删掉。
 * 脚本开跑与收尾各查一次真实 `~/.yoma/license.json` 的存在性与 mtime,不一致就报失败。
 */

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

import { buildKernelEntryBundle, buildMailboxBundles } from "./build-mailbox.ts"
import { resolveElectron } from "./electron-bin.ts"
import { describeLicenseBuild, licenseDefine, resolveLicenseBuild } from "./license-build.ts"
import { PLAN_ENV, makeIssuer, randomSuffix, type LicensePlan } from "./e2e-license-shared.ts"
import { leg3 } from "./e2e-license-mailbox.ts"
import { generateSigningKey } from "../../../scripts/license/lib.ts"

const here = dirname(fileURLToPath(import.meta.url))
const desktopRepoDir = join(here, "..")
const repoRoot = join(desktopRepoDir, "..", "..")

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

interface Args {
  out?: string
  key?: string
  keyId?: string
  legs: number[]
  keep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { legs: [1, 2, 3], keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${flag} 后面缺一个值`)
      return value
    }
    if (flag === "--out") args.out = next()
    else if (flag === "--key") args.key = next()
    else if (flag === "--key-id") args.keyId = next()
    else if (flag === "--only") args.legs = next().split(",").map((n) => Number.parseInt(n.trim(), 10))
    else if (flag === "--keep") args.keep = true
    else throw new Error(`不认识的参数 ${flag}`)
  }
  if (args.out !== undefined && (args.key === undefined || args.keyId === undefined)) {
    throw new Error("--out 模式必须同时给 --key(签发私钥 PEM)与 --key-id(那个构建信任的公钥编号)")
  }
  if (args.out === undefined && (args.key !== undefined || args.keyId !== undefined)) {
    throw new Error("--key / --key-id 只在 --out 模式下有意义:自带模式的密钥是现场生成的")
  }
  return args
}

/**
 * 路径按 cwd 解析;解析不到就再试仓库根。
 *
 * `npm run e2e:license -w packages/desktop -- --out packages/desktop` 的 cwd 是 packages/desktop,
 * 而人写的那个路径是相对仓库根的 —— 两种都认,并把实际用的那个印出来。
 */
function resolveGivenPath(given: string, what: string): string {
  const candidates = isAbsolute(given) ? [given] : [resolve(process.cwd(), given), resolve(repoRoot, given)]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(`${what} ${JSON.stringify(given)} 找不到(试过:${candidates.join(" / ")})`)
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))

// --- 真实 ~/.yoma/license.json 的"它没被碰过"证明(前) -----------------------
const realLicense = join(homedir(), ".yoma", "license.json")
function snapshotRealLicense(): string {
  if (!existsSync(realLicense)) return "不存在"
  const stat = statSync(realLicense)
  return `存在 ${stat.size} 字节 mtime=${stat.mtime.toISOString()}`
}
const realBefore = snapshotRealLicense()
console.log(`开跑前的真实 ${realLicense}:${realBefore}`)

const tmpRoot = mkdtempSync(join(tmpdir(), "yoma-e2e-license-"))
let failed = 0

try {
  // -------------------------------------------------------------------------
  // 定下被测目录与签发密钥
  // -------------------------------------------------------------------------
  let desktopDir: string
  let keyPemFile: string
  let keyId: string

  if (args.out !== undefined) {
    desktopDir = resolveGivenPath(args.out, "--out")
    keyPemFile = resolveGivenPath(args.key!, "--key")
    keyId = args.keyId!
    console.log(`\n模式:对现成商业构建\n  被测目录 ${desktopDir}\n  签发私钥 ${keyPemFile}\n  公钥编号 ${keyId}`)
    for (const rel of [["out", "main", "kernel.js"], ["out", "main", "mailbox-host.mjs"], ["out", "main", "mailbox-turn-entry.mjs"], ["out", "preload", "index.js"]]) {
      const file = join(desktopDir, ...rel)
      if (!existsSync(file)) throw new Error(`被测目录里没有 ${file} —— 先 npm run build -w packages/desktop`)
    }
  } else {
    // 自带模式:现场一把一次性密钥 → 编译期注入 → 往临时目录打商业产物。
    keyId = `e2e-license-${randomSuffix()}`
    const generated = generateSigningKey(keyId)
    const keyDir = join(tmpRoot, "key")
    mkdirSync(keyDir, { recursive: true })
    keyPemFile = join(keyDir, `${keyId}.private.pem`)
    writeFileSync(keyPemFile, generated.privateKeyPem, { mode: 0o600 })
    console.log(`\n模式:自带(现场生成一次性密钥)\n  公钥编号 ${keyId}\n  指纹 ${generated.fingerprint}`)

    // `allowTestKeys` 只是这里的一个函数参数 —— 没有任何环境变量能打开它,
    // 正式打包管线走的是 resolveLicenseBuild(process.env)。
    const build = resolveLicenseBuild(
      { YOMA_EDITION: "commercial", YOMA_LICENSE_TRUST_JSON: JSON.stringify({ trustedKeys: [generated.trusted] }) },
      { allowTestKeys: true },
    )
    console.log(`  ${describeLicenseBuild(build).split("\n").join("\n  ")}`)

    desktopDir = join(tmpRoot, "desktop")
    const outMain = join(desktopDir, "out", "main")
    mkdirSync(outMain, { recursive: true })
    const define = licenseDefine(build)
    console.log("  打临时商业产物(与正式包同一套 esbuild 选项)……")
    const kernelJs = await buildKernelEntryBundle({ outDir: outMain, define, logLevel: "warning" })
    const bundles = await buildMailboxBundles({ outDir: outMain, define, logLevel: "warning" })
    for (const file of [kernelJs, ...bundles]) console.log(`    ${file}(${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)`)

    // preload 与授权策略无关(它只是一座桥),但 renderer 那条腿必须用**真的那一份**。
    const repoPreload = join(desktopRepoDir, "out", "preload")
    if (!existsSync(join(repoPreload, "index.js"))) {
      throw new Error(`没有 ${join(repoPreload, "index.js")} —— renderer 那条腿要真 preload,先跑 npm run build -w packages/desktop`)
    }
    cpSync(repoPreload, join(desktopDir, "out", "preload"), { recursive: true })
    console.log(`    preload 从仓内 out/ 拷了一份(与授权策略无关)`)
  }

  const issuer = makeIssuer(keyPemFile, keyId)
  const enginesDir = existsSync(join(repoRoot, "engines")) ? join(repoRoot, "engines") : undefined
  const plan: LicensePlan = { desktopDir, keyPemFile, keyId, tmpRoot, enginesDir, legs: args.legs }
  const planFile = join(tmpRoot, "plan.json")
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`)

  const electron = resolveElectron(desktopRepoDir)

  // -------------------------------------------------------------------------
  // 腿 1 + 腿 2:一个 Electron 实例(两条都要 app.whenReady)
  // -------------------------------------------------------------------------
  if (args.legs.includes(1) || args.legs.includes(2)) {
    const entry = join(tmpRoot, "e2e-license-electron.mjs")
    await esbuild.build({
      entryPoints: [join(here, "e2e-license-electron.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron"],
      outfile: entry,
      logLevel: "warning",
    })
    const result = spawnSync(electron, [entry], {
      cwd: desktopRepoDir,
      env: { ...process.env, [PLAN_ENV]: planFile },
      stdio: "inherit",
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      failed += 1
      console.error(`\n腿 1 / 腿 2 的 Electron 进程退出码 ${result.status}`)
    }
  }

  // -------------------------------------------------------------------------
  // 腿 3:真守护进程(Electron RUN_AS_NODE)+ 真 turn 子进程
  // -------------------------------------------------------------------------
  if (args.legs.includes(3)) {
    const leg = await leg3(plan, issuer, electron)
    console.log("")
    console.log(`  ${leg.summary()}`)
    if (leg.failed > 0) failed += 1
  }
} catch (error) {
  failed += 1
  console.error(`\n✗ ${(error as Error).stack ?? String(error)}`)
} finally {
  // --- 真实 ~/.yoma/license.json 的"它没被碰过"证明(后) ---------------------
  const realAfter = snapshotRealLicense()
  console.log(`\n收尾后的真实 ${realLicense}:${realAfter}`)
  if (realAfter !== realBefore) {
    failed += 1
    console.error(`✗ 真实 ~/.yoma/license.json 变了!前:${realBefore};后:${realAfter}`)
  } else {
    console.log(`✓ 真实 ~/.yoma/license.json 前后一致(${realBefore})—— 整条 e2e 只碰临时目录`)
  }

  if (args.keep) console.log(`--keep:现场留在 ${tmpRoot}`)
  else rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

console.log(failed === 0 ? "\n授权闭环真进程 e2e:通过。\n" : `\n授权闭环真进程 e2e:${failed} 条腿失败。\n`)
process.exit(failed === 0 ? 0 : 1)
