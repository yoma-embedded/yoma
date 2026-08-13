## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- NEVER try to restart the app, or the kernel process, EVER.

## Local Dev

From the repo root: `bun dev:desktop`. Renderer has HMR; **the kernel process does not** — my-pi / coding-agent changes need a restart of that command.

There is no opencode HTTP server, no `packages/opencode`, and no `app.opencode.ai` proxy. The UI talks to a local kernel over MessagePort.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls.
