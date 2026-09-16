import { describe, expect, it, vi } from "vitest"
import { ScpiClient, ScpiTimeoutError, UsbTmcTransport, type UsbDeviceLike } from "../src/host/domain/scope/scpi.ts"

/** No USB enumeration: exercises the exact framing and lifecycle through an injected native device. */
class FakeUsb implements UsbDeviceLike {
  vendorId = 0xf4ec
  productId = 1
  serialNumber = "TEST-SCOPE"
  opened = false
  writes: Uint8Array[] = []
  readTimeouts: number[] = []
  released = 0
  closed = 0
  pendingReject?: (error: Error) => void
  configuration = { interfaces: [{ interfaceNumber: 0, alternate: {
    interfaceClass: 0xfe, interfaceSubclass: 3,
    endpoints: [
      { endpointNumber: 1, direction: "out" as const, type: "bulk" as const, packetSize: 512 },
      { endpointNumber: 2, direction: "in" as const, type: "bulk" as const, packetSize: 512 },
    ],
  } }] }
  input: (tag: number, timeout: number) => Promise<Uint8Array | null> = async (tag) => packet(tag, [65, 10])
  async open() { this.opened = true }
  async close() { this.closed++; this.opened = false; this.pendingReject?.(new Error("native handle closed")) }
  async claimInterface() {}
  async releaseInterface() { this.released++ }
  async clearHalt() {}
  async controlTransferIn() { return { status: "ok", data: new DataView(new Uint8Array([1, 0]).buffer) } }
  async nativeTransferOut(_endpoint: number, _timeout: number, data: Uint8Array) {
    this.writes.push(data.slice())
    return data.length
  }
  async nativeTransferIn(_endpoint: number, timeout: number) {
    this.readTimeouts.push(timeout)
    return this.input(this.writes.at(-1)![1]!, timeout)
  }
}

function packet(tag: number, body: number[], eom = true): Uint8Array {
  const bytes = new Uint8Array(12 + body.length + ((4 - body.length % 4) % 4))
  bytes[0] = 2
  bytes[1] = tag
  bytes[2] = ~tag & 0xff
  new DataView(bytes.buffer).setUint32(4, body.length, true)
  bytes[8] = eom ? 1 : 0
  bytes.set(body, 12)
  return bytes
}

