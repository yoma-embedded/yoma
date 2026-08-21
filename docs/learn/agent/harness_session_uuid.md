# packages/agent/src/harness/session/uuid.ts

> **档位** A(逐行) · **行数** 172(加注释后;原 58) · **包** `@yoma/my-pi`(`packages/agent`)
> **上游** [全景篇](../00-内核全景.md) §4 阶段 0 / 阶段 2、§5.2 接线表、§6.1 会咬人的地方 · **索引** [README](../README.md)

## 1. 一句话

手写一个 RFC 9562 的 **UUIDv7** 生成器 —— 前 6 字节是毫秒时间戳、中间 32 位是同毫秒内只增不减的计数器、尾部是随机,于是**完整 uuid 的字符串序就是时间序**;整个 agent 包里凡是要「铸一个 id」的地方,最后都落到这里的 `uuidv7()`。

## 2. 它在全景里的位置

先把名词摊开:**会话(session)** 是「一次对话」的持久化外壳;会话里的每一条内容(用户消息、assistant 消息、换模型、压缩记录……)叫一条**条目(entry)**,条目之间用 `parentId` 串成一棵**会话树**。树上每个节点都要一个 id,会话本身也要一个 id —— 这两种 id 全部由本文件产出。

对着全景篇 §4 的编号时间线看,它出现在两个位置:

- **阶段 0 第 0.3 步「建或开会话文件」**。`session/repo-utils.ts` 的 `createSessionId()` 就是 `return uuidv7()`,拿到的是**完整的 36 字符**。这个值有两个身份:会话元数据里的 `id`,以及 JSONL 会话文件名的后半段(`jsonl-repo.ts:177`,格式是 `<时间戳>_<sessionId>.jsonl`)。`coding-agent/src/acp/agent.ts:331` 的 `newSession` 也是直接 `const sessionId = uuidv7()` 再交给 `repo.create({ cwd, id: sessionId })`。
- **阶段 2 第 11 步之后的每一次落盘**。`agent-harness.ts` 的 `handleAgentEvent` 收到 `message_end` 就调 `session.appendMessage()`;`session/session.ts` 里 **9 个 `append*` 方法**(外加 `moveTo()` 里的分支摘要,共 **10 处** `createEntryId()` 调用)的第一件事都是 `id: await this.storage.createEntryId()`。两个 storage 实现(`jsonl-storage.ts:100` 与 `memory-storage.ts:79`)的 `generateEntryId()` 长得一模一样:`uuidv7().slice(-8)`,撞车就重试,连撞 100 次才回落到完整的 `uuidv7()`。

**它调谁**:谁也不调。零 `import`、零依赖,只用 `globalThis.crypto` 和 `Date.now()`,是 `packages/agent` 里最底层的叶子模块。

**不存在会怎样**:会话建不出来(没有 id 就没有文件名),条目挂不上树(`parentId` 指向空),整条主链在阶段 0 第 0.3 步就断。

**但有一个必须先记住的落差**:`slice(-8)` 切走的是最后 4 个字节,而那 4 个字节是**纯随机** —— 时间戳和计数器一位都没进去。所以「按时间排序」这个卖点只对**完整 uuid(会话 id)**成立,对**条目 id 是错的**。这正是全景篇 §5.5 那条接线的来历:桌面端投影器(`packages/kernel/src/host/projector.ts`)不敢透传内核的条目 id,自己另铸了一套可排序的(`packages/kernel/src/ids.ts`)。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 文件头 | L1–L30 | 原有 3 行头注释 + 新增块注释:职责、全景锚点、`slice(-8)` 的警告、分节索引 |
| §1 | L31–L42 | 模块级单调游标 `lastTimestamp` / `sequence` |
| §2 | L43–L68 | `fillRandomBytes()`:crypto 优先,`Math.random` 兜底 |
| §3 | L69–L115 | `uuidv7()` 前半:取随机、取时间戳,「新毫秒」与「同毫秒」两条分支 |
| §4 | L116–L158 | `uuidv7()` 后半:16 字节按 RFC 9562 布局逐字节落位 |
| §5 | L159–L172 | `formatUuid()`:16 字节 → `8-4-4-4-12` 字符串 |

