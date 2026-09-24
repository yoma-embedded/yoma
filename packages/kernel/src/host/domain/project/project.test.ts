import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { emptyProfile, forgetMemory, inspectProject, projectRoot, saveMemory, saveProfile } from "./store.ts"
import { projectContext, searchMemories } from "./context.ts"
import { checkProjectBuild } from "./build.ts"
import type { MemoryInput } from "./model.ts"

const roots: string[] = []
async function workspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "yoma-project-")))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const memory = (title = "UART 接线"): MemoryInput => ({
  title,
  content: "板卡 A 的调试串口使用 PA2/PA3",
  kind: "fact",
  confidence: "verified",
  evidence: "schematic.pdf page 3; user confirmed board A",
  scope: "board A",
  enabled: true,
})

describe("project archive and memory", () => {
  test("detection is read-only and worktree boundaries are respected", async () => {
    const root = await workspace()
    await writeFile(path.join(root, ".git"), "gitdir: ../main/.git/worktrees/example")
    await writeFile(path.join(root, "board.ioc"), "Mcu.CPN=STM32G474RET6\n")
    await writeFile(path.join(root, "CMakeLists.txt"), "project(board)")
    await mkdir(path.join(root, "src"))
    const view = await inspectProject(path.join(root, "src"))
    expect(view.root).toBe(root)
    expect(view.profile.chip).toBe("STM32G474RET6")
    expect(view.profile.buildCommand).toContain("cmake")
    expect(view.saved).toBe(false)
    expect(await readdir(root)).not.toContain(".yoma")
  })

  test("configuration survives reopening; another project cannot see it", async () => {
    const root = await workspace()
    const initial = await inspectProject(root)
    await saveProfile(root, initial.revision, { ...initial.profile, chip: "STM32G474", firmware: "build/board.elf" })
    await mkdir(path.join(root, "source"))
    expect(await projectRoot(path.join(root, "source"))).toBe(root)
    expect((await inspectProject(root)).profile.chip).toBe("STM32G474")
    expect(await projectContext(root)).toContain("STM32G474")
    expect(await projectContext(await workspace())).not.toContain("STM32G474")
  })

  test("concurrent writers never overwrite each other with the same revision", async () => {
    const root = await workspace()
    const { revision } = await inspectProject(root)
    const results = await Promise.allSettled([
      saveMemory(root, revision, memory("串口"), "session:one"),
      saveMemory(root, revision, memory("波形"), "session:two"),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await inspectProject(root)).memories).toHaveLength(1)
    expect(await readFile(path.join(root, ".yoma/knowledge/.gitignore"), "utf8")).toBe("*\n")
  })

  test("the revision lock also serializes independent Node processes", async () => {
    const root = await workspace()
    const { revision } = await inspectProject(root)
    const script = `import { saveMemory } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
      try {
        await saveMemory(process.argv[1], process.argv[2], JSON.parse(process.argv[3]), 'agent');
        console.log('saved');
      } catch (error) {
        if (!String(error).includes('已变化')) throw error;
        console.log('conflict');
      }`
    const run = promisify(execFile)
    const results = await Promise.all(
      ["first", "second"].map((title) =>
        run(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script, root, revision, JSON.stringify(memory(title))],
          { timeout: 10_000 },
        ),
      ),
    )
    expect(results.map((result) => result.stdout.trim()).sort()).toEqual(["conflict", "saved"])
    expect((await inspectProject(root)).memories).toHaveLength(1)
  }, 15_000)

  test("disabled and forgotten entries leave retrieval; stale agents cannot restore them", async () => {
    const root = await workspace()
    let view = await inspectProject(root)
    view = await saveMemory(root, view.revision, memory(), "session:first")
    const item = view.memories[0]
    expect(await projectContext(root)).toContain(item.content)
    view = await saveMemory(root, view.revision, { ...item, enabled: false }, "user")
    expect(await projectContext(root)).not.toContain(item.content)
    expect(searchMemories(view.memories, "串口")).toEqual([])
    await expect(saveMemory(root, view.revision, item, "session:first")).rejects.toThrow("重新启用")
    const oldRevision = view.revision
    view = await forgetMemory(root, view.revision, item.id)
    await expect(saveMemory(root, oldRevision, item, "session:first")).rejects.toThrow("已变化")
    await expect(saveMemory(root, view.revision, memory(), "session:new")).rejects.toThrow("已删除")
    const disk = await readFile(path.join(root, ".yoma/knowledge/state.json"), "utf8")
    expect(disk).not.toContain(item.title)
    expect(disk).not.toContain(item.content)
    view = await saveMemory(root, view.revision, memory(), "user")
    expect(view.memories).toHaveLength(1)
  })

  test("verified entries require evidence and Chinese retrieval ranks matching records", async () => {
    const root = await workspace()
    let view = await inspectProject(root)
    await expect(saveMemory(root, view.revision, { ...memory(), evidence: "" }, "agent")).rejects.toThrow("依据")
    view = await saveMemory(root, view.revision, memory(), "agent")
    view = await saveMemory(
      root,
      view.revision,
      { ...memory("供电"), content: "USB 电源不足", kind: "experience" },
      "agent",
    )
    expect(searchMemories(view.memories, "串口接线")[0].title).toBe("UART 接线")
    expect(searchMemories(view.memories, "USB")[0].title).toBe("供电")
  })

  test("damaged state is surfaced without overwriting files", async () => {
    const root = await workspace()
    await mkdir(path.join(root, ".yoma/knowledge"), { recursive: true })
    const file = path.join(root, ".yoma/knowledge/state.json")
    await writeFile(file, "{broken")
    const view = await inspectProject(root)
    expect(view.revision).toBe("")
    expect(view.warnings.join()).toContain("原文件未修改")
    await expect(saveMemory(root, view.revision, memory(), "user")).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("{broken")
  })

  test.each(["../firmware.elf", "C:\\build\\firmware.elf", "/tmp/fw.elf"])(
    "rejects non-project firmware path %s",
    async (firmware) => {
      const root = await workspace()
      await expect(
        saveProfile(root, (await inspectProject(root)).revision, { ...emptyProfile(), firmware }),
      ).rejects.toThrow("相对工程")
    },
  )

  test("data directory symlinks cannot redirect memory reads or writes", async () => {
    const root = await workspace(),
      other = await workspace()
    await mkdir(path.join(other, "knowledge"))
    await symlink(other, path.join(root, ".yoma"), process.platform === "win32" ? "junction" : "dir")
    const view = await inspectProject(root)
    expect(view.warnings.join()).toContain("符号链接")
    await expect(saveMemory(root, view.revision, memory(), "user")).rejects.toThrow("符号链接")
    expect(await readdir(path.join(other, "knowledge"))).toEqual([])
  })
})

