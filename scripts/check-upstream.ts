import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { checkProtectedFiles, parseUpstreamLock, readProjectFile } from "./upstream-common.ts"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lock = parseUpstreamLock((await readProjectFile(root, "upstream-lock.json")).toString("utf8"))
const failures = await checkProtectedFiles(root, lock)
if (failures.length) throw new Error(failures.join("\n"))
console.log(`Git 源码/测试 ${Object.keys(lock.sha256).length} 个，与已保存的 ${lock.commit.slice(0, 9)} 清单一致；生成数据快照 ${Object.keys(lock.generatedSnapshot?.sha256 ?? {}).length} 个，与各自保存的哈希一致（生成数据不声称来自 Git commit）。`)
