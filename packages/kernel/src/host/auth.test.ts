/**
 * 凭据写入端 + CONFIGURABLE_PROVIDERS 副本的防漂移闸。
 *
 * **本进程里绝不碰真实的 ~/.pi**。Bun 的 os.homedir() 在进程启动时定死,运行时改
 * process.env.HOME 无效(实测,踩过:早先版本以为换了 HOME,实际把开发机上真实的
 * auth.json 洗掉了)。所以这里的分工是:
 *
 *   - 文件语义:全部走 auth.ts 的 dir 注入参数,指向 mkdtemp 目录;
 *   - 防漂移:用 MY_PI_PROVIDER 环境变量(resolveModel 每次调用都读它)逼出
 *     "Known providers: ..." 报错,纯只读,不碰任何文件;
 *   - 全链路(setAuth → resolveModel 真的读到):子进程,出生时 HOME 就是临时目录,
 *     而且 fixture 开头自检 homedir(),隔离失效直接退出码 2,一个字节不写。
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveModel } from "@yoma/my-pi-coding-agent/models"

import { CONFIGURABLE_PROVIDERS, readAuthFile, removeAuthKey, writeAuthKey } from "./auth.ts"
import { SessionManager } from "./session-manager.ts"

const hostDir = path.dirname(fileURLToPath(import.meta.url))

describe("CONFIGURABLE_PROVIDERS 与 my-pi 的 PROVIDERS 表一致", () => {
  test("用 MY_PI_PROVIDER 逼出的 Known providers 集合和副本相等", async () => {
    // PROVIDERS 表没有导出,唯一能拿到完整键集合的地方是这条报错:指定一个不存在的
    // provider,resolveModel 在碰任何凭据逻辑之前就抛 Unknown provider + 完整名单。
    // 措辞变了这里会响,照着新措辞修 —— 重点是别让名单默默漂移。
    const savedProvider = process.env.MY_PI_PROVIDER
    process.env.MY_PI_PROVIDER = "__yoma_drift_probe__"
    let message = ""
    try {
      await resolveModel()
    } catch (error) {
      message = (error as Error).message
    } finally {
      if (savedProvider === undefined) delete process.env.MY_PI_PROVIDER
      else process.env.MY_PI_PROVIDER = savedProvider
    }
    const match = message.match(/Known providers: (.+)$/)
    expect([message, Boolean(match)]).toEqual([message, true])
    const known = match![1]!
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .sort()
    expect(CONFIGURABLE_PROVIDERS.map((spec) => spec.id).sort()).toEqual(known)
  })
})

describe("auth.json 写入端(dir 注入,不碰真实 HOME)", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "yoma-auth-"))

  test("writeAuthKey 新建目录和文件,权限收紧到 0600", () => {
    const base = dir()
    writeAuthKey("deepseek", "sk-test-1", base)
    const file = path.join(base, "auth.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ deepseek: { key: "sk-test-1" } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    rmSync(base, { recursive: true, force: true })
  })

  test("覆盖 key 保留同条目里别的字段(pi 写的 type),removeAuthKey 只动目标条目", () => {
    const base = dir()
    writeFileSync(
      path.join(base, "auth.json"),
      JSON.stringify({ deepseek: { type: "api_key", key: "old" }, "moonshotai-cn": { key: "kimi" } }),
    )

    writeAuthKey("deepseek", "sk-new", base)
    expect(readAuthFile(base)).toEqual({ deepseek: { type: "api_key", key: "sk-new" }, "moonshotai-cn": { key: "kimi" } })

    removeAuthKey("deepseek", base)
    expect(readAuthFile(base)).toEqual({ deepseek: { type: "api_key" }, "moonshotai-cn": { key: "kimi" } })

    removeAuthKey("moonshotai-cn", base)
    expect(readAuthFile(base)).toEqual({ deepseek: { type: "api_key" } })
    rmSync(base, { recursive: true, force: true })
  })

  test("损坏的 auth.json 当空表处理,写入后自愈", () => {
    const base = dir()
    writeFileSync(path.join(base, "auth.json"), "{ not json")
    expect(readAuthFile(base)).toEqual({})
    writeAuthKey("deepseek", "sk-heal", base)
    expect(readAuthFile(base)).toEqual({ deepseek: { key: "sk-heal" } })
    rmSync(base, { recursive: true, force: true })
  })
})

describe("SessionManager.setAuth 的入参校验(写入之前就抛,不碰文件)", () => {
  test("空 key / 未知 provider 明确拒绝", async () => {
    const sessionsRoot = mkdtempSync(path.join(tmpdir(), "yoma-auth-sessions-"))
    const manager = new SessionManager({ sessionsRoot, emit: () => {} })
    await expect(manager.setAuth("deepseek", "   ")).rejects.toThrow("不能为空")
    await expect(manager.setAuth("nope", "sk-x")).rejects.toThrow("未知 provider")
    rmSync(sessionsRoot, { recursive: true, force: true })
  })
})

describe("凭据全链路(子进程,干净 HOME)", () => {
  test("首跑目录 → setAuth 后 authenticated + 真实模型表 → removeAuth 复原", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "yoma-auth-home-"))
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      YOMA_EXPECT_HOME: home,
    }
    delete env.MY_PI_PROVIDER
    delete env.MY_PI_API_KEY
    delete env.MY_PI_MODEL

    const proc = Bun.spawnSync({
      cmd: [process.execPath, path.join(hostDir, "auth-e2e-fixture.ts")],
      cwd: path.resolve(hostDir, "..", ".."),
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = proc.stderr.toString()
    expect([proc.exitCode, stderr]).toEqual([0, ""])

    const result = JSON.parse(proc.stdout.toString()) as {
      catalog: string[]
      empty: [string, boolean, number][]
      afterSet: {
        deepseekAuthenticated: boolean
        deepseekHasModels: boolean
        moonshot: unknown
        file: unknown
      }
      afterRemove: [string, boolean, number][]
    }

    const catalogAllOff = CONFIGURABLE_PROVIDERS.map((spec) => [spec.id, false, 0])
    expect(result.empty).toEqual(catalogAllOff as never)
    expect(result.afterSet.deepseekAuthenticated).toBe(true)
    expect(result.afterSet.deepseekHasModels).toBe(true)
    // trim 过的 key 落盘
    expect(result.afterSet.file).toEqual({ deepseek: { key: "sk-e2e" } })
    // 没配 key 的 provider 仍然列出来,等着被连接
    expect(result.afterSet.moonshot).toEqual({
      id: "moonshotai-cn",
      name: "Moonshot (Kimi)",
      authenticated: false,
      models: [],
    })
    expect(result.afterRemove).toEqual(catalogAllOff as never)

    rmSync(home, { recursive: true, force: true })
  })
})