## 4. 逐节讲解

### 先看一眼 UUIDv7 长什么样

一个 uuid 是 **16 字节**,渲染成 36 个字符(32 个十六进制字符 + 4 个连字符),分组是 `8-4-4-4-12`。

以 `session-uuid.test.ts` 里第一个确定值 `0abcdef0-1234-7fff-bfff-f91122334455` 为例,五个分组对应的字节与内容是:

| uuid 分组 | 字节 | 装的是什么 |
|---|---|---|
| `0abcdef0` | `bytes[0..3]` | 48 位毫秒时间戳的**高 32 位** |
| `1234` | `bytes[4..5]` | 时间戳的**低 16 位**(至此 48 位写完) |
| `7fff` | `bytes[6..7]` | 首字符固定 `7`(版本位)+ `sequence` 的 31..20 位 |
| `bfff` | `bytes[8..9]` | 首字符只能是 `8/9/a/b`(variant `0b10`)+ `sequence` 的 19..6 位 |
| `f91122334455` | `bytes[10..15]` | `sequence` 的 5..0 位(挤在第一个字节的高 6 位)+ 42 位纯随机 |

注意**分组边界与字节边界不重合**:第一个连字符落在 `bytes[3]` 与 `bytes[4]` 之间,而时间戳一直延伸到 `bytes[5]`;`sequence` 也横跨第三、四、五三个分组。

RFC 9562 对 UUIDv7 的硬性规定只有三条:

1. `bytes[0..5]` = 48 位大端毫秒 Unix 时间戳;
2. `bytes[6]` 的**高 4 位**必须是 `0b0111`(版本 7);
3. `bytes[8]` 的**高 2 位**必须是 `0b10`(variant)。

剩下 74 位(`bytes[6]` 低 4 位 + `bytes[7]` + `bytes[8]` 低 6 位 + `bytes[9..15]`)可以随机,也可以拿来放一个**同毫秒内的计数器**以保证单调 —— 本文件走的是后者:**前 32 位放计数器,后 42 位放随机**。

### §1 模块级单调游标(L31–L42)

`L38–L41`

```ts
let lastTimestamp = -Infinity;
// 同一毫秒内的序号。值域被下面的 `>>> 0` 钉死在 uint32(0 ~ 0xffffffff),
// §4 里的所有移位都按「它就是 32 位」这个前提切分。
let sequence = 0;
```

两个**模块级**变量。模块级意味着:同一个进程里所有调用方(会话 id、条目 id、ACP 的 `newSession`)共用这一份游标 —— 单调性就是从这里来的,同时也没有任何人能重置它。

`lastTimestamp` 初值取 `-Infinity` 而不是 `0`,是为了让**第一次**调用无论系统时钟是什么值都必定落进下面的「新毫秒」分支,去给 `sequence` 播种。

这份全局状态有一个直接的测试后果:`packages/agent/test/harness/session-uuid.test.ts` 顶部专门写了一段注释解释 —— bun 与 vitest 不同,**所有测试文件共享一个模块图**,先跑的测试文件只要碰过 `uuidv7()`(例如 `InMemorySessionStorage` 构造默认 metadata 时会碰),`lastTimestamp` 就已经是真实时间了。所以那个测试 stub 的时间戳必须**比真实时间大**:

```ts
const TIMESTAMP = 0x0abcdef01234; // ≈ 公元 2344 年
```

### §2 随机字节:crypto 优先,Math.random 兜底(L43–L68)

`L53–L59`

```ts
	const crypto = globalThis.crypto;
	// 两重判断各挡一种宿主:...
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
		return;
	}
```

`fillRandomBytes(bytes)` 把传进来的 `Uint8Array` **原地**填满随机字节,没有返回值。

两个细节值得停一下:

