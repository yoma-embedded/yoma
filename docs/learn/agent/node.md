# packages/agent/src/node.ts

> **档位** B(分段) · **行数** 25(加注释后;原始代码仅 4 行) · **包** `packages/agent` = `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 · **索引** [README](../README.md)

## 1. 一句话

`@yoma/my-pi` 的 **Node 专用入口**:把浏览器安全主入口(`index.ts`)的全部导出原样转发出来,并额外多导出一个 `NodeExecutionEnv` —— 全内核唯一碰 `node:fs`/`node:child_process` 的 `ExecutionEnv` 实现。

## 2. 它在全景里的位置

这个文件本身不参与「一次 prompt 的生命周期」里的任何一步 —— 它是**装配阶段**(全景篇 §4「阶段 0:装配」)之前,调用方选哪个入口导入这一步的分岔点,不是运行时代码。

`packages/agent` 对外只开两扇门(`package.json` 的 `exports` 字段):`.` 指向 `index.ts`,`./node` 指向本文件。两者的差别只有一件事:本文件比 `index.ts` 多导出一个 `NodeExecutionEnv`(类,实现见 `harness/env/nodejs.ts`)。这么切的动机是**打包安全**——`index.ts` 里除了 `harness/env/nodejs.ts` 之外的所有子模块都不碰 Node 专属 API,所以能被安全地打进浏览器 bundle(比如未来若有浏览器端 UI 直接跑 agent-loop 的场景);而 `nodejs.ts` 整块 import 了 `node:child_process`、`node:fs`、`node:os`、`node:readline` 等模块,一旦并入主入口的 `export *`,浏览器打包器要么报错要么把这些模块硬塞进产物。

`NodeExecutionEnv` 本身是 `AgentHarnessOptions.env`(见 `harness/types.ts`)要求的 `ExecutionEnv` 接口(`FileSystem & Shell`)在 Node 运行时下的**唯一具体实现**——harness 装配时(全景篇 §4 阶段 0)如果宿主跑在 Node(桌面端内核进程、ACP 适配器、几乎所有测试),就必须从这里 `new NodeExecutionEnv({ cwd })` 造一个实例传给 `AgentHarness` 的构造函数。没有这一步,harness 就没有真正碰文件系统、起子进程的能力,读写文件、执行 bash 工具全都无从谈起。

谁在用它:生产侧最重要的调用方是 `packages/kernel/src/host/session-manager.ts:26` 和 `packages/kernel/src/host/index.ts:12`——桌面端内核进程装配 harness 的 `env` 就是从这里 `import { NodeExecutionEnv } from "@yoma/my-pi/node"` 拿到的(详见自测题 5)。`packages/coding-agent/src/acp.ts`(ACP 适配器的顶层入口)同样直接 `import { NodeExecutionEnv } from "@yoma/my-pi/node"` 来装配 `env`;`packages/coding-agent` 下几乎每一个测试文件(`acp-agent.test.ts`、`datasheet.test.ts`、`engines.test.ts`、`gdb.test.ts`、`log.test.ts`、`resources.test.ts`、`tools.test.ts` 等十余个)都走这条路径拿到一个真实文件系统的 `ExecutionEnv`。`packages/agent` 包内部的测试反而**不**走这个入口,而是直接 `import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts"` 深引用源文件——这是包内测试图省事,不代表这个转发入口不重要。

不存在会怎样:任何跑在 Node 里、需要真实文件系统/子进程能力的调用方就拿不到 `ExecutionEnv` 的具体实现,只能自己手搓一个符合接口的假对象,或者直接深引用 `harness/env/nodejs.ts`(能工作,但绕开了包的公开 API 边界,升级时容易断)。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 原始头注释 | L1–L2 | 原作者写的一句话职责(未改动) |
| 块注释 | L3–L12 | 本次补充的文件头总述:职责、全景位置、文档路径、分节索引 |
| §1 | L13–L19 | `NodeExecutionEnv` 出口:为什么它不在 `index.ts` 里 |
| §2 | L20–L25 | `index.ts` 转发:为什么要把主入口全量带出来 |

## 4. 逐节讲解

### §1 NodeExecutionEnv 出口(L13–L19)

`L19`

```ts
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
```

