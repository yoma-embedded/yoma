# 软件授权:操作手册与技术说明

首版付费桌面版的授权闭环:**演示 → 客户付款 → 开发者人工签发授权文件 → 客户导入并使用 → 续费后导入新文件**。
没有账号服务器、没有支付平台、没有硬件绑定;验签完全离线。商业口径与报价见仓库外的实施文档
(`docs/business/2026-09-20-paid-desktop-plan.md`,不入库);这份文件讲**怎么操作**与**代码怎么接的**。

> 首版明确接受的限制:离线授权可以被转发给别人、可以靠回拨系统时钟续命、客户端可以被修改后绕过
> (源码是 MIT 的,任何人都能自己构建一份不检查授权的社区版)。不承诺防破解,也不做实时吊销。
> 退款、换人、续费按订单记录人工处理。

---

## 第一部分:开发者操作(照着做)

下面的命令都在仓库根目录跑。`npm run license -- <子命令>` 就是 `tsx scripts/license.ts`,它**只在开发者电脑上用**,
不进任何安装包。

### 1. 在仓库外生成并备份正式签名密钥(只做一次)

```bash
mkdir -p ~/yoma-license-keys && chmod 700 ~/yoma-license-keys

# 建议给私钥加口令。口令只从环境变量读,不走命令行参数(参数会进 shell 历史)。
read -s YOMA_LICENSE_KEY_PASSPHRASE && export YOMA_LICENSE_KEY_PASSPHRASE

npm run license -- keygen --key-id yoma-2026-a --out-dir ~/yoma-license-keys --encrypt
```

得到三个文件:

| 文件 | 是什么 | 怎么处理 |
|---|---|---|
| `yoma-2026-a.private.pem` | **签名私钥**(权限 0600) | 永远不离开你的电脑与离线备份。不进 git、安装包、网盘同步目录、聊天记录、日志 |
| `yoma-2026-a.public.json` | 公钥 + 指纹 | 不是秘密。备份一份,指纹抄在订单清单的第一页 |
| `yoma-2026-a.trust.json` | 构建用的信任文件 | 第 2 步喂给构建 |

工具的三条保护:输出目录在任何 git 工作区里会被**拒绝**;已存在的密钥文件**绝不覆盖**;私钥内容**不上屏**。

**备份**:现在就把 `private.pem` 复制到至少两处离线介质(加密 U 盘、密码管理器的安全附件),口令另存一处。
私钥没有第二份 —— 丢了就只能换新密钥(新的 `--key-id`)并给所有客户发新版安装包;泄露了同理,而且旧密钥签出去的授权
在旧版客户端里收不回来(离线授权没有吊销)。

**编号规则**:小写字母数字开头,3–64 位。`test` / `e2e` / `dev` / `demo` / `tmp` / `sample` / `example` 开头的编号
被视为测试密钥,商业构建会拒绝信任它。

**换密钥(轮换)**:再 keygen 一把 `yoma-2027-a`,用 `npm run license -- trust --out ~/yoma-license-keys/all.trust.json
~/yoma-license-keys/yoma-2026-a.public.json ~/yoma-license-keys/yoma-2027-a.public.json` 合成一份信任文件,
新版本同时信任两把;旧授权继续有效,新授权用新钥签。

### 2. 注入正式公钥,构建商业安装包

版本(商业 / 社区)与可信公钥是**编译期常量**,由两个环境变量在**构建那一刻**决定,写死进产物:

```bash
export YOMA_EDITION=commercial
export YOMA_LICENSE_TRUST_FILE=~/yoma-license-keys/yoma-2026-a.trust.json

npm run build:desktop                      # 缺公钥 / 公钥不合法 / 是测试密钥 → 这一步直接失败
npm run verify:commercial -w packages/desktop -- --trust-file ~/yoma-license-keys/yoma-2026-a.trust.json
npm run package:mac                        # 或 package:win;商业构建会在打包前再自动跑一遍产物检查
```