- **为什么先取对象再调方法**,而不是 `const { getRandomValues } = globalThis.crypto`?因为 WebCrypto 的 `getRandomValues` 依赖 `this` 绑定到 `crypto` 对象,解构成裸函数后在浏览器里会直接抛 `Illegal invocation`。
- **为什么判两层**?`crypto?.` 挡的是「宿主根本没有 `globalThis.crypto`」(老 Node、精简 JS 引擎),`.getRandomValues` 再挡「有 `crypto` 但方法缺失」的残缺实现。

`L64–L65`

```ts
		// Math.random() 的值域是 [0,1),乘 256 再向下取整正好均匀覆盖 0..255。
		bytes[i] = Math.floor(Math.random() * 256);
```

兜底路径。`Math.random()` 的值域是 `[0, 1)`,乘 256 向下取整正好均匀覆盖 `0..255`。但它**不是密码学安全的** —— 这条路上产出的 uuid 是可预测的。对本仓的用法(会话文件名、条目 id)只要求「不撞车」,可以接受;别把它当 token 用。

### §3 uuidv7():时间戳分支与单调 sequence(L69–L115)

`L80–L85`

```ts
	const random = new Uint8Array(16);
	// 每次调用都重取随机,哪怕这次走「同一毫秒」分支、播种值用不上:
	// 尾部 6 个字节(bytes[10..15])是每次都要的。测试断言 getRandomValues 被调 3 次。
	fillRandomBytes(random);
	// 注意它只是**候选值**。真正写进 uuid 的是下面那个只增不减的 lastTimestamp。
	const timestamp = Date.now();
```

申请 16 字节随机源。真正用到的只有 `random[6..9]`(给 `sequence` 播种)和 `random[10..15]`(随机尾),`random[0..5]` 白取了 —— 但这样**索引与输出 `bytes` 的位置一一对齐**,对照 RFC 布局时不用在脑子里做偏移换算。

`timestamp` 只是**候选值**。真正写进 uuid 的是 `lastTimestamp`,而它只增不减。

`L91–L103`

```ts
	if (timestamp > lastTimestamp) {
		// noUncheckedIndexedAccess 下需要 !:random 固定 16 字节,索引必然存在。
		...
		sequence = random[6]! * 0x1000000 + random[7]! * 0x10000 + random[8]! * 0x100 + random[9]!;
		lastTimestamp = timestamp;
	} else {
```

(注:那句 `noUncheckedIndexedAccess 下需要 !` 是随代码从上游 pi-minimal 带过来的,**本仓并没有开这个编译选项** —— 根 `tsconfig.json` 只有 `strict`。`Uint8Array` 的索引访问本来就是 `number`,所以这些 `!` 在本仓是冗余的。)

**「新毫秒」分支。** 用 4 个随机字节拼成一个完整的 32 位数给 `sequence` 播种 —— 注意是**整个随机**,不是从 0 起数。好处是相邻毫秒之间的计数器低位不可预测,多进程同毫秒也不会因为「大家都从 0 开始」而批量撞在一起;代价见下面的溢出分支:播种值可能天生就贴着 `0xffffffff`,那么这一毫秒里几次调用之后就会绕回。

条件用的是 `>` 而不是 `>=`,这一个字符管着两件事:

1. **时间戳相等**(同一毫秒内的连续调用)落进 `else`,去递增 `sequence` —— 单调性靠它;
2. **时间戳变小**(NTP 回拨、用户改系统时间)**同样**落进 `else`。于是 uuid 里的时间戳会停在旧的、偏大的那个值上,直到真实时间追上来。这是刻意的取舍:**宁可时间戳撒谎,也不让 ID 序倒退**。

`L104–L113`

```ts
		sequence = (sequence + 1) >>> 0;
		if (sequence === 0) {
			// 计数器绕回,只能向未来「借」一毫秒来维持严格递增。
			lastTimestamp++;
		}
```

**「同毫秒 / 时钟回拨」分支。**

