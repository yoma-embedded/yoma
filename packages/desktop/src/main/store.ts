import path from "node:path"
import electron from "electron"

import { createJsonStore, type JsonStore } from "./json-store"
import { write as writeLog } from "./logging"
import { SETTINGS_STORE } from "./store-keys"

const cache = new Map<string, JsonStore>()

// We cannot create the store at module load time because module import hoisting causes this to
// run before app.setPath("userData", ...) in index.ts has executed, which would result in files
// being written to the default directory
// (e.g. bad: %APPDATA%\@yoma-desktop\desktop\yoma.settings vs good: %APPDATA%\com.yoma.desktop.dev\yoma.settings).
export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = createJsonStore(path.join(electron.app.getPath("userData"), name), {
    onCorrupt: (error) =>
      writeLog("main", "store file unreadable, set aside as .corrupt", { name, error: String(error) }, "error"),
  })
  cache.set(name, next)
  return next
}