- 不设 `YOMA_EDITION`(或设成 `community`)= 社区 / 开发构建:**不检查授权**。`npm run dev:desktop` 平时就是这样。
- `YOMA_EDITION=commercial` 却没有可信公钥 → **构建失败**,不会默认放行。
- 构建日志会打印 edition 与每把公钥的指纹。**发包前核对它与你备份的指纹一致。**
- `verify:commercial` 检查四个产物(`kernel.js`、`index.js`、`mailbox-host.mjs`、`mailbox-turn-entry.mjs`,连同它们
  import 的 chunk)里注入的公钥与信任文件逐把一致,且产物里没有私钥、签发工具、测试密钥、运行时开关。
  `package:*` 会在 electron-builder 之前自动跑它:环境变量说是商业构建、**或者 `out/` 里的产物本身带着注入的公钥**,
  两者有一个成立就跑全套(上一条命令带着变量 build、这一条忘了带变量就 package,也不会漏检)。
- 产物里**没有**任何环境变量或配置文件能关掉检查或追加可信公钥。上面两个变量只在构建期被读。
- CI(tag 触发的 `desktop-win.yml` / `desktop-mac.yml`):在 GitHub 仓库的 **Settings → Variables** 里设
  `YOMA_EDITION=commercial` 与 `YOMA_LICENSE_TRUST_JSON=<trust.json 的全文>`(公钥不是秘密,用 variable 不用 secret)。
  两个变量都不设 = 与今天完全一样的社区构建。**这条 CI 路径还没有在 GitHub 上真跑过。**

### 3. 收到客户付款后,签发授权

确认**实际到账**之后(999 元/人/月,模型费用另计),在订单清单里记下订单号、购买人、起止日期,然后:

```bash
export YOMA_LICENSE_KEY_PASSPHRASE   # 如果私钥加了口令:read -s YOMA_LICENSE_KEY_PASSPHRASE && export …

npm run license -- issue \
  --key ~/yoma-license-keys/yoma-2026-a.private.pem \
  --key-id yoma-2026-a \
  --license-id YOMA-2026-0001 \
  --customer "张工(深圳某某科技)" \
  --from 2026-09-20 --months 1 --tz +08:00 \
  --out ~/yoma-licenses/YOMA-2026-0001.yoma-license
```

工具会打印给人核对的有效期,例如 `2026-09-20 00:00 至 2026-10-20 24:00(UTC+08:00)`:

- 按**日历月**算,不是 30 天:9 月 20 日买一个月 = 到 10 月 20 日当天结束(含当日);1 月 31 日买一个月 = 到 2 月月末。
- 年付:`--years 1`(9,990 元/人/年)。指定结束日:`--until 2026-12-31`。`--from` 不写 = 今天。
- 文件里存的是 UTC 时间;`--tz` 决定"哪一天的 0 点"按哪个时区算,不写 = 你电脑的时区。
- `--license-id` 是订单 / 授权编号,**续费沿用同一个**。`--customer` 是购买人称呼,会显示在客户的授权页上,别写身份证号之类多余的信息。
- `--key-id` 必须是这把私钥登记的编号:工具会读私钥**同目录**下的 `*.public.json` 核对,编号拼错或拿错私钥会拒签
  (否则签得出来、客户那边却一律"授权无效")。所以私钥与它的 `public.json` 放在一起,别单独挪走私钥;
  单独挪走时工具只能提醒你人工核对指纹。
- 一次最多签 10 年(120 个月),新签与续费同一上限。
- 签完工具会自己用公钥验一遍;发给客户之前再跑一次
  `npm run license -- inspect <文件> --trust ~/yoma-license-keys/yoma-2026-a.trust.json`,看到「签名:✓ 有效」再发。

**续费**(客户再次付款之后):

```bash
npm run license -- issue \
  --key ~/yoma-license-keys/yoma-2026-a.private.pem --key-id yoma-2026-a \
  --renew ~/yoma-licenses/YOMA-2026-0001.yoma-license --months 1 --tz +08:00 \
  --out ~/yoma-licenses/YOMA-2026-0001-r1.yoma-license
```

沿用授权编号与购买人;旧授权还没到期时,新文件的生效时间沿用旧的、到期日由旧的最后一天**顺延** N 个日历月
(客户早几天续费不吃亏);旧授权已经过期则从今天重新起算。`--renew` 会先验旧文件的签名,被改过的文件不给续。
续费不需要另一套系统 —— 就是再签一份有效期更长的文件。改价不影响任何已签发的授权:价格不在授权文件里,也不参与验签。

