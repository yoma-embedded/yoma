/**
 * createEmbeddedTools 把 configDir 传给了 datasheet 工具的验证。
 *
 * 为什么值得单独钉一条:datasheet 的服务器地址按 显式 > 环境变量 > `<configDir>/.env` >
 * 内置默认 解析,而 configDir 是**注入**的。漏传的后果不是报错,是"桌面端/bench 读的是
 * 开发机真实的 ~/.yoma/.env" —— 类型系统抓不到,单测不注入也抓不到(默认值分支照样能跑)。
 * 这里从工具的 promptGuidelines 反着看它解析到了什么:有服务器时是两条"先查手册再回答"
 * 的守则,关掉时是一条"不许凭记忆回答寄存器"的守则。
 *
 * 进程环境全程存/还原并清空这两个变量:开发机上真配了 YOMA_DATASHEET_SERVER 的话
 * 它压过 `<configDir>/.env`,断言就成了看跑测试的人怎么配的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeExecutionEnv } from "@yoma/agent/node"

import { createEmbeddedTools } from "./session-manager.ts"

const roots: string[] = []
const saved: Record<string, string | undefined> = {}
const VARS = ["YOMA_DATASHEET_SERVER", "YOMA_ENV_FILE"]

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function datasheetGuidelines(configDir: string): string[] {
  const env = new NodeExecutionEnv({ cwd: configDir })
  const tools = createEmbeddedTools(env, undefined, { configDir })
  const datasheet = tools.find((tool) => tool.name === "datasheet")
  expect(datasheet).toBeDefined()
  return datasheet?.promptGuidelines ?? []
}

describe("createEmbeddedTools 的 datasheet 服务器解析", () => {
  it("`<configDir>/.env` 里写了地址:走「已配置」那支守则", () => {
    const configDir = tempDir("yoma-embedded-config-")
    writeFileSync(path.join(configDir, ".env"), "YOMA_DATASHEET_SERVER=http://127.0.0.1:9/\n")

    const guidelines = datasheetGuidelines(configDir)
    expect(guidelines.length).toBe(2)
    expect(guidelines.join("\n")).toContain("search the indexed manuals")
    expect(guidelines.join("\n")).not.toContain("not configured")
  })

  it("`<configDir>/.env` 里写了 off:走「未配置」那支守则(不许凭记忆回答寄存器)", () => {
    const configDir = tempDir("yoma-embedded-config-")
    writeFileSync(path.join(configDir, ".env"), "YOMA_DATASHEET_SERVER=off\n")

    const guidelines = datasheetGuidelines(configDir)
    expect(guidelines.length).toBe(1)
    expect(guidelines[0]).toContain("not configured")
    expect(guidelines[0]).toContain("YOMA_DATASHEET_SERVER")
  })

  it("空 configDir(没有 .env):回落到内置默认,仍是「已配置」那支", () => {
    const guidelines = datasheetGuidelines(tempDir("yoma-embedded-config-"))
    expect(guidelines.length).toBe(2)
    expect(guidelines.join("\n")).not.toContain("not configured")
  })
})
