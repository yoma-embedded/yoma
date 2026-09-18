/**
 * 日志行的纯函数层 —— **实现搬到了 session-ui**(`session-ui/src/components/log-lines.ts`)。
 *
 * 理由:时间线里的 log 工具卡片要用同一份"哪一条算 error",而卡片住在 session-ui,
 * 够不到 app。分层是 ui → session-ui → app,所以实现只能往下搬一层。
 * 这里留一个转出口,免得 bench/ 里四处 import 与那份用例跟着改路径。
 */
export * from "@yoma-desktop/session-ui/log-lines"