`>>> 0` 不是装饰:JS 的 `>>>` 会把左操作数按 **ToUint32** 折进 32 位,于是 `0xffffffff + 1 = 0x100000000` 被折成 `0`,下一行的 `=== 0` 才识别得出溢出。删掉它,`sequence` 会变成 `2^32`(一个普通浮点数)并继续 `+1` 往上加 —— 后面所有位运算先做 `ToUint32`,于是 `2^32` 被当成 `0`、`2^32+1` 被当成 `1`……,但 `=== 0` 永远不成立,于是**不借毫秒**,这个 id 的计数器位与「`sequence` 恰为 0」时完全一样,同一毫秒内的排序直接倒退。

`lastTimestamp++` 是计数器绕回时唯一的出路:向未来「借」一毫秒。后果是此刻 uuid 里的时间戳比真实时间快 1ms(连续绕回会连续借)。

### §4 uuidv7():16 字节按 RFC 9562 布局落位(L116–L158)

`L126–L132`

```ts
	bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
	bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
	bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
	bytes[3] = (lastTimestamp / 0x10000) & 0xff;
	bytes[4] = (lastTimestamp / 0x100) & 0xff;
	// 最低那一字节不必除:`& 0xff` 本来就只看低 32 位,直接取即可。
	bytes[5] = lastTimestamp & 0xff;
```

48 位时间戳,大端序、高位在前。**前五行为什么用除法而不是 `>>>`**(`bytes[5]` 取的是最低字节,`& 0xff` 就够,不需要除):JS 的位运算一律先把操作数截成 32 位,`lastTimestamp >>> 40` 会把高 16 位整个丢掉。除法走的是 double 的 53 位有效位,48 位时间戳完全装得下。末尾的 `& 0xff` 除了取低 8 位,还顺带把除法留下的小数部分截掉(`ToInt32` 向零取整)。

五个除数依次是 `2^40 / 2^32 / 2^24 / 2^16 / 2^8`,第六行 `bytes[5]` 不必除。**这六行就是「uuid 字符串序 == 时间序」的物理来源** —— 时间戳在最前面,而定宽十六进制的字典序恰好等于数值序。

`L133–L147`

```ts
	bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f); // 版本位 0x7
	// sequence 的第 27..20 位,填满 rand_a 的低字节。
	bytes[7] = (sequence >>> 20) & 0xff;
	...
	bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f); // variant 位 0b10
	// sequence 的第 13..6 位。
	bytes[9] = (sequence >>> 6) & 0xff;
	...
	bytes[10] = ((sequence & 0x3f) << 2) | (random[10]! & 0x03);
```

32 位 `sequence` 被切成五段,塞进版本位和 variant 位留下的缝隙里:

| 字节 | 高位固定值 | 装 sequence 的哪几位 | 位数 |
|---|---|---|---:|
| `bytes[6]` | 高 4 位 `0x7`(版本) | 31..28 | 4 |
| `bytes[7]` | — | 27..20 | 8 |
| `bytes[8]` | 高 2 位 `0b10`(variant) | 19..14 | 6 |
| `bytes[9]` | — | 13..6 | 8 |
| `bytes[10]` | — | 5..0(左移 2 位) | 6 |

`4 + 8 + 6 + 8 + 6 = 32`,正好写完。**顺序是从高位到低位、从靠前的字节到靠后的字节** —— 这是关键:计数器的高位在靠前的字节里,所以同一毫秒内 `sequence` 加一,渲染出来的字符串**也**是递增的。测试里的 `expect(first < second).toBe(true)` 钉的就是这条。

两个小注解:

- `bytes[6]` 里的 `& 0x0f` 在「`sequence` 恒为 uint32」这个前提下是**冗余**的(`>>> 28` 的结果最大就是 15),属于防御性掩码,留着无害。
- `bytes[8] = 0x80 | (… & 0x3f)` 的取值范围只能是 `0x80..0xbf`,所以这一字节的十六进制首位只会是 `8/9/a/b` —— 测试里那条正则 `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` 中的 `[89ab]` 卡的就是它。