这是一条具名重导出。`NodeExecutionEnv` 类定义在 `harness/env/nodejs.ts`(699 行,全景篇 §6.1 点名「踩坑密度最高的一个文件」),实现 `ExecutionEnv` 接口——即 `FileSystem` 和 `Shell` 两个接口的合并(定义都在 `harness/types.ts`)。它的核心纪律是**方法永不 `throw`**:一切失败(包括意外的后端错误)都编码成 `Result<T, FileError | ExecutionError>`,Node 的 errno 在内部被映射成后端无关的错误码——这样上层 harness/工具代码可以不关心自己跑在 Node 还是别的什么后端上。

这里只做转发,不做任何包装或二次导出改名,`NodeExecutionEnv` 的构造签名、方法集合完全就是 `nodejs.ts` 里定义的那个类。

### §2 index.ts 转发(L20–L25)

`L25`

```ts
export * from "./index.ts";
```

一条 barrel 转发,把 `index.ts` 的全部导出(见下方「相邻文件」表)原样带出来。这样做的实际效果是:**任何只 `import "@yoma/my-pi/node"` 的调用方,不需要再额外 `import "@yoma/my-pi"` 去拼凑另一半导出**——两条 import 路径的并集才是完整 API 面,而 `./node` 这一条已经是超集,`.` 反而是子集。

`index.ts` 里有一处特殊处理值得记住:大部分子模块用 `export *`,但两个 compaction 模块(`branch-summarization.ts`、`compaction.ts`)改用**具名白名单**导出,原因是 compaction 模块内部还定义了与 `harness/types.ts` 同名的类型,`export *` 会产生歧义星号导出、编译报错。这条白名单规则**在 `node.ts` 这里同样生效**——因为 `node.ts` 是转发 `index.ts` 已经导出的东西,不是再做一次 `export *`,所以 `CompactionDetails` / `CompactionResult` / `CutPointResult` / `ContextUsageEstimate` 等类型**从 `@yoma/my-pi/node` 同样拿不到**,继承了 `index.ts` 那个已知的白名单缺口(全景篇 §2.2、§6.1 对此有专门记录)。

## 5. 会咬人的地方

- **`@yoma/my-pi/node` 这条 exports 深路径依赖 `package.json` 的 `exports` 字段显式声明**(`"./node": "./src/node.ts"`)。这不是自动生效的约定,是需要显式配置的深引用——如果哪天有人重构 `exports` 字段时手滑漏掉这一条,所有 `import "@yoma/my-pi/node"` 的调用方会直接编译期报「找不到模块」,而不是运行时才发现。
- **别把 `NodeExecutionEnv` 相关的实现顺手挪回 `index.ts`**——这条纪律没有写在本文件里(本文件太短,放不下这么长的说明),但全景篇 §2.2 明确写了这个二分的动机是保根入口浏览器安全。挪回去不会立刻报错,但会让 `index.ts` 的 `export *` 链条上出现 `node:child_process` 等模块的静态依赖,打浏览器 bundle 时才会炸。
- 暂无其他行号级别的坑——这个文件本身只有两行可执行代码,复杂度都在它转发的两个目标文件里。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | `packages/agent/src/harness/env/nodejs.ts` | `NodeExecutionEnv` 类的真正实现(699 行,ExecutionEnv 接口在 Node 下的唯一实现) |
| 它 import(转发) | `packages/agent/src/index.ts` | 浏览器安全主入口,`node.ts` 用 `export *` 把它的全部导出带出来 |
| 定义接口 | `packages/agent/src/harness/types.ts` | `ExecutionEnv` / `FileSystem` / `Shell` 接口定义处,`NodeExecutionEnv` 要实现的契约 |
| import 它(`/node` 深引用) | `packages/kernel/src/host/session-manager.ts`、`packages/kernel/src/host/index.ts` | 桌面端内核进程装配 harness 的 `env`,生产侧的主调用方 |
| import 它(`/node` 深引用) | `packages/coding-agent/src/acp.ts` | ACP 适配器顶层入口,`new NodeExecutionEnv({ cwd })` 装配 harness 的 `env` |
| import 它(`/node` 深引用) | `packages/coding-agent/test/*.test.ts`(十余个文件) | 几乎所有 coding-agent 测试都靠它拿到真实文件系统的 `ExecutionEnv` |
| import 它(深引用源文件,绕开本文件) | `packages/agent/test/harness/*.test.ts` | 包内测试直接 `import from "../../src/harness/env/nodejs.ts"`,不经过 `node.ts` 这层转发 |

## 7. 自测题

<details>
<summary>1. 为什么不能把 `NodeExecutionEnv` 的 `export` 也塞进 `index.ts` 的 `export *` 列表里?</summary>

