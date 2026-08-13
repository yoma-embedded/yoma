/**
 * 凭据写入端 + CONFIGURABLE_PROVIDERS 副本的防漂移闸 + 老位置迁移。
 *
 * **本进程里绝不碰真实的 ~/.my-pi**:所有入口都注入 configDir,指向 mkdtemp 目录。
 *
 * 2026-08 之前这套测试要起一个"出生时 HOME 就是临时目录"的子进程 —— 因为当年
 * my-pi 的 resolveModel() 直接读 os.homedir(),而 Bun 的 homedir() 在进程启动时定死,
 * 运行时改 process.env.HOME 无效(实测踩过:早先版本以为换了 HOME,实际把开发机上
 * 真实的 auth.json 洗掉了)。现在 resolveModel(configDir) 收显式目录,那套机关连同
 * 它的 fixture 一起退休 —— 注入目录就够了,而且快得多。
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { resolveModel } from "@yoma/my-pi-coding-agent/models"

import {
  authFilePath,
  CONFIGURABLE_PROVIDERS,
  migrateLegacyPiAuth,
  myPiConfigDir,
  readAuthFile,
  removeAuthKey,
  writeAuthKey,
} from "./auth.ts"
import { SessionManager } from "./session-manager.ts"

const dirs: string[] = []
function tempDir(prefix = "yoma-auth-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

describe("默认位置", () => {
  test("跟 my-pi ACP 用同一个目录(~/.my-pi),不再是 ~/.pi/agent", () => {
    expect(myPiConfigDir()).toBe(path.join(homedir(), ".my-pi"))
    expect(authFilePath()).toBe(path.join(homedir(), ".my-pi", "auth.json"))
  })
})

describe("CONFIGURABLE_PROVIDERS 与 my-pi 的 PROVIDERS 表一致", () => {
  test("用 MY_PI_PROVIDER 逼出的 Known providers 集合和副本相等", async () => {
    // PROVIDERS 表没有导出,唯一能拿到完整键集合的地方是这条报错:指定一个不存在的
    // provider,resolveModel 在碰任何凭据逻辑之前就抛 Unknown provider + 完整名单。
    // 措辞变了这里会响,照着新措辞修 —— 重点是别让名单默默漂移。
    const savedProvider = process.env.MY_PI_PROVIDER
    process.env.MY_PI_PROVIDER = "__yoma_drift_probe__"
    let message = ""
    try {
      await resolveModel(tempDir())
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
    cleanup()
  })
})

describe("auth.json 写入端(configDir 注入,不碰真实 HOME)", () => {
  test("写入带 type:api_key —— 少了这个字段 key 会被内核静默忽略", async () => {
    const base = tempDir()
    await writeAuthKey("deepseek", "sk-test-1", base)
    const file = authFilePath(base)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ deepseek: { type: "api_key", key: "sk-test-1" } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    cleanup()
  })

  test("覆盖 key 保留同条目里别的字段;删除是整条移除", async () => {
    const base = tempDir()
    writeFileSync(
      authFilePath(base),
      JSON.stringify({
        deepseek: { type: "api_key", key: "old", env: { region: "cn" } },
        "moonshotai-cn": { type: "api_key", key: "kimi" },
      }),
    )

    await writeAuthKey("deepseek", "sk-new", base)
    expect(readAuthFile(base)).toEqual({
      deepseek: { type: "api_key", key: "sk-new", env: { region: "cn" } },
      "moonshotai-cn": { type: "api_key", key: "kimi" },
    })

    await removeAuthKey("deepseek", base)
    expect(readAuthFile(base)).toEqual({ "moonshotai-cn": { type: "api_key", key: "kimi" } })
    cleanup()
  })

  test("损坏的 auth.json 当空表处理,写入后自愈", async () => {
    const base = tempDir()
    writeFileSync(authFilePath(base), "{ not json")
    expect(readAuthFile(base)).toEqual({})
    await writeAuthKey("deepseek", "sk-heal", base)
    expect(readAuthFile(base)).toEqual({ deepseek: { type: "api_key", key: "sk-heal" } })
    cleanup()
  })
})

describe("老位置迁移(~/.pi/agent/auth.json → <configDir>/auth.json)", () => {
  /** 造一份老格式的 legacy 文件,返回它的路径。 */
  function legacyWith(content: unknown): string {
    const dir = tempDir("yoma-legacy-")
    const file = path.join(dir, "auth.json")
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
    return file
  }

  test("迁移会补上 type 字段 —— 老格式没有它,照搬过去等于没搬", () => {
    const base = tempDir()
    const legacy = legacyWith({ deepseek: { key: "sk-old" }, "moonshotai-cn": { key: "kimi-old" } })
    expect(migrateLegacyPiAuth(base, legacy).sort()).toEqual(["deepseek", "moonshotai-cn"])
    expect(readAuthFile(base)).toEqual({
      deepseek: { type: "api_key", key: "sk-old" },
      "moonshotai-cn": { type: "api_key", key: "kimi-old" },
    })
    expect(statSync(authFilePath(base)).mode & 0o777).toBe(0o600)
    cleanup()
  })

  test("不删旧文件 —— 用户可能还在用 pi 命令行", () => {
    const base = tempDir()
    const legacy = legacyWith({ deepseek: { key: "sk-old" } })
    migrateLegacyPiAuth(base, legacy)
    expect(readFileSync(legacy, "utf8")).toContain("sk-old")
    cleanup()
  })

  test("目标已存在时不迁移 —— 迁移必须幂等,不能覆盖用户新配的 key", async () => {
    const base = tempDir()
    await writeAuthKey("deepseek", "sk-new", base)
    expect(migrateLegacyPiAuth(base, legacyWith({ deepseek: { key: "sk-old" } }))).toEqual([])
    expect(readAuthFile(base)).toEqual({ deepseek: { type: "api_key", key: "sk-new" } })
    cleanup()
  })

  test("老文件不存在 / 损坏 / 没有 key 时都安静返回空,不建文件", () => {
    const missing = tempDir()
    expect(migrateLegacyPiAuth(missing, path.join(tempDir(), "nope.json"))).toEqual([])

    const broken = tempDir()
    expect(migrateLegacyPiAuth(broken, legacyWith("{ not json"))).toEqual([])

    const keyless = tempDir()
    expect(migrateLegacyPiAuth(keyless, legacyWith({ deepseek: { type: "oauth" } }))).toEqual([])

    for (const dir of [missing, broken, keyless]) expect(readAuthFile(dir)).toEqual({})
    cleanup()
  })
})

