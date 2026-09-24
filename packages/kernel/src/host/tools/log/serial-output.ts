/** Bounded serial TX. It owns one nonblocking POSIX fd or the Windows bridge's stdin/ack channel. */
import { closeSync, writeSync } from "node:fs"
import type { Writable } from "node:stream"
import type { LogInput } from "./contract.ts"

export const MAX_SEND_BYTES = 4096
export function serialBytes(input: Pick<LogInput, "data" | "encoding" | "lineEnding">): Buffer {
  if (typeof input.data !== "string") throw new Error("serial send requires data")
  if (input.data.length > MAX_SEND_BYTES * 3) throw new Error(`Send at most ${MAX_SEND_BYTES} bytes at a time`)
  let data: Buffer
  if (input.encoding === "hex") {
    const hex = input.data.replace(/\s/g, "")
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("Hex must contain complete byte pairs, e.g. 01 A0 FF")
    data = Buffer.from(hex, "hex")
  } else if (!input.encoding || input.encoding === "text") data = Buffer.from(input.data, "utf8")
  else throw new Error("Unsupported serial encoding")
  const endings = { none: "", lf: "\n", cr: "\r", crlf: "\r\n" }
  const ending = input.lineEnding ?? "none"
  if (!Object.hasOwn(endings, ending)) throw new Error("Unsupported line ending")
  data = Buffer.concat([data, Buffer.from(endings[ending])])
  if (!data.length || data.length > MAX_SEND_BYTES)
    throw new Error(`Send between 1 and ${MAX_SEND_BYTES} bytes at a time`)
  return data
}

export class SerialOutput {
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  private next = 0
  private pending?: { id: number; bytes: number; resolve: (n: number) => void; reject: (e: Error) => void }
  private input?: Writable
  private ready = false
  private readyWaiters = new Set<() => void>()
  constructor(private fd?: number) {
    this.ready = fd !== undefined
  }
  attach(input: Writable) {
    this.input = input
    input.on("error", () => this.close())
  }
  /** Returns true only for protocol frames on the child stderr, never for board stdout. */
  acknowledge(line: string): boolean {
    if (!line.startsWith("@@yoma-serial ")) return false
    const [, op, id, value] = line.split(" ")
    if (op === "ready") {
      this.ready = true
      for (const wake of this.readyWaiters) wake()
    }
    const pending = this.pending
    if (pending && Number(id) === pending.id) {
      if (op === "sent" && Number(value) === pending.bytes) pending.resolve(pending.bytes)
      else if (op === "error")
        pending.reject(
          new Error(
            `Serial write failed: ${Buffer.from(value ?? "", "base64").toString("utf8")}. Some bytes may have been sent; not retried.`,
          ),
        )
    }
    return true
  }
  async waitReady() {
    if (this.closed) throw new Error("Serial port is disconnected")
    if (this.ready) return
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        if (!this.ready && !this.closed) return
        clearTimeout(timer)
        this.readyWaiters.delete(wake)
        if (this.closed) reject(new Error("Serial bridge closed before opening the port"))
        else resolve()
      }
      const timer = setTimeout(() => {
        this.readyWaiters.delete(wake)
        reject(new Error("Serial port did not open within 10 seconds"))
      }, 10000)
      this.readyWaiters.add(wake)
      wake()
    })
  }
  write(data: Buffer): Promise<number> {
    const run = this.queue.then(() => this.send(data))
    this.queue = run.catch(() => {})
    return run
  }
  private async send(data: Buffer): Promise<number> {
    if (this.closed || !this.ready) throw new Error("Serial port is disconnected")
    if (this.fd !== undefined) {
      let offset = 0
      const deadline = Date.now() + 2000
      while (offset < data.length) {
        if (this.closed) throw new Error(`Serial port disconnected after ${offset}/${data.length} bytes; not retried`)
        try {
          offset += writeSync(this.fd!, data, offset, data.length - offset)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR") {
            throw new Error(`Serial write failed after ${offset}/${data.length} bytes: ${String(error)}; not retried`)
          }
        }
        if (offset === data.length) return offset
        if (Date.now() >= deadline)
          throw new Error(`Serial write timed out after ${offset}/${data.length} bytes; not retried`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return offset
    }
    if (!this.input) throw new Error("Serial bridge is unavailable")
    return new Promise<number>((resolve, reject) => {
      const id = ++this.next
      const finish = (error?: Error, count = 0) => {
        clearTimeout(timer)
        if (this.pending?.id !== id) return
        this.pending = undefined
        if (error) reject(error)
        else resolve(count)
      }
      const timer = setTimeout(() => {
        finish(
          new Error(
            "Serial write acknowledgement timed out; bytes may have been sent. Reconnect before sending again.",
          ),
        )
        this.close()
      }, 4000)
      this.pending = { id, bytes: data.length, resolve: (n) => finish(undefined, n), reject: (error) => finish(error) }
      this.input?.write(`${id} ${data.toString("base64")}\n`, (error) => {
        if (error) finish(error)
      })
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd)
      } catch {}
      this.fd = undefined
    }
    this.pending?.reject(new Error("Serial port disconnected; send was not confirmed and was not retried"))
    for (const wake of this.readyWaiters) wake()
    this.input?.destroy()
  }
}

/** PowerShell 5.1 hosts a small duplex bridge; payloads are base64 data, never executable commands. */
export const WINDOWS_DUPLEX_BRIDGE = `
using System;
using System.IO;
using System.IO.Ports;
using System.Text;
using System.Threading;
public static class YomaSerialBridge {
  public static void Run(SerialPort port) {
    port.WriteTimeout = 2000;
    var errors = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };
    var writer = new Thread(() => {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) {
          string[] parts = line.Split(new char[] { ' ' }, 2);
          int id;
          if (parts.Length != 2 || !Int32.TryParse(parts[0], out id)) continue;
          try {
            byte[] data = Convert.FromBase64String(parts[1]);
            if (data.Length == 0 || data.Length > 4096) throw new Exception("Invalid send size");
            port.Write(data, 0, data.Length);
            lock(errors) errors.WriteLine("@@yoma-serial sent " + id + " " + data.Length);
          } catch(Exception ex) {
            lock(errors) errors.WriteLine("@@yoma-serial error " + id + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(ex.Message)));
          }
        }
      } catch(Exception) {
        // Closing stdin or the port during disconnect terminates the writer.
      } finally { try { port.Close(); } catch(Exception) {} }
    });
    writer.IsBackground = true;
    lock(errors) errors.WriteLine("@@yoma-serial ready");
    writer.Start();
    var output = Console.OpenStandardOutput();
    byte[] buffer = new byte[4096];
    try {
      while (port.IsOpen) {
        int count = port.Read(buffer, 0, buffer.Length);
        if (count > 0) { output.Write(buffer, 0, count); output.Flush(); }
      }
    } finally { port.Close(); }
  }
}`
