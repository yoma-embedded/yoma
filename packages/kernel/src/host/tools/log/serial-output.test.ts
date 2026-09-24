import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { SerialOutput, serialBytes } from "./serial-output.ts"

describe("serial output", () => {
  it("encodes UTF-8 and exact line endings, including an empty Enter command", () => {
    expect(serialBytes({ data: "你好", lineEnding: "crlf" }).toString("hex")).toBe("e4bda0e5a5bd0d0a")
    expect(serialBytes({ data: "", lineEnding: "lf" })).toEqual(Buffer.from([10]))
    expect(serialBytes({ data: "00 ff 03", encoding: "hex" })).toEqual(Buffer.from([0, 255, 3]))
    expect(() => serialBytes({ data: "F", encoding: "hex" })).toThrow(/byte pairs/)
    expect(() => serialBytes({ data: "0xFF", encoding: "hex" })).toThrow(/byte pairs/)
    expect(() => serialBytes({ data: "" })).toThrow(/between/)
    expect(() => serialBytes({ data: "好".repeat(1366) })).toThrow(/4096/)
    expect(() => serialBytes({ data: "x".repeat(4096), lineEnding: "lf" })).toThrow(/4096/)
  })

  it("waits for the bridge's matching byte acknowledgement, serializes sends and reports failures without retry", async () => {
    const output = new SerialOutput()
    const pipe = new PassThrough()
    let sent = ""
    pipe.on("data", (chunk) => {
      sent += chunk.toString()
    })
    output.attach(pipe)
    output.acknowledge("@@yoma-serial ready")
    await output.waitReady()
    try {
      let complete = false
      const first = output.write(Buffer.from([0, 255])).then((n) => {
        complete = true
        return n
      })
      const second = output.write(Buffer.from([3]))
      await Promise.resolve()
      expect(sent).toBe("1 AP8=\n")
      output.acknowledge("@@yoma-serial sent 2 2")
      output.acknowledge("@@yoma-serial sent 1 1")
      await Promise.resolve()
      expect(complete).toBe(false)
      output.acknowledge("@@yoma-serial sent 1 2")
      expect(await first).toBe(2)
      await Promise.resolve()
      expect(sent).toBe("1 AP8=\n2 Aw==\n")
      const rejected = expect(second).rejects.toThrow(/not retried/)
      output.acknowledge(`@@yoma-serial error 2 ${Buffer.from("Disconnected").toString("base64")}`)
      await rejected
      expect(sent).toBe("1 AP8=\n2 Aw==\n")
      const pending = output.write(Buffer.from("later"))
      await Promise.resolve()
      const closed = expect(pending).rejects.toThrow(/disconnected/)
      output.close()
      await closed
      await expect(output.write(Buffer.from("again"))).rejects.toThrow(/disconnected/)
    } finally {
      output.close()
    }
  })

  it("releases connection readiness when the bridge exits before opening", async () => {
    const output = new SerialOutput()
    const waiting = expect(output.waitReady()).rejects.toThrow(/closed before opening/)
    output.close()
    await waiting
  })
})
