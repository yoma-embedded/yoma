/** Windows 上也跑真实子进程:退出确认不是退出完成,一次就绪探测也可能消费 single-run 会话。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"
import { afterEach, expect, it } from "vitest"
import { GdbSession } from "../src/host/tools/gdb/mi-session.ts"
import { buildServerArgv, pickFreePort, SERVER_CAPS, spawnServer, stopServer, waitForServerReady, type ServerProcess } from "../src/host/tools/gdb/servers.ts"
import { writeFakeExe } from "./fixtures/fake-exe.ts"

const dirs: string[] = []
const sessions: GdbSession[] = []
const servers: ServerProcess[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "yoma-gdb-lifecycle-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop()
  for (const server of servers.splice(0)) await stopServer(server, false)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

it("收到 ^exit 后等待 GDB 自己完成 detach,不提前杀进程", async () => {
  const cwd = directory()
  const gdbPath = writeFakeExe(cwd, "gdb", `
import { writeFileSync } from 'node:fs'
process.stdin.setEncoding('utf8')
process.stdin.on('data', line => {
  const token = line.match(/^(\\d+)-gdb-exit/)?.[1]
  if (!token) return
  process.stdout.write(token + '^exit\\n')
  setTimeout(() => { writeFileSync('detached.txt', 'cleanup complete'); process.exit(0) }, 200)
})`)
  const session = new GdbSession({ gdbPath, cwd, logFile: join(cwd, "gdb.log"), miFile: join(cwd, "gdb.mi"), stopsFile: join(cwd, "stops.jsonl") })
  sessions.push(session)
  await session.spawnGdb()
  await session.stop()
  expect(readFileSync(join(cwd, "detached.txt"), "utf8")).toBe("cleanup complete")
  expect(session.running).toBe(false)
})

it("GDB 不响应时杀树,确认退出后才返回", async () => {
  const cwd = directory()
  const gdbPath = writeFakeExe(cwd, "unresponsive-gdb", "setInterval(() => {}, 1000)")
  const session = new GdbSession({
    gdbPath,
    cwd,
    logFile: join(cwd, "gdb.log"),
    miFile: join(cwd, "gdb.mi"),
    stopsFile: join(cwd, "stops.jsonl"),
  })
  sessions.push(session)
  await session.spawnGdb()
  const pid = session.pid!
  await session.stop()
  expect(session.running).toBe(false)
  expect(() => process.kill(pid, 0)).toThrow()
}, 20_000)

it("J-Link 就绪不产生 TCP 假连接,关闭等到服务器完成硬件清理", async () => {
  const cwd = directory()
  const port = await pickFreePort()
  const binary = writeFakeExe(cwd, "single-server", `
import net from 'node:net'
import { writeFileSync } from 'node:fs'
const server = net.createServer(socket => {
  writeFileSync('connected.txt', 'connected')
  socket.on('end', () => {
    socket.end()
    server.close(() => setTimeout(() => { writeFileSync('released.txt', 'released'); process.exit(0) }, 200))
  })
})
server.listen(Number(process.argv[2]), '127.0.0.1', () => {
  process.stdout.write('Listening on TCP/IP port ' + process.argv[2] + '\\n')
  setTimeout(() => { process.stdout.write('Waiting for GDB con'); setTimeout(() => process.stdout.write('nection...'), 30) }, 100)
})`)
  const server = spawnServer([binary, String(port)], port, cwd)
  servers.push(server)
  await waitForServerReady(server, SERVER_CAPS.jlink.readyRe, 5000, undefined, true)
  expect(existsSync(join(cwd, "connected.txt"))).toBe(false)
  await new Promise<void>((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1", () => client.end())
    client.on("error", reject)
    client.on("close", () => resolve())
  })
  await stopServer(server, true)
  expect(readFileSync(join(cwd, "released.txt"), "utf8")).toBe("released")
  expect(server.exited?.code).toBe(0)
  expect(buildServerArgv({ server: "jlink", chip: "STM32G473RC", port })).toContain("-singlerun")
})
