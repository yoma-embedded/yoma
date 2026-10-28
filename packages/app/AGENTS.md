## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- NEVER try to restart the app, or the kernel process, EVER.

## Local Dev

From the repo root: `npm run dev:desktop`. Renderer has HMR; **the kernel process does not** — kernel changes (`packages/kernel`, including `src/host`) need a restart of that command.

There is no opencode HTTP server, no `packages/opencode`, and no `app.opencode.ai` proxy. The UI talks to a local kernel over MessagePort.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls.

## UI acceptance

| 规则 | 由什么拦住 |
|---|---|
| 中文设置检查条目正文；思考强度只保留专用下拉 | `npm run e2e:paint -w packages/desktop` 的中文条目与真实模型目录检查、界面截图 |
