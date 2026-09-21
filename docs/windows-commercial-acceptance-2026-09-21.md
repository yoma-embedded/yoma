# Windows 安装包与授权验收（2026-09-21）

结论：本机 Windows 构建、NSIS 隔离安装/卸载、安装后引擎与授权执行链通过；**尚不能把“全新电脑上的正式付费交付”标为完成**。本次按用户要求只验安装包与授权，不接硬件、不运行收费模型。

## 环境和被测产物

- Windows x64，系统版本 `10.0.26200.0`；Node `22.23.1`，npm `11.19.1`。
- Electron `42.3.3`，其内置 Node `24.15.0`；应用版本 `0.3.1`。
- 分支 `feature/licensing`，基线提交 `ff051e5a9943e7d90aad35505f0ae22edc09ad3c`；本次仅改验收脚本与文档，没有改产品授权策略。
- `YOMA_CHANNEL=prod`，现场生成一次性 Ed25519 密钥 `acceptance-20260921`。公钥指纹：`f2e2f9306c5db6a029b3e20bce1b514d06ae13a85def5b858ed8fd821364e8c9`。它不是正式签名身份，私钥已在验收结束后删除。
- 引擎以 `npm.cmd run engines:build -- --dist --out engines-dist` 当场构建。Python 工具已冻结；包含 STM32 本地转换器、逻辑分析仪 DLL、内嵌 Python 与解码器。
- 正常产品标识的安装包：`packages/desktop/dist/acceptance-20260921/yoma-win-x64.exe`，SHA-256 `1e0b901291b4a81f04f402475b2d4b5ec85711e774f836078c75690d828f9d1d`。
- 实际安装的是同一份 `out/` 生成的隔离验收包：产品名 `Yoma Acceptance`、appId `com.yoma.desktop.acceptance`，禁用桌面和开始菜单快捷方式。路径 `packages/desktop/dist/acceptance-isolated-20260921/yoma-win-x64.exe`，SHA-256 `1e2efb28f951d490525c42d93dd962e842ad72d7cf34aa114a518a1621d094cd`。
- 两份包都是验收产物，**不要发给客户**。隔离标识用于避免替换本机已有 Yoma；不是另一种产品授权模式。

## 实际通过的检查

所有原始日志保存在本机 `.yoma/acceptance-20260921/`（被 Git 忽略）；下表文件名相对该目录。

| 检查 | 实测结果 | 日志 |
|---|---|---|
| 全仓强制类型检查 | 11/11 包通过，0 缓存；根配置通过。修改验收脚本后根配置再通过 | `typecheck-force.log`、`typecheck-root-final.log` |
| 桌面单测 | 144 项通过（含新增 2 项入口定位回归） | `desktop-tests-all-fixed.log` |
| 内核授权单测 | 3 文件、45 项通过 | `kernel-license-tests.log` |
| 改动文件 lint | 0 警告、0 错误 | `lint-changes.log` |
| prod 构建与 NSIS 出包 | 正常标识和隔离标识均成功 | `desktop-build.log`、`package-win.log`、`package-isolated.log` |
| 四个执行入口的公钥与产物检查 | out、打包后 asar、实际安装后的 asar 均通过；与验收公钥逐把一致，未检出私钥、签发工具、运行期授权开关 | `verify-out.log`、`verify-asar-fixed.log`、`verify-installed.log` |
| NSIS 实际安装 | 静默安装返回 0；exe、app.asar、转换器文件就位 | `install.log` |
| 安装后冒烟 | 内核 21 个工具装配正常；USB 原生模块加载；6 个必需引擎运行；本地转换器 probe 通过；逻辑分析仪 demo 解出 300 条 I²C 注解 | `smoke-installed.log` |
| 安装资源边界 | 没有夹带 CubeMX 数据库、irpack 或 STM32 固件 | `smoke-installed.log` |
| 包内 preload/内核窗口桥接 | 真窗口、真 contextBridge，15 项通过（此轮针对正常标识包的 win-unpacked/app.asar） | `e2e-renderer-asar-native.log` |
| 安装后的完整授权链 | 真 IPC 34/34、真窗口桥接 13/13、真守护/turn 子进程 73/73，总计 120 项通过 | `e2e-license-installed-fixed.log` |
| 前端页面操作 | 66 项通过；首页、会话、历史波形、子 agent、草稿、手册库、调试台；零页面异常/console.error。跑的是构建 out，不是安装后的完整主程序 | `e2e-paint.log`、`paint.png` |
| NSIS 卸载 | 返回 0；测试 exe 和独立卸载注册项清除；原有 Yoma.exe 仍存在 | `uninstall.log`、`installed-registry.log` |

授权 120 项覆盖：未激活拒绝执行但允许查看/建会话/停止，坏签名拒绝导入，激活后放行授权门槛，真实等待到期，拒绝新执行，续费不重启恢复；调试台在已接受轮次结束后暂停、暂停不产生额外结果、停止进程、续费恢复且轮次连续。桌面授权放行后使用无凭据环境，因此得到的是“没有可用 provider”；它证明授权门槛已通过，**不是一次真实模型任务成功**。调试台使用假模型和无害命令。