`L150–L154`

```ts
	bytes[11] = random[11]!;
	bytes[12] = random[12]!;
	bytes[13] = random[13]!;
	bytes[14] = random[14]!;
	bytes[15] = random[15]!;
```

随机尾。加上 `bytes[10]` 的低 2 位,一共 **42 位随机**。

**这一段是全文最该记住的地方**:`bytes[12..15]` 渲染出来正好是最后 8 个十六进制字符,也就是 `generateEntryId()` 用 `slice(-8)` 切走的那一段 —— **纯随机、零时间信息**。条目 id 因此只有 32 位熵,而且完全不可排序。

一个便于验算的例子(直接取自 `session-uuid.test.ts`:`Date.now()` 被 stub 成 `0x0abcdef01234`,首次随机字节被 stub 成 `[0,0,0,0,0,0, 0xff,0xff,0xff,0xfe, 0x01, 0x11,0x22,0x33,0x44,0x55]`,后两次全 0):

| 第几次调用 | 走哪条分支 | `sequence` | 结果 |
|---|---|---|---|
| 1 | 新毫秒(播种) | `0xfffffffe` | `0abcdef0-1234-7fff-bfff-f91122334455` |
| 2 | 同毫秒(+1) | `0xffffffff` | `0abcdef0-1234-7fff-bfff-fc0000000000` |
| 3 | 同毫秒(溢出 → 借 1ms) | `0x00000000` | `0abcdef0-1235-7000-8000-000000000000` |

第 3 次的时间戳段从 `…1234` 变成 `…1235`,而 `Date.now()` 一直是 `0x0abcdef01234` —— 那 1ms 就是借来的。三个值严格递增。

### §5 formatUuid():16 字节 → 8-4-4-4-12 字符串(L159–L172)

`L168–L171`

```ts
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	// 五段切的是**十六进制字符对**(即字节),4/2/2/2/6 个字节 → 8-4-4-4-12 个字符。
	// 注意第一段是 4 个字节而不是 4 个字符 —— 时间戳的高 32 位整个落在第一组里。
	return `...`; // 见源码 L171,五段 slice + join 拼成 8-4-4-4-12
```

纯函数,不校验入参长度(唯一调用方保证是 16 字节)。

`padStart(2, "0")` 是**承重**的:`0x05` 不补零会渲染成 `"5"`,后面按固定宽度切片就整体错位、吐出一个短一截的畸形 uuid。

`Array.from` 的第二个参数是 map 回调,对 `Uint8Array` 同样有效 —— 省掉一次「先转数组再 map」的中间数组。

五段切片切的是**字节**而不是字符:`4 / 2 / 2 / 2 / 6` 个字节,渲染成 `8-4-4-4-12` 个十六进制字符。

## 5. 会咬人的地方

