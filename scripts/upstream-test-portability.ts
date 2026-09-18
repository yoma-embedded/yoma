import type { Plugin } from "vite"

const SESSION_SYNC_CLEANUP = "if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });"
/** timeout/abort 之后 bash/sleep 还攥着目录;Node 的 rmSync retryDelay 并不真的等,见 kernel/test/cleanup.ts。 */
const SESSION_WIN_CLEANUP = `if (!existsSync(dir)) continue;
		const deadline = Date.now() + (process.env.CI ? 24000 : 6000);
		for (;;) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				const errCode = (error as NodeJS.ErrnoException).code;
				if (!errCode || (errCode !== "EPERM" && errCode !== "EBUSY" && errCode !== "ENOTEMPTY") || Date.now() > deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}`

/** Test fixtures only: keep the hash-locked upstream files unchanged on disk.
 * Windows needs drive-qualified fixture cwd values, native cwd output from Git Bash,
 * and a yielding temp-dir cleanup after timeout/abort tests.
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
  if (/\/packages\/agent\/test\/harness\/session-test-utils\.ts$/.test(file)) {
    if (!code.includes("afterEach(() => {") || !code.includes(SESSION_SYNC_CLEANUP)) {
      throw new Error("upstream session-test-utils.ts cleanup shape changed; update adaptUpstreamTest")
    }
    return code.replace("afterEach(() => {", "afterEach(async () => {").replace(SESSION_SYNC_CLEANUP, SESSION_WIN_CLEANUP)
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
