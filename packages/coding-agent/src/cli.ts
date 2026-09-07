#!/usr/bin/env bun
import { runCli } from "./cli/main.ts"
import { terminalText } from "./cli/terminal.ts"

process.exitCode = await runCli(process.argv.slice(2), {
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  terminal: process.stdin.isTTY === true,
  signals: process,
}).catch((error: unknown) => {
  process.stderr.write(`${terminalText(error instanceof Error ? error.message : String(error))}\n`)
  return 1
})