- **【与注释不符】L1–L2 的「ID 天然按时间排序」对条目 id 是错的。** 头注释这句话只对**完整 uuid**成立。两个 storage 的 `generateEntryId()`(`jsonl-storage.ts:100`、`memory-storage.ts:79`)取的是 `.slice(-8)`,对应本文件 L151–L154 的 `bytes[12..15]`,**纯随机、32 位熵、不可排序**。全景篇 §6.1 已把它记为【CM】,后果是投影器不变式 2:`packages/kernel/src/ids.ts` 另铸了一套可排序 id,因为前端每个集合都用 `Binary.search` 按 id 字符串序维护。
- **L31–L41 的单调保护只在单个进程生命周期内有效。** `lastTimestamp` 是模块级变量,进程一退就没了、下次启动重置回 `-Infinity`。所以「时钟回拨时时间戳停在旧值」这条保护**跨不过进程边界** —— 机器时钟被拨回再重启,新铸的 uuid 会排在旧 uuid 前面。(会话列表这一侧被吸收掉了:`JsonlSessionRepo.list()` 按 header 里的 `createdAt` 排序(倒序,新的在前),不按 id 也不按文件名排。)
- **L108 的 `>>> 0` 是承重的,不是风格。** 去掉它,`sequence` 溢出后变成 `2^32`,`=== 0` 永不成立 → 不借毫秒 → 位运算做 ToUint32 又把它当 `0` 用 → 同一毫秒内计数器位从 `0xffffffff` 直接跌回 `0`。不会重复,但字符串序**倒退**,单调性静默失效。
- **L97–L101 的播种是全 32 位随机,不留余量。** 播种值有一定概率天生就贴着 `0xffffffff`,那么这一毫秒里几次调用就会绕回、开始借未来的毫秒。表现是 uuid 里的时间戳略微超前于真实时间 —— 不会出错,但如果有人拿 uuid 里的时间戳当审计时间用,那个值不等于 `Date.now()`。
- **L60–L66 的兜底路径不安全。** 宿主没有 `globalThis.crypto` 时回落到 `Math.random()`,产出的 uuid 可预测。本仓的两个宿主(Electron utilityProcess、Node)都有 WebCrypto,所以实践中走不到;但如果哪天把这段代码搬进一个精简运行时,它会**静默**降级,不报错、不告警。
- **L87–L90:uuid 里的时间戳会撒谎。** 时钟回拨期间,48 位时间戳保持在旧值不动。别把 uuid 前 12 个十六进制字符解析出来当「这条记录的真实创建时间」——`session/repo-utils.ts` 的 `createTimestamp()`(独立的 `new Date().toISOString()`)才是记账用的那个时间。顺带一提,这两者是**两次独立取时**,可能差几毫秒(全景篇 §6.1 已记)。
- **`generateEntryId()` 连撞 100 次会返回完整 36 字符**(不在本文件,但由本文件的输出决定)。同一个会话里因此可能混着 8 字符和 36 字符两种长度的条目 id —— 任何按长度做假设的解析都会翻车。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import | — | **零依赖**。只用 `globalThis.crypto` 与 `Date.now()`,是 `packages/agent` 的叶子模块 |
| import 它 | `packages/agent/src/harness/session/repo-utils.ts:35`(`createSessionId()` 在 :46) | `createSessionId()` 直接返回**完整** uuidv7 —— 会话 id + JSONL 文件名后半段 |
| import 它 | `packages/agent/src/harness/session/jsonl-storage.ts:38`(`generateEntryId()` 在 :100) | `generateEntryId()` = `uuidv7().slice(-8)`,撞车重试 100 次后回落完整值 |
| import 它 | `packages/agent/src/harness/session/memory-storage.ts:40`(`generateEntryId()` 在 :79) | 同上;另外构造函数默认的 `metadata.id` 用的是**完整** uuidv7 |
| import 它 | `packages/agent/src/index.ts:104` | 包根 barrel 再导出,所以宿主也能直接 `import { uuidv7 } from "@yoma/my-pi"` |
| import 它 | `packages/coding-agent/src/acp/agent.ts:28,331` | ACP 的 `newSession` 自己铸 sessionId 再交给 `repo.create` |
| 测试 | `packages/agent/test/harness/session-uuid.test.ts` | 唯一的测试:字节布局 + 单调性 + 溢出借毫秒,三次调用三个确定值 |
| 因它而存在 | `packages/kernel/src/ids.ts` | 不 import 它。恰恰因为短 id 不可排序,桌面端 host 另铸了一套 opencode 格式的可排序 id |

## 7. 自测题

**Q1.** 把 L91 的 `if (timestamp > lastTimestamp)` 改成 `>=`,会发生什么?

<details><summary>答案</summary>

同一毫秒内的第二次调用会落进「新毫秒」分支,用随机字节**重新播种** `sequence`。新播种值与上一次毫无关系,可能更小 —— 于是同毫秒内产出的 uuid 不再单调递增。`session-uuid.test.ts` 里的 `expect(first < second).toBe(true)` 会**确定性地**失败 —— 那个测试把第 2、3 次的随机字节 stub 成全 0,重新播种得到的 `sequence` 是 `0`,比第一次的 `0xfffffffe` 小得多。真实随机下则是约一半概率失败。

