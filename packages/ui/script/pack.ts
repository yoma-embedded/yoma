import { readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { $ } from "../../../scripts/shell.ts"

export async function pack() {
  const original = readFileSync("package.json", "utf8")
  const pkg = JSON.parse(original) as {
    name: string
    version: string
    exports: Record<string, string | { types: string; import: string }>
  }
  const tarball = path.resolve(`${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`)

  await $`npm run build`
  pkg.exports = Object.fromEntries(
    Object.entries(pkg.exports).map(([key, value]) => {
      if (typeof value !== "string" || (!value.endsWith(".ts") && !value.endsWith(".tsx"))) return [key, value]
      return [
        key,
        {
          types: value.replace("./src/", "./dist/").replace(/\.tsx?$/, ".d.ts"),
          import: value,
        },
      ]
    }),
  )

  await rm(tarball, { force: true })
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
  try {
    await $`npm pack`
    return tarball
  } finally {
    writeFileSync("package.json", original)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await pack())
