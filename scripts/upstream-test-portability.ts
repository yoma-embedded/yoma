import type { Plugin } from "vite"

/** Test fixtures only: keep the hash-locked upstream files unchanged on disk.
 * Windows needs drive-qualified fixture cwd values and native cwd output from Git Bash.
 * No assertions are removed and no production module is transformed.
 */
export function adaptUpstreamTest(code: string, id: string): string | undefined {
  const file = id.replaceAll("\\", "/")
  if (/\/packages\/agent\/test\/harness\/jsonl-(v3-migration|session-repo)\.test\.ts$/.test(file)) {
    return code
      .replace(/"\/workspace(-[ab])?"/g, (_, suffix = "") => JSON.stringify(`C:\\workspace${suffix}`))
      .replaceAll('"--workspace--"', '"--C--workspace--"')
      .replaceAll('"/sessions/--workspace--/"', JSON.stringify('\\sessions\\--C--workspace--\\'))
  }
  if (/\/packages\/agent\/test\/harness\/(nodejs-env|tools)\.test\.ts$/.test(file)) {
    // $PWD uses MSYS paths (/tmp/…), while canonicalPath/realpath return Windows paths.
    return code.replaceAll('"$PWD"', '"$(cygpath -alw .)"')
  }
}

export function upstreamTestPortability(): Plugin {
  return {
    name: "yoma-upstream-test-portability",
    enforce: "pre",
    transform(code, id) {
      if (process.platform !== "win32") return
      const adapted = adaptUpstreamTest(code, id)
      if (adapted !== undefined) return { code: adapted, map: null }
    },
  }
}
