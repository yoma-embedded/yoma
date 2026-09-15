import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

test.each(["cp1252", "gbk"])("frozen engine hook overrides %s pipes before help and JSON output", (encoding) => {
  const hook = fileURLToPath(new URL("../../engines/controller_map/utf8_stdio.py", import.meta.url))
  const output = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      `
import argparse, json, runpy, sys
assert sys.stdout.encoding == ${JSON.stringify(encoding)}
runpy.run_path(sys.argv[1])
assert all(s.encoding == "utf-8" for s in (sys.stdin, sys.stdout, sys.stderr))
argparse.ArgumentParser(description="netlist → board IR").print_help()
print(json.dumps({"input": sys.stdin.read()}, ensure_ascii=False))
`,
      hook,
    ],
    {
      env: { ...process.env, PYTHONUTF8: "0", PYTHONIOENCODING: `${encoding}:strict` },
      input: "中文网表 → MCU",
      encoding: "utf8",
    },
  )
  expect(output).toContain("netlist → board IR")
  expect(output).toContain('"input": "中文网表 → MCU"')
})