### 4. 发给客户什么

| 发 | 不发 |
|---|---|
| 商业版安装包(dmg / exe)+ 校验和(`SHA256SUMS`) | `*.private.pem`(私钥) |
| `YOMA-2026-0001.yoma-license`(这位客户的授权文件) | `*.public.json` / `*.trust.json`(用不上,发了也没害,但没必要) |
| 上手说明(下面"客户操作"一节即可)+ 你的支持联系方式 | 订单清单、别的客户的授权文件 |

授权文件本身不含秘密(里面是购买人称呼、编号、起止时间和签名),但它就是"使用权",别贴到公开的地方。
客户的 API Key **不要**向客户要,也不进订单、授权文件或你的电脑。

### 5. 仍然需要你提供的真实信息

- **正式签名密钥**:这次实现全程用临时测试密钥,没有生成、也没有碰你的正式私钥。第 1 步要你自己做。
- **购买联系方式**:集中配置在 `packages/app/src/licensing/purchase.ts`,现在是 `configured: false`,界面显示"待配置"。
  填上真实的微信 / 邮箱 / 网址之后重新发版。价格(999 / 9,990)也只在这一个文件里。
- **订单模板、退款规则、发票安排、支持范围清单**:销售材料,不在代码里。
- **发布渠道的决定**:见第三部分"商业分发前要处理的事"第 1 条 —— 公开 Release 继续发社区版还是改发商业版,决定了自动更新会把客户带到哪。

---

## 第二部分:客户操作

### 安装与激活

1. 安装 Yoma(首次打开的系统放行步骤见 README「安装」)。
2. 打开 **设置 → 授权**,点「导入授权文件」,选开发者发来的 `.yoma-license` 文件。状态变成「已激活」,
   显示购买人、授权编号和有效期(带时区)。**不需要重启。**
3. 在 **设置 → 模型** 配置你自己的模型 API Key。**软件授权费不包含模型费用**:模型用量由你直接付给模型供应商。
4. 在 **设置 → 工具链** 核对本机工具链,然后跑一个已验证的示例。

### 续费

付款后开发者会发来一份新的 `.yoma-license`(授权编号不变、到期日更晚)。同样在「导入授权文件」里选它,立即生效;
正在因为到期而暂停的调试台任务会在下一次轮询时自己继续。早几天续费不会损失剩余天数。

### 到期时会发生什么

- **不能开始新的**对话轮次、手动压缩、调试台 / 信箱任务;界面会给出去授权页的入口。
- **正在跑的那一轮会跑完**:到期不会打断进行到一半的烧录或其他硬件操作。
- 持续运行的调试台在**当前这一轮结束后**暂停,任务状态原样保留;导入新授权后继续。
- 停止、取消、释放设备、查看历史会话与波形、导出已有数据、修改设置 —— **始终可用**,不需要授权。

### 排查

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 「授权无效:签名公钥不在可信名单里」 | 安装包与授权文件不是同一批(装的是社区版 / 旧版,或文件是别的产品的) | 重新下载开发者给的安装包;把诊断信息发给开发者 |
| 「授权无效:签名校验失败」 | 文件在传输中被改过(聊天软件转码、手动编辑过) | 让开发者重发,用文件方式传,不要复制粘贴内容 |
| 「这份授权已到期」 | 导入了旧文件 | 导入最新收到的那份 |
| 「当前授权有效期更长,无需导入」 | 同上,选错了旧文件 | 不用管,当前授权没受影响 |
| 「还没生效」 | 授权的起始日在未来,或电脑时钟不对 | 核对系统日期与时区 |
| 一直显示「未激活」 | 没导入成功,或 `~/.yoma/license.json` 被删了 | 重新导入 |
| 显示「社区 / 开发构建:不检查授权」 | 装的不是商业版安装包 | 这个构建不需要授权;要商业版请用开发者给的安装包 |

