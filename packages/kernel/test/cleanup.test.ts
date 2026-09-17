import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { removeTempDir } from "./cleanup.ts"

const busy = (code: string) => Object.assign(new Error(`${code}: still held`), { code })

describe("removeTempDir", () => {
  it("真删:目录连同里面的东西一起没了", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yoma-cleanup-"))
    mkdirSync(join(dir, "bin"))
    writeFileSync(join(dir, "bin", "stm32kernel.exe"), "x")
    await removeTempDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it("被别的进程攥着(EPERM / EBUSY / ENOTEMPTY)时等一会儿再试,放开了就成功", async () => {
    for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
      let calls = 0
      const started = Date.now()
      await removeTempDir("unused", {
        rm: () => {
          calls += 1
          if (calls <= 3) throw busy(code)
        },
      })
      expect(calls).toBe(4)
      // 三次失败之间是真的睡了(每次 100 ms),不是原地空转 —— 同步 rmSync 的重试错就错在这儿。
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    }
  })

  it("一直放不开:到期限把原来的错误抛出来,不吞", async () => {
    let calls = 0
    await expect(
      removeTempDir("unused", {
        timeoutMs: 300,
        rm: () => {
          calls += 1
          throw busy("EPERM")
        },
      }),
    ).rejects.toThrow("EPERM: still held")
    expect(calls).toBeGreaterThan(1)
  })

  it("不是「被占着」的错误不重试:路径写错、权限真不够要马上看见", async () => {
    let calls = 0
    await expect(
      removeTempDir("unused", {
        rm: () => {
          calls += 1
          throw busy("EACCES")
        },
      }),
    ).rejects.toThrow("EACCES")
    expect(calls).toBe(1)
  })
})