describe("explicit project build", () => {
  async function buildProject(script: string) {
    const root = await workspace()
    await writeFile(path.join(root, "build.cjs"), script)
    const initial = await inspectProject(root)
    const view = await saveProfile(root, initial.revision, {
      ...initial.profile,
      buildCommand: "node build.cjs",
      firmware: "firmware.bin",
    })
    const env = {
      ...process.env,
      PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ""),
      YOMA_BUILD_TEST: "from-toolchain-env",
    }
    return { root, view, env }
  }
  test("records real exit code, output and the artifact hash", async () => {
    const { root, view, env } = await buildProject(
      "require('fs').writeFileSync('firmware.bin', 'firmware-v1'); console.log(process.env.YOMA_BUILD_TEST)",
    )
    const result = await checkProjectBuild(root, view.revision, env, new AbortController().signal)
    expect(result.baseline).toMatchObject({
      ok: true,
      exitCode: 0,
      firmwareHash: createHash("sha256").update("firmware-v1").digest("hex"),
    })
    expect(result.baseline?.output).toContain("from-toolchain-env")
    expect(result.baseline?.profile).toEqual(view.profile)
  })
  test("a failed build cannot become a successful baseline", async () => {
    const { root, view, env } = await buildProject("console.error('compile failed'); process.exit(7)")
    const result = await checkProjectBuild(root, view.revision, env, new AbortController().signal)
    expect(result.baseline).toMatchObject({ ok: false, exitCode: 7 })
    expect(result.baseline?.firmwareHash).toBeUndefined()
  })
  test("quoted paths and chained commands reach the shell intact", async () => {
    const { root, view, env } = await buildProject("console.log('quoted-success')")
    await mkdir(path.join(root, "中文 folder"))
    await writeFile(path.join(root, "中文 folder", "build file.cjs"), "console.log('中文 result')")
    const changed = await saveProfile(root, view.revision, {
      ...view.profile,
      buildCommand: 'node "中文 folder/build file.cjs" && node build.cjs',
    })
    const result = await checkProjectBuild(root, changed.revision, env, new AbortController().signal)
    expect(result.baseline?.ok).toBe(true)
    expect(result.baseline?.output).toContain("中文 result")
    expect(result.baseline?.output).toContain("quoted-success")
  })
  test("cancellation stops a running build and records failure", async () => {
    const { root, view, env } = await buildProject("console.log('started'); setInterval(() => {}, 1000)")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      const result = await checkProjectBuild(root, view.revision, env, controller.signal)
      expect(result.baseline?.ok).toBe(false)
      expect(result.baseline?.output).toContain("取消")
    } finally {
      clearTimeout(timer)
    }
  })
  test("changed firmware configuration cannot inherit an in-flight build result", async () => {
    const { root, view, env } = await buildProject("setTimeout(() => process.exit(0), 400)")
    const building = checkProjectBuild(root, view.revision, env, new AbortController().signal)
    const result = expect(building).rejects.toThrow("配置已变化")
    await new Promise((resolve) => setTimeout(resolve, 150))
    await saveProfile(root, view.revision, { ...view.profile, firmware: "different.bin" })
    await result
    expect((await inspectProject(root)).baseline).toBeUndefined()
  })
})
