import { beforeEach, describe, expect, test } from "vitest"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const src = await readFile(join(import.meta.dirname, "..", "public", "oc-theme-preload.js"), "utf8")

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 to oc-2 before mount", () => {
    localStorage.setItem("yoma-theme-id", "oc-1")
    localStorage.setItem("yoma-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("yoma-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("yoma-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("yoma-theme-css-light")).toBeNull()
    expect(localStorage.getItem("yoma-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("falls back to oc-2 when the saved theme is no longer shipped", () => {
    localStorage.setItem("yoma-theme-id", "gruvbox")
    localStorage.setItem("yoma-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("yoma-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(localStorage.getItem("yoma-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("yoma-theme-css-light")).toBeNull()
    expect(localStorage.getItem("yoma-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("shipped list matches the themes bundled by the ui package", async () => {
    const dir = join(import.meta.dirname, "..", "..", "ui", "src", "theme", "themes")
    const shipped = (await readdir(dir)).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5))
    const listed = /var shipped = \[([^\]]*)\]/.exec(src)?.[1]
    expect(listed).toBeDefined()
    const ids = listed!.split(",").map((entry) => entry.trim().replaceAll('"', ""))
    expect([...ids].sort()).toEqual([...shipped].sort())
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("yoma-theme-id", "dracula")
    localStorage.setItem("yoma-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("dracula")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