「复制诊断信息」会生成一段纯文本(应用版本、系统、授权状态、授权编号、起止时间、公钥编号、错误码、授权文件位置),
**不含** API Key、授权文件原文与购买人称呼,可以直接发给开发者。

授权文件在本机的位置:`~/.yoma/license.json`(Windows:`%USERPROFILE%\.yoma\license.json`),与模型凭据 `auth.json` 分开存放。
换电脑 / 重装系统:在新机器上重新导入同一份 `.yoma-license` 即可(首版按购买人授权,不绑硬件)。

---

## 第三部分:商业分发前要处理的事

这次实现**没有**发布任何版本、上传任何安装包、改动仓库可见性或改写任何许可证。以下事项需要你决定或处理:

1. **公开 Release 与自动更新的去向(最重要)。** 今天 tag `v*` 的流水线出的是**社区构建**,应用内的自动更新也指向
   同一个 GitHub Release。如果商业版安装包私下交付、而公开 Release 继续是社区版,那么商业版客户一次自动更新就会被换成
   不检查授权的社区版。两条自洽的路,选一条:
   (a) 给仓库设上第 2 步那两个 CI 变量,让**官方 Release 本身就是商业版**(源码仍是 MIT,自己构建的人得到社区版);
   (b) 商业版走独立的更新源 / 关掉自动更新,公开 Release 保持社区版。这次的代码没有替你选。
2. **许可证与声明。** 仓库主体是 MIT(`LICENSE`),fork 自 opencode 与 pi(`NOTICE` 已列)。MIT 允许销售,但**必须随包保留**
   版权与许可声明;已经以 MIT 发布的版本不能追溯收回,别人继续按 MIT 使用、自行构建是合法的。商业版卖的是
   "官方构建 + 授权期内的支持与更新",不是源码的独占权。
3. **GPLv3 组件。** `engines/logic-analyzer`(vendored 自 DSView)是 GPLv3,目录自带 LICENSE;Yoma 只经命令行与它对话。
   它今天只进 Windows 包(`yoma-la`)。随商业包分发它就要履行 GPLv3 的义务:附带许可证文本、提供对应源码
   (含我们的补丁 `patches/`)的获取方式。发包前确认安装包里带着它的 LICENSE 与源码指引;拿不准就先不随商业包分发它。
4. **第三方依赖的声明。** Electron / Chromium、node 模块(`usb`、`@zip.js/zip.js`、photon 等)、内嵌 CPython(随 `yoma-la`)、
   ST 的 CubeMX 数据(不分发,用户本机导入)。发包前核一遍安装包里的第三方许可文件是否齐全。
5. **代码签名。** mac 包目前是 ad-hoc 签名(首次打开要手动放行,且不能自动更新);Windows 包未签名。向付费客户交付前建议
   至少说明放行步骤,有条件再买证书。
6. **订单与合规材料。** 订单模板、退款规则、发票、隐私说明(软件不收集客户的 API Key 与工程数据)。
7. **宣传口径。** 不承诺未经对照验证的效率倍数;不承诺防破解、实时吊销或并发席位限制。

---

## 第四部分:技术说明

### 授权文件格式

```json
{ "format": "yoma-license", "version": 1, "payload": "<base64url>", "signature": "<base64url>" }
```

`payload` 是签发那一刻写下的 UTF-8 JSON **原始字节**的 base64url;`signature` 是 Ed25519(`node:crypto`)对那串字节的签名。
验签验的是解码出来的字节本身,两边都不重新序列化 JSON。payload 字段:

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 授权格式版本,现在是 `1` |
| `product` | 固定 `yoma-desktop` |
| `licenseId` | 稳定的授权编号,续费沿用 |
| `customerLabel` | 购买人称呼 |
| `issuedAt` / `notBefore` / `expiresAt` | UTC ISO 8601(以 `Z` 结尾);有效期是 `[notBefore, expiresAt)` |
| `signingKeyId` | 选择客户端内置的哪一把可信公钥 |

