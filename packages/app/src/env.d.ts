// app 的编译单元把 @yoma-desktop/ui 的源码(svg/png 资产导入、import.meta.glob)一并
// 编进来,而 ui 自己 tsconfig 里的 "types": ["vite/client"] 只对 ui 的程序生效 ——
// 这里必须自己引一份,否则资产模块与 ImportMeta.glob 无声明。此前 tsgo -b 的
// tsbuildinfo 一直陈旧命中,这个洞从未被冷编译暴露过(2026-08-14 实测补上)。
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YOMA_SERVER_HOST: string
  readonly VITE_YOMA_SERVER_PORT: string
  readonly VITE_YOMA_CHANNEL?: "dev" | "beta" | "prod"
  readonly YOMA_CHANNEL?: "dev" | "beta" | "prod"

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
