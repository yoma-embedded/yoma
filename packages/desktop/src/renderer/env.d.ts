import type { ElectronAPI } from "../preload/types"

declare global {
  interface ImportMetaEnv {
    readonly YOMA_CHANNEL: string
  }

  interface Window {
    api: ElectronAPI
    __YOMA__?: {
      deepLinks?: string[]
    }
  }
}

export {}
