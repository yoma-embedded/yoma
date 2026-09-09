import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const runningFromSource = import.meta.url.endsWith(".ts")

export function sourceChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!runningFromSource) return env
  const tsxDir = path.dirname(createRequire(import.meta.url).resolve("tsx/package.json"))
  const loader = pathToFileURL(path.join(tsxDir, "dist", "loader.mjs")).href
  const here = path.dirname(fileURLToPath(import.meta.url))
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${loader}`].filter(Boolean).join(" "),
    TSX_TSCONFIG_PATH: env.TSX_TSCONFIG_PATH ?? path.resolve(here, "..", "..", "..", "tsconfig.yoma.json"),
  }
}