校验顺序:大小上限(16 KB)→ 外层结构(白名单四字段)→ 严格 base64url → 从 payload 里**只取 `signingKeyId` 当查找键**
→ 在编译期内置的可信名单里找公钥(找不到 = `unknown-key`;客户文件里不携带公钥,也就没有"自带公钥自证"这条路)
→ 验签 → 字段类型 / 产物 / 版本 / 日期关系的严格校验(多一个不认识的字段也拒)。

导入规则(`LicenseService.importText`):验不过的一律拒绝,**盘上原有授权一个字节不动**;此外"导入不能让现状变差" ——
已过期的文件不收;当前授权有效时,不收还没生效的、也不收到期更早的。写入是同目录临时文件 + fsync + rename。

### 代码位置

| 位置 | 内容 |
|---|---|
| `packages/kernel/src/license-view.ts` | 浏览器安全的状态 / 错误码 / 跨进程错误形状 |
| `packages/kernel/src/host/licensing/` | 验签、落盘、`LicenseService`(状态 / 导入 / 执行资格检查 / 诊断);**叶子门** `@yoma-desktop/kernel/host/licensing`,只依赖 node 内建 |
| `packages/kernel/src/host/licensing/policy.ts` | 编译期常量 `__YOMA_LICENSE_BUILD__` → 策略;没注入 = 社区版;注入坏了 = 商业版 + 零公钥(一律拦) |
| `packages/kernel/src/host/session-manager.ts` | `prompt()` / `compact()` 第一行检查,排在 `stop()` 之前 |
| `packages/kernel/src/host/index.ts` | `license.status` / `license.import` / `license.diagnostics`,`license.updated` 事件 |
| `packages/bench/src/` | 轮次边界暂停 / 恢复、守护启动检查(退出码 4)、`runTurn` 的代码级接缝 |
| `packages/desktop/scripts/license-build.ts` | 构建期注入的唯一生成处(`YOMA_EDITION` + 信任文件 → `define`) |
| `packages/desktop/scripts/verify-commercial-artifact.ts` | 商业产物检查 |
| `packages/desktop/src/main/mailbox-controller.ts` | 调试台启动护栏、`paused` 态、退出码 4 不重启 |
| `packages/app/src/components/settings-v2/` | 设置 → 授权 页;`packages/app/src/licensing/purchase.ts` 购买信息集中配置 |
| `scripts/license.ts` + `scripts/license/lib.ts` | 签发工具(不在任何产物入口的依赖图上) |
| `packages/desktop/scripts/e2e-license*.ts` | 授权闭环的真进程 e2e(`npm run e2e:license -w packages/desktop`) |
| `packages/kernel/src/host/license-entrypoints.test.ts` | 守门:会话间里碰 `lane.accept / drive / compact` 的方法必须先过检查且排在 `stop()` 之前;三个产物入口不许出现授权的测试接缝 |

### 能启动付费执行的入口,以及各自经过哪道检查

所有入口最终都汇到同一个点:**`SessionManager.prompt()` / `SessionManager.compact()`**(内核,Node 侧)。
界面禁用按钮只是提示,不是防线;协议里没有任何"renderer 声明自己已付费"的参数。

| 入口 | 路径 | 检查 |
|---|---|---|
| 桌面端发送 / 改上一条重发 | renderer → MessagePort → `session.prompt` | `SessionManager.prompt()` |
| 桌面端手动压缩 | `session.compact` | `SessionManager.compact()` |
| 轮内自动压缩、provider 重试 | 已接受轮次的一部分 | 不再检查(刻意) |
| 调试台 / 信箱:启动、崩溃重启 | main 的 `MailboxController.start()` → 守护 `mailbox-host.mjs` | main 护栏 + 守护启动检查(退出码 4)|
| 调试台 / 信箱:后续每一轮 | 守护 `runnerStep` / `motherStep` | 轮次边界检查 → `license-paused`;turn 子进程内还有 `SessionManager.prompt()` 兜底 |
| 打包的 turn 子进程 `mailbox-turn-entry.mjs` | `runTurn` → `createKernelHost` → `session.prompt` | `SessionManager.prompt()` |
| `yoma-bench` CLI(源码态,不进安装包) | 同守护 | 同守护(源码态是社区策略,不强制)|
| 评测入口 `packages/bench/src/eval` | `runTurn` | `SessionManager.prompt()` |