完整授权测试前后核对 `C:\Users\admin\.yoma\license.json` 都不存在，授权读写仅落临时目录。未导入正式授权、未修改系统时间、未读取签发用的正式私钥。

## 本次发现并修复的验收缺陷

1. `verify-commercial-artifact.ts` 对 asar 入口做后缀搜索，先命中 `node_modules/electron-log/src/main/index.js`，把它误认为应用 main，导致真实包检查失败。改为只认 `main/...` 或 `out/main/...`，相对 chunk 精确解析；回归测试也验证“应用入口缺失时依赖不得冒充”和“同名 chunk 不得冒充”。
2. 授权 IPC 测试等待任意 `license.updated`，可能把延迟到达的 active 事件当成到期事件。改为等待 expired 状态，仍有 3 秒期限；实际安装后的 120 项测试全部通过。
3. `e2e:license --out` 原先只能对普通目录跑，补充直接验 `app.asar` 的能力；Node 阶段用 asar API 核查文件，Electron 从原包加载内核/preload，纯 Node 守护从 `.asar.unpacked` 加载。

Windows 操作差异：本机 PowerShell 默认命中 `npm.ps1`，它吞掉了若干 `--` 后面的参数，导致 keygen 缺参数、引擎命令误入开发构建。改用 `npm.cmd` 后正常。需要向 workspace 脚本传附加参数时直接用 `npm.cmd run <脚本> -w packages/desktop -- <参数>`，不要再经根脚本嵌套转发。

自动执行沙箱内的 Electron GPU 子进程曾报加载失败；在正常 Windows 权限和真实主进程 HOME 下复跑通过。给整个 Electron 主进程换假 HOME 的尝试也未通过。后续窗口测试保持主进程正常环境，只按既有测试接缝隔离内核配置；没有通过禁用产品安全功能来放行。

## 尚未通过的正式交付项目

- **正式签名身份**：没有提供正式可信公钥，本次是一次性验收密钥。正式公钥构建、实际客户授权文件导入仍需验证。
- **新电脑/完整界面操作**：这台机器已有开发工具和旧安装；隔离安装不能代替干净 Windows VM。尚未手动跑“正式 installer 安装 → 直接启动安装后的主程序 → 设置页选择授权文件 → 配模型 Key → 完成真实任务”。本次 renderer 授权验证通过真实 preload API，未验证设置页文件选择器。
- **随包声明遗漏**：实际安装目录有 `LICENSE.electron.txt`、`LICENSES.chromium.html` 和 `engines/data/la/LICENSE-GPLv3.txt`，但 asar 顶层没有仓库主体的 `LICENSE` / `NOTICE`，安装资源中也未找到它们；需补进打包配置并复核。逻辑分析仪对应源码与本仓补丁的交付指引也需补核。这是文件完整性检查，不是完整第三方许可审计。
- **购买联系方式**：`packages/app/src/licensing/purchase.ts` 仍为 `configured: false`，需填真实信息后再出交付包。
- **Windows 代码签名**：Authenticode 实测 `NotSigned`；builder 日志的 “signing with signtool” 不代表真的签过。本次没验证互联网下载后的 SmartScreen 体验。
- **更新/CI**：没有发布 Release、触发远端 CI，也没有验证从旧正式安装包升级、更新回滚或实际下载自动更新。
- **支持范围与硬件**：编译、烧录、探针驱动、实际故障定位与修复均不在本次范围；不能据此扩大芯片、探针或仪器的对外支持范围。

正式出货前至少补齐正式身份和随包声明，再在干净 Windows 上完成直接启动与设置页激活。板级任务单独验收。本次保留两份验收 installer、公共 trust 和日志，已卸载隔离应用并删除一次性私钥。

## 后续复用命令

下面只展示主要检查入口；正式密钥必须由维护者按 `docs/licensing.md` 管理，绝不放在仓库里。

```powershell
# Windows 下明确使用 npm.cmd。先按操作手册设置正式 YOMA_LICENSE_TRUST_FILE。
$env:YOMA_CHANNEL = 'prod'
npm.cmd run build:desktop
npm.cmd run verify:commercial -w packages/desktop
npm.cmd run engines:build -- --dist --out engines-dist
$env:YOMA_ENGINES_DIR = (Resolve-Path engines-dist).Path
npm.cmd run package:win -w packages/desktop

# 对实际安装位置核查（替换为现场路径）。
npm.cmd run verify:commercial -w packages/desktop -- --app '<安装目录>/resources/app.asar'
$env:YOMA_DESKTOP_DIR = '<安装目录>/resources/app.asar'
$env:YOMA_ENGINES_DIR = '<安装目录>/resources/engines'
npm.cmd run smoke -w packages/desktop
npm.cmd run e2e:renderer -w packages/desktop
# e2e:license 另需该测试构建对应的测试签发密钥，见其 --out/--key/--key-id 参数。
```
