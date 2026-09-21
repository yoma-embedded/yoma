import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { ProjectProfile } from "./model.ts"

/** Read only a bounded set of project descriptors; never execute a discovered command. */
export async function detectProject(
  root: string,
): Promise<{ profile: ProjectProfile; files: string[]; warnings: string[] }> {
  const profile: ProjectProfile = {
    name: path.basename(root),
    chip: "",
    board: "",
    framework: "",
    buildCommand: "",
    firmware: "",
    probe: "",
    log: "",
    verification: "",
  }
  const files: string[] = []
  const warnings: string[] = []
  const chips = new Set<string>()
  const kinds = new Set<string>()
  const skip = new Set([
    ".git",
    ".yoma",
    ".claude",
    "node_modules",
    "vendor",
    "Drivers",
    "Middlewares",
    "build",
    "dist",
    "out",
  ])
  let seen = 0
  async function walk(dir: string, depth: number) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (++seen > 400) return
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 2 && !skip.has(entry.name) && !entry.name.startsWith(".")) {
        await walk(absolute, depth + 1)
      } else if (
        entry.isFile() &&
        /^(CMakeLists\.txt|CMakePresets\.json|platformio\.ini|Makefile)$|\.(ioc|uvprojx|ewp)$/.test(entry.name)
      ) {
        if ((await stat(absolute)).size > 256 * 1024) continue
        const text = await readFile(absolute, "utf8")
        const relative = path.relative(root, absolute).split(path.sep).join("/")
        files.push(relative)
        if (entry.name.endsWith(".ioc")) {
          kinds.add("STM32Cube")
          const chip = text.match(/^Mcu\.(?:CPN|Name)=(.+)$/m)?.[1]?.trim()
          if (chip) chips.add(chip)
        }
        if (entry.name.endsWith(".uvprojx")) {
          kinds.add("Keil")
          for (const match of text.matchAll(/<Device>([^<]+)<\/Device>/g)) chips.add(match[1].trim())
        }
        if (entry.name.endsWith(".ewp")) kinds.add("IAR")
        if (depth === 0 && entry.name === "CMakeLists.txt") {
          kinds.add("CMake")
          if (text.includes("IDF_PATH")) {
            kinds.add("ESP-IDF")
            profile.buildCommand = "idf.py build"
          } else profile.buildCommand = "cmake -S . -B build && cmake --build build"
        }
        if (depth === 0 && entry.name === "Makefile" && !profile.buildCommand) profile.buildCommand = "make"
        if (depth === 0 && entry.name === "platformio.ini") {
          kinds.add("PlatformIO")
          profile.buildCommand = "pio run"
          const boards = [...new Set([...text.matchAll(/^\s*board\s*=\s*([^;\r\n]+)/gm)].map((m) => m[1].trim()))]
          if (boards.length === 1) profile.board = boards[0]
          else if (boards.length > 1) warnings.push("检测到多个 PlatformIO 环境，请选择要使用的板卡和构建环境")
        }
      }
    }
  }
  try {
    await walk(root, 0)
  } catch (error) {
    warnings.push(`工程识别未完成：${String(error)}`)
  }
  if (seen > 400) warnings.push("只检查了前 400 个目录项；可让 agent 继续分析并填写工程档案")
  profile.framework = [...kinds].join(" / ")
  if (chips.size === 1) profile.chip = [...chips][0]
  else if (chips.size > 1) warnings.push("发现多个芯片型号，请明确当前目标，未自动选择")
  return { profile, files, warnings }
}