因为 `NodeExecutionEnv` 定义在 `harness/env/nodejs.ts`,这个文件整块 import 了 `node:child_process`、`node:fs`、`node:os` 等 Node 专属模块。`index.ts` 是刻意维护的浏览器安全入口——一旦它间接依赖上这些模块,打浏览器 bundle 时就会因为找不到 `node:*` 的浏览器等价物而报错或体积暴涨。把它单独放进 `node.ts` 这个第二入口,是把「要不要碰 Node API」这个选择权交给调用方:纯浏览器场景 `import "@yoma/my-pi"`,Node 场景 `import "@yoma/my-pi/node"`。
</details>

<details>
<summary>2. 如果只看 `node.ts` 这 25 行代码,能不能推断出 `NodeExecutionEnv` 的方法永不 `throw`、失败一律编码成 `Result`?</summary>

不能。这条纪律写在 `harness/env/nodejs.ts` 文件头的原有注释里,`node.ts` 只是一条转发语句,不携带任何关于 `NodeExecutionEnv` 内部实现细节的信息。想了解这条纪律必须去读 `nodejs.ts` 本身(全景篇 §7 第 4 天的阅读顺序里排到它,称其为「踩坑密度最高的一个文件」)。
</details>

<details>
<summary>3. `import { CompactionResult } from "@yoma/my-pi/node"` 这行代码能编译通过吗?为什么?</summary>

不能。`index.ts` 对 compaction 模块用的是具名白名单导出(因为 compaction 模块内部有与 `harness/types.ts` 同名的类型,`export *` 会产生歧义),白名单里没有列 `CompactionResult` 这个类型。`node.ts` 只是把 `index.ts` 已经导出的东西 `export *` 转发出来,并不会额外补全这个缺口,所以这条 import 在 `/node` 路径下同样拿不到 `CompactionResult`——它只能通过深引用 `@yoma/my-pi/harness/compaction/compaction.ts`(如果 exports 里开了这条路径的话)或者直接读源码拿到。
</details>

<details>
<summary>4. 假设有人把 `package.json` 里 `"./node": "./src/node.ts"` 这一行删掉,会发生什么?哪些代码会先炸?</summary>

`packages/coding-agent/src/acp.ts` 以及十余个 `packages/coding-agent/test/*.test.ts` 文件里的 `import { NodeExecutionEnv } from "@yoma/my-pi/node"` 会在模块解析阶段直接报错(找不到该 exports 子路径),这是编译期/运行期都能立刻发现的硬失败,不是静默错误。相比之下 `packages/agent` 包内部的测试因为深引用源文件、绕开了这条 exports 路径,不会受影响。
</details>

<details>
<summary>5. 桌面端内核 host(`packages/kernel/src/host/`)要不要从 `@yoma/my-pi/node` 拿 `NodeExecutionEnv`?为什么全景篇和 CLAUDE.md 都没有直接点名它?</summary>

要,而且已核实(`grep -n NodeExecutionEnv packages/kernel/src/host/*.ts`):`packages/kernel/src/host/session-manager.ts:26` 和 `packages/kernel/src/host/index.ts:12` 都写的是 `import { NodeExecutionEnv } from "@yoma/my-pi/node"`——与 `packages/coding-agent/src/acp.ts` 用的是完全同一条深路径,不是自己另开一条。能这样写是因为 `packages/kernel/package.json` 并没有把 `@yoma/my-pi` 列进 `dependencies`(它只在 `description` 字段提了一句),这个裸说明符能解析,靠的正是 CLAUDE.md「内核接缝」一节说的别名接缝——`tsconfig.mypi.json` 的 `paths` 给 typecheck 用,`packages/kernel/mypi.ts` 的 `MY_PI_ALIASES` 给打包期用。全景篇和 CLAUDE.md 没有专门点名它,大概率只是因为这条路径和 `acp.ts` 那条同构、没有额外信息量,不是因为有疑问。
</details>

## 附:关于本文档的定位

`packages/agent/src/node.ts` 是一个纯转发文件,原始代码只有 4 行、零逻辑分支。本文档已经覆盖了它唯一需要交代清楚的东西:**为什么要有这个第二入口、它比主入口多了什么、这个多出来的东西继承了主入口的哪些已知缺口**。没有更多值得展开的「档位 A 逐行」式内容——这也是它在 README 里被标为 B 档的原因。