不经过检查、始终可用:`session.abort`、确认条的允许 / 拒绝、关会话(释放串口 / 探针 / 逻辑分析仪)、读历史与波形、
文件 / VCS / 工具链 / 模型与凭据设置、`license.*`、调试台的停止 / 状态 / 人工回执。

### 生命周期

- 检查只发生在**开始一次新的付费执行**的那一刻。通过之后,这一轮(含工具调用、轮内压缩、重试)跑到自然结束。
- `LicenseService` 不缓存:每次检查重新读盘 + 验签 + 对钟。于是桌面内核导入续费授权之后,**另一个进程**里暂停着的
  调试台守护下一次轮询就看得见,不需要任何进程间通知,也不需要重启。
- 调试台的暂停是一种独立的步结果(`license-paused`)与控制器状态(`paused`),不写 result / decision / verdict,
  不交给模型判断,不进指数退避;信箱状态由文件存在性推断,所以"保留状态"不需要额外的存档。
  `paused` 下按停止 = "这一单不跑了":回到 idle、原因清掉(没有进程可杀)。
- **内核没有定时器盯着到期时刻**:`license.updated` 只在有人问(`license.status` / 执行入口的检查 / 导入 / 诊断)而状态
  确实变了的时候才推。界面"到点自己变"靠的是 app 侧 `licensing/license-store.ts` 挂到 `expiresAt` / `notBefore` 的那只
  重查定时器。事件经 `StreamSink` 的 16 ms 合并窗口出去,所以不能在 RPC 响应回来的那一刻断言事件已到。
- 发送前 app 会**预检**一次(`license-notice.ts` 的 `blockedBeforeSend`):已知会被拒就不插乐观消息、不建新会话、不清输入框。
  这只是体验(插了再摘会把虚拟时间线滚到一片空白上,历史看着像没了 —— 看图看出来的),**不是防线**:查不到或被绕过,
  结果只是落回"发出去 → 内核拒 → 摘乐观消息"那条老路。排队的追加消息(轮次跑着时排进去的)仍走老路。

### 测试注入与正式产物的隔离

- 测试把策略(`licensePolicy`)与时钟(`licenseNow`)当**函数参数**传给 `createKernelHost` / `runTurn` 的 seams /
  `runMailboxHost` 的 seams。这些接缝不从 JSON 配置、命令行、环境变量取值:`TurnInput`、`MailboxHostConfig`、
  `StartCommand` 里都没有对应字段,`kernel-entry.ts` / `turn-entry.ts` / `host-entry.ts` 三个产物入口也不传它们。
- 仓库里**没有任何测试私钥**:单测与 e2e 的密钥都是现场生成的临时密钥。
- 真进程级的验证是 `npm run e2e:license -w packages/desktop`:现场生成临时密钥,经 `license-build.ts` 的
  `allowTestKeys`(**只是函数参数**,没有任何环境变量能打开它)往 `os.tmpdir()` 打一份带临时公钥的商业产物,再在真进程里
  加载它;也可以 `-- --out <desktop 目录> --key <私钥> --key-id <编号>` 对一份现成的商业 `out/` 跑。
  内核进程的 HOME 指到临时目录,整条 e2e 不碰真实的 `~/.yoma`(脚本自己在开跑前后对账)。

---

## 第五部分:已实现 / 已验证 / 尚未验证(2026-09-20)

全部验证都用**隔离的测试身份**:现场生成的临时密钥(或一把用完即删的一次性密钥)、临时 configDir / 临时 HOME、假模型、
模拟硬件(`flash` 工具配无害慢命令)。没有读取真实凭据,没有产生模型费用,没有生成或触碰正式签名私钥。

### 已实现并已验证(这台 Mac 上真跑过)