describe("USBTMC framing and lifetime", () => {
  it("cancellation during interface claim releases the acquired interface before closing", async () => {
    const device = new FakeUsb()
    const controller = new AbortController()
    device.claimInterface = async () => { controller.abort(new Error("cancelled claim")) }
    await expect(UsbTmcTransport.fromDevice(device, controller.signal)).rejects.toThrow(/cancelled claim/)
    expect(device.released).toBe(1)
    expect(device.closed).toBe(1)
    expect(device.opened).toBe(false)
  })

  it("a failed configuration read closes the opened device", async () => {
    const device = new FakeUsb()
    Object.defineProperty(device, "configuration", { get() { throw new Error("descriptor failed") } })
    await expect(UsbTmcTransport.fromDevice(device)).rejects.toThrow("descriptor failed")
    expect(device.closed).toBe(1)
  })

  it("writes EOM, complement tag and zero padding; assembles all response parts", async () => {
    const device = new FakeUsb()
    let part = 0
    device.input = async (tag) => ++part === 1 ? packet(tag, [10, 20, 30], false) : packet(tag, [40])
    const transport = await UsbTmcTransport.fromDevice(device)
    try {
      await transport.write(new Uint8Array([42, 73, 68]))
      const first = device.writes[0]!
      expect(first[0]).toBe(1)
      expect(first[2]).toBe(~first[1]! & 0xff)
      expect(first[8]).toBe(1)
      expect(first.length).toBe(16)
      expect(first[15]).toBe(0)
      expect([...await transport.read(1000)]).toEqual([10, 20, 30, 40])
      expect(device.writes[1]![1]).not.toBe(device.writes[2]![1])
    } finally { await transport.close() }
  })

  it.each([
    ["message ID", (b: Uint8Array) => { b[0] = 1 }],
    ["transaction tag", (b: Uint8Array) => { b[1] = 77 }],
    ["complement tag", (b: Uint8Array) => { b[2] = 77 }],
    ["oversized transfer", (b: Uint8Array) => { new DataView(b.buffer).setUint32(4, 2 ** 20 + 1, true) }],
    ["truncated transfer", (b: Uint8Array) => { new DataView(b.buffer).setUint32(4, 100, true) }],
  ] as const)("rejects a corrupted %s", async (_name, corrupt) => {
    const device = new FakeUsb()
    device.input = async (tag) => { const bytes = packet(tag, [1, 2]); corrupt(bytes); return bytes }
    const transport = await UsbTmcTransport.fromDevice(device)
    try { await expect(transport.read(1000)).rejects.toThrow(/USBTMC/) }
    finally { await transport.close() }
  })

  it("rejects a non-final empty response instead of looping", async () => {
    const device = new FakeUsb()
    device.input = async (tag) => packet(tag, [], false)
    const transport = await UsbTmcTransport.fromDevice(device)
    try { await expect(transport.read(1000)).rejects.toThrow(/no progress/) }
    finally { await transport.close() }
  })

  it("rejects a short write before any query can use the device", async () => {
    const device = new FakeUsb()
    device.nativeTransferOut = async () => 1
    const transport = await UsbTmcTransport.fromDevice(device)
    try { await expect(transport.write(new Uint8Array([42]))).rejects.toThrow(/short USB write/) }
    finally { await transport.close() }
  })

  it("uses one deadline for all USB message parts", async () => {
    const device = new FakeUsb()
    let now = 1000
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    device.input = async (tag) => { now += 25; return packet(tag, [1], false) }
    const transport = await UsbTmcTransport.fromDevice(device)
    try {
      await expect(transport.read(65)).rejects.toBeInstanceOf(ScpiTimeoutError)
      expect(device.readTimeouts.length).toBeGreaterThan(1)
      expect(device.readTimeouts.at(-1)).toBeLessThan(device.readTimeouts[0]!)
      expect(device.writes.length).toBeLessThanOrEqual(3)
    } finally { await transport.close(); clock.mockRestore() }
  })

  it("cancellation closes the handle and waits until the native transfer actually rejects", async () => {
    const device = new FakeUsb()
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    device.input = () => new Promise((_resolve, reject) => { device.pendingReject = reject; readStarted() })
    const transport = await UsbTmcTransport.fromDevice(device)
    const controller = new AbortController()
    const read = transport.read(1000, controller.signal)
    const rejected = expect(read).rejects.toThrow("user stop")
    await started
    controller.abort(new Error("user stop"))
    await rejected
    expect(device.opened).toBe(false)
    expect(device.closed).toBe(1)
    expect(device.released).toBe(1)
    const writes = device.writes.length
    await expect(transport.write(new Uint8Array([42]))).rejects.toThrow(/closed/)
    expect(device.writes.length).toBe(writes)
  })

  it("client close interrupts a read instead of waiting behind it; queued commands do not escape", async () => {
    const device = new FakeUsb()
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    device.input = () => new Promise((_resolve, reject) => { device.pendingReject = reject; readStarted() })
    const transport = await UsbTmcTransport.fromDevice(device)
    const client = new ScpiClient(transport, { interCommandMs: 0 })
    const reading = client.query("*IDN?")
    const queued = client.command(":TRIGger:RUN")
    const rejected = Promise.all([
      expect(reading).rejects.toThrow(/closed/),
      expect(queued).rejects.toThrow(/closed/),
    ])
    await started
    await client.close()
    await rejected
    expect(device.writes.length).toBe(2) // command plus its single USBTMC read request
    expect(device.closed).toBe(1)
  })

  it("close retains ownership until a native transfer that outlives handle close settles", async () => {
    const device = new FakeUsb()
    let readStarted!: () => void
    let handleClosed!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    const nativeClosed = new Promise<void>((resolve) => { handleClosed = resolve })
    device.input = () => new Promise((_resolve, reject) => { device.pendingReject = reject; readStarted() })
    // node-usb-rs drops the device/interface handles, but a running transfer owns an endpoint clone.
    device.close = async () => { device.closed++; device.opened = false; handleClosed() }
    const client = new ScpiClient(await UsbTmcTransport.fromDevice(device), { interCommandMs: 0 })
    const reading = expect(client.query("*IDN?")).rejects.toThrow(/closed/)
    await started
    let closeReturned = false
    const closing = client.close().then(() => { closeReturned = true })
    await nativeClosed
    expect(closeReturned).toBe(false)
    device.pendingReject!(new Error("native transfer timed out"))
    await closing
    await reading
    expect(closeReturned).toBe(true)
  })
})