describe("SessionManager.setAuth 的入参校验(写入之前就抛,不碰文件)", () => {
  test("空 key / 未知 provider 明确拒绝", async () => {
    const sessionsRoot = tempDir("yoma-auth-sessions-")
    const manager = new SessionManager({ sessionsRoot, configDir: tempDir(), emit: () => {} })
    await expect(manager.setAuth("deepseek", "   ")).rejects.toThrow("不能为空")
    await expect(manager.setAuth("nope", "sk-x")).rejects.toThrow("未知 provider")
    cleanup()
  })
})

describe("凭据全链路(注入 configDir,进程内)", () => {
  test("首跑目录 → setAuth 后 authenticated + 真实模型表 → removeAuth 复原", async () => {
    const configDir = tempDir("yoma-auth-config-")
    const sessionsRoot = tempDir("yoma-auth-sessions-")

    // 开发机上可能真的设了这些,会让"首跑没有任何 key"的前提不成立。
    const saved: Record<string, string | undefined> = {}
    for (const name of ["MY_PI_PROVIDER", "MY_PI_MODEL", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"]) {
      saved[name] = process.env[name]
      delete process.env[name]
    }

    try {
      const manager = new SessionManager({ sessionsRoot, configDir, emit: () => {} })

      const empty = await manager.providers()
      expect(empty.map((p) => [p.id, p.authenticated, p.models.length])).toEqual(
        CONFIGURABLE_PROVIDERS.map((spec) => [spec.id, false, 0]) as never,
      )

      const afterSet = await manager.setAuth("deepseek", "  sk-e2e  ")
      const deepseek = afterSet.find((p) => p.id === "deepseek")!
      expect(deepseek.authenticated).toBe(true)
      expect(deepseek.models.length).toBeGreaterThan(0)
      // 没配 key 的 provider 仍然列出来,等着被连接
      expect(afterSet.find((p) => p.id === "moonshotai-cn")).toEqual({
        id: "moonshotai-cn",
        name: "Moonshot (Kimi)",
        authenticated: false,
        models: [],
      })
      // trim 过的 key 落盘,而且带 type
      expect(readAuthFile(configDir)).toEqual({ deepseek: { type: "api_key", key: "sk-e2e" } })

      const afterRemove = await manager.removeAuth("deepseek")
      expect(afterRemove.map((p) => [p.id, p.authenticated, p.models.length])).toEqual(
        CONFIGURABLE_PROVIDERS.map((spec) => [spec.id, false, 0]) as never,
      )
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      cleanup()
    }
  }, 20_000)

  test("手写缺 type 的 key 仍算已配置", async () => {
    const configDir = tempDir("yoma-auth-typeless-")
    const sessionsRoot = tempDir("yoma-auth-sessions-")
    writeFileSync(authFilePath(configDir), JSON.stringify({ deepseek: { key: "sk-no-type" } }))
    const saved: Record<string, string | undefined> = {}
    for (const name of ["MY_PI_PROVIDER", "MY_PI_MODEL", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"]) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    try {
      const manager = new SessionManager({ sessionsRoot, configDir, emit: () => {} })
      const list = await manager.providers()
      const deepseek = list.find((p) => p.id === "deepseek")!
      expect(deepseek.authenticated).toBe(true)
      expect(deepseek.models.length).toBeGreaterThan(0)
      expect(readAuthFile(configDir).deepseek?.type).toBe("api_key")
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      cleanup()
    }
  }, 20_000)
})
