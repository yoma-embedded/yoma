import type { ElectronAPI } from "../preload/types"

declare global {
  interface ImportMetaEnv {
    readonly YOMA_CHANNEL: string
  }

  interface Window {
    api: ElectronAPI
  }
}

export {}
