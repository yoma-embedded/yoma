import { describe, expect, test } from "bun:test"
import { updaterAction } from "./updater-action"

describe("updaterAction", () => {
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
  })

  test("labels a download that already knows its percentage", () => {
    // 百分比进设置页的状态描述行,动作按钮只保留"正在下载"这一档 —— 下载期间没有可点的动作。
    const action = updaterAction({ status: "downloading", version: "2.0.0", percent: 42, transferred: 42, total: 100 })

    expect(action.label).toBe("settings.updates.action.downloading")
    expect(action).not.toHaveProperty("run")
  })

  test("offers install while an update is ready and nothing while it installs", () => {
    expect(updaterAction({ status: "ready", version: "2.0.0", notes: "fixed flash timeouts" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" }).run).toBeUndefined()
  })

  test("offers no action when the platform disabled updates", () => {
    expect(updaterAction({ status: "disabled" })).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("lets the user retry after an error and after an up-to-date result", () => {
    expect(updaterAction({ status: "error", message: "network is down" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "up-to-date" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
  })
})