| 要求 | 证据 |
|---|---|
| 有效授权可执行;续费导入立即生效、不重启 | `license-gate.test.ts`(同一个 host 实例,经 RPC 导入);`e2e:license` 腿 1:同一个内核进程,真的等到 10 秒有效期过完 → 被拒 → 导入续费 → 再次放行 |
| 篡改 / 过期 / 未来生效 / 错误产品 / 未知公钥 / 损坏文件被拒 | `licensing.test.ts`(28 条,含"同一对象换一种 JSON 写法即验不过"、冒用可信编号、自带公钥不被信任);`e2e:license` 经真协议帧再验一遍错误码 |
| 错误导入不破坏现有授权 | `licensing.test.ts`:8 种被拒的导入之后盘上字节逐一相同、无临时文件残留;导入不能让现状变差(过期的、更早到期的、未生效顶替有效的都不收) |
| 断网仍可验证 | `licensing.test.ts` spy 住 `net.Socket.connect` / `dns.lookup` / `fetch`,验签、导入、检查全程零调用;`host/licensing/` 是只依赖 node 内建的叶子模块(有用例按 import 扫) |
| 绕过 UI 直接调执行接口也不漏检 | `license-gate.test.ts` 直接 `host.handle("session.prompt")`;`e2e:license` 腿 1 直接发 MessagePort 帧、腿 2 从真 renderer 经 contextBridge(`data._tag` 完整存活);`license-entrypoints.test.ts` 守住"新增入口必须挂检查" |
| 到期不打断已接受的硬件操作;停止与清理始终可用 | `license-gate.test.ts`:真 `flash` 子进程跑着时把时钟拨过到期 → 工具 completed、轮次正常到 idle;到期后 `session.abort` 照常;没授权的新请求打不断在飞轮次(变异:把检查挪到 `stop()` 之后恰好这一条变红) |
| 调试台到期暂停、续费恢复(真实进程) | `e2e:license` 腿 3:真守护 + 真 turn 子进程 + 假模型 + **真的短有效期授权**。到期时刻落在第 2 轮之内 → 那一轮照常回填 → 两侧在轮次边界 `license-paused`(8 个轮询周期内远端提交数、轮次数不再增长,无 verdict,守护活着、未进退避)→ 暂停期间 SIGTERM 干净停下 → 过期时重启被拒(退出码 4)→ 导入续费 → 一直活着的守护**不重启自己恢复** → 跑到终局,轮次编号连续、每轮只跑一次 |
| 商业产物不含私钥 / 签发工具 / 测试密钥 / 绕过开关;缺公钥构建失败 | `YOMA_EDITION=commercial` 无公钥 → 构建非零退出;一次性密钥的商业构建 `verify:commercial` 六项全过;社区产物被判不合格;换一把钥匙的 trust 文件核同一份产物 → 红 |
| 授权页、激活提示、购买信息 | 截图工装对商业构建看过未激活 / 已激活 / 已到期 / 授权无效四种状态、购买块、发送被拒的提示(历史仍可见、输入保留) |

数字:`e2e:license` 三条腿 34 / 13 / 73 共 120 条断言;变异自检(注释掉 `prompt()` 的检查)腿 1、腿 2 变红。

### 尚未验证(如实)

- **Windows 一行都没跑过。** 授权文件的 rename 重试、`taskkill` 停守护、`e2e:license`、商业构建与产物检查都只在 macOS 上验过。
- **正式安装包。** 没有执行 `package:mac` / `package:win`:`verify:commercial --app <.app|app.asar>` 那条路只有单测;
  "新电脑用正式安装包导入授权 → 配 Key → 真实板级任务"没有做。
- **CI。** 两条 workflow 的变量透传只确认了 YAML 可解析,没有在 GitHub 上真跑。
- **真机。** 到期不打断烧录用的是模拟硬件(真 `flash` 工具 + 无害命令),没有接真探针;信箱的暂停 / 恢复没有双机真跑 ——
  按实施文档的约定,首发不要把实验性的远程闭环列入正式支持范围。
- **调试台的暂停横幅没有看图**(点"开始"会经过 main,而 main 读的是真实 HOME;为了不碰真实 `~/.yoma` 没有做)。
  它的决策逻辑有单测,样式没看过。英文界面也没有看图。
- **排队的追加消息**在授权失效时仍走"发出去 → 内核拒"的老路,时间线可能短暂滚到空白处(内容都在,滚回去即可)。
- 首版接受的限制不在"未验证"之列:转发、时钟回拨、修改客户端、自行构建社区版,都不防。