更本质的:UUIDv7 的「同毫秒也有序」完全靠这个 `>` 把相等的情况赶进 `else` 去 `+1`。改成 `>=` 等于把它降级成「只保证毫秒级有序」。

</details>

**Q2.** 删掉 L108 的 `>>> 0`(写成 `sequence = sequence + 1`),会发生什么?

<details><summary>答案</summary>

`sequence` 到 `0xffffffff` 之后变成 `4294967296`(即 `2^32`),而不是折回 `0`(再往后是 `2^32+1`、`2^32+2`……)。于是:

1. `if (sequence === 0)` 永不成立 → **不再借毫秒**,`lastTimestamp` 停住;
2. 但 `sequence >>> 28`、`>>> 20` 等位运算会先做 `ToUint32`,把 `2^32` 折成 `0` —— 位模式跟「`sequence` 恰好是 0」时一模一样。

结果:溢出后的这个 uuid 的计数器位全是 0,**比上一个(`0xffffffff`)小**,同一毫秒内排序倒退,而且没有任何报错。注意它并**不会**产出重复 id —— 后续的 `2^32+1`、`2^32+2` 折成 `1`、`2`,位模式各不相同,坏掉的只有顺序。这就是 `>>> 0` 存在的唯一理由 —— 它让溢出**可被检测**。

</details>

**Q3.** `generateEntryId()` 用的是 `uuidv7().slice(-8)`。如果改成 `slice(0, 8)`(取头 8 个字符),会发生什么?

<details><summary>答案</summary>

头 8 个十六进制字符 = `bytes[0..3]` = 48 位时间戳的**高 32 位**。它每 `2^16` 毫秒(约 65.5 秒)才变一次。

于是同一个会话里一分钟内产出的条目会拿到**完全相同**的候选 id,`generateEntryId()` 的 100 次重试全部撞车,每次都走到最后那行 `return uuidv7()` —— 返回完整的 36 字符。表现是:条目 id 忽长忽短,而且每铸一个 id 要白跑 100 次。

`slice(-8)` 取随机尾正是为了避开这一点(`jsonl-storage.ts:104` 的注释写着「uuidv7 前缀是时间戳、两次调用间几乎不变,短 ID 必须取随机尾部」),代价就是 §5 第一条说的:短 id 不可排序。

</details>

**Q4.** 某次调用播种出的 `sequence` 恰好是 `0xfffffff0`,然后同一毫秒内又连续调用了 20 次。第 21 个 uuid 里的时间戳是多少?

<details><summary>答案</summary>

第 1~16 次递增到 `0xffffffff`;第 17 次 `>>> 0` 折回 `0` → `lastTimestamp++`,时间戳变成 `Date.now() + 1`。之后第 18~21 次继续 `+1`(1、2、3、4),都不再溢出。

所以第 21 个 uuid 的时间戳是 **`Date.now() + 1`** —— 比真实时间快 1 毫秒。21 个 uuid 全部严格递增,没有重复。这就是「向未来借一毫秒」的实际含义。

</details>

**Q5.** L53 写的是 `const crypto = globalThis.crypto;`,然后 `crypto.getRandomValues(bytes)`。如果改写成 `const { getRandomValues } = globalThis.crypto; getRandomValues(bytes);`,会发生什么?

<details><summary>答案</summary>

在浏览器(以及按 WebCrypto 规范实现的运行时)里会抛 `TypeError: Illegal invocation`。`getRandomValues` 是 `Crypto` 接口上的方法,规范要求它的 `this` 是一个 `Crypto` 实例;解构成裸函数后 `this` 变成 `undefined`,实现里的 brand check 直接拒绝。

顺带一提,这也是为什么 `if (crypto?.getRandomValues)` 这个判断只能写成「读属性看真假」而不能提前解构 —— 读属性是安全的,调用才要求绑定。

</details>
