// UUIDv7(RFC 9562):前 6 字节 = 毫秒时间戳,所以 ID 天然按时间排序 ——
// 这是会话树条目可比较、可排序的基础。
// 单调性:同一毫秒内的连续调用递增 sequence;sequence 溢出则把时间戳假装推进 1ms。
/**
 * 职责:生成一个符合 RFC 9562 的 UUIDv7 字符串(36 字符,`8-4-4-4-12`)。
 * 本文件零依赖、零 import,是 `packages/agent` 里最底层的叶子模块。
 *
 * 它在全景链路上的位置(见 docs/learn/00-内核全景.md §4):
 *   - 阶段 0 第 0.3 步「建或开会话文件」—— `session/repo-utils.ts` 的
 *     `createSessionId()` 直接返回**完整**的 uuidv7,它既是会话 id,也是 JSONL
 *     文件名的后半段(`<时间戳>_<sessionId>.jsonl`);ACP 的 `newSession` 也在这里。
 *   - 阶段 2 第 11 步以后的**每一次落盘** —— `session/session.ts` 里有 10 处
 *     `storage.createEntryId()` 调用(9 个 `append*` 方法 + `moveTo()` 的分支摘要),
 *     而两个 storage 实现的 `generateEntryId()` 都是 `uuidv7().slice(-8)`。
 *
 * 一句必须记住的话:`slice(-8)` 切走的是**最后 4 个字节**(bytes[12..15]),那一段是
 * 纯随机 —— 时间戳(bytes[0..5])和 sequence(bytes[6..10])一位都没进去。
 * 所以本文件开头那句「ID 天然按时间排序」只对**完整 uuid(会话 id)**成立,对**条目
 * id 是错的**;桌面端投影器(`packages/kernel/src/host/projector.ts`)因此不敢透传
 * 内核的条目 id,自己另铸了一套可排序的。
 *
 * 对应学习文档:docs/learn/agent/harness_session_uuid.md
 *
 * 分节索引:
 *   §1 模块级单调游标(lastTimestamp / sequence)
 *   §2 随机字节:crypto 优先,Math.random 兜底
 *   §3 uuidv7():时间戳分支与单调 sequence
 *   §4 uuidv7():16 字节按 RFC 9562 布局落位
 *   §5 formatUuid():16 字节 → 8-4-4-4-12 字符串
 */
// ── §1 模块级单调游标(lastTimestamp / sequence)──────────────────────────
// 这两个变量是**模块级全局**:同一个进程里所有调用方(会话 id、条目 id、ACP 的
// newSession)共用同一份游标 —— 这正是「单调」二字的来源,也意味着谁都改不掉它。
// 代价:测试无法把它重置,只能靠 stub `Date.now()` 到一个足够大的值才能确定性地走进
// 某个分支(见 test/harness/session-uuid.test.ts 顶部关于 bun 共享模块图的注释)。
// 初值取 -Infinity 而不是 0,是为了让**第一次**调用无论系统时钟是什么值都必定落进
// 「新毫秒」分支去播种 sequence。
let lastTimestamp = -Infinity;
// 同一毫秒内的序号。值域被下面的 `>>> 0` 钉死在 uint32(0 ~ 0xffffffff),
// §4 里的所有移位都按「它就是 32 位」这个前提切分。
let sequence = 0;

// ── §2 随机字节:crypto 优先,Math.random 兜底 ────────────────────────────
/**
 * 把 `bytes` **原地**填满随机字节。无返回值;两条路都不会抛,所以调用方拿到的数组
 * 一定是填满的。
 * @param bytes 待填充的缓冲区,长度由调用方决定(本文件里恒为 16)。
 */
function fillRandomBytes(bytes: Uint8Array): void {
	// 先把 `globalThis.crypto` 这个**对象**取出来再调它的方法,而不是把
	// `getRandomValues` 解构成裸函数 —— 后者会丢掉 `this`,在浏览器里直接抛
	// "Illegal invocation"。
	const crypto = globalThis.crypto;
	// 两重判断各挡一种宿主:`crypto?.` 挡「根本没有 globalThis.crypto」(老 Node、
	// 精简 JS 引擎),`.getRandomValues` 再挡「有 crypto 但方法缺失」的残缺实现。
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
		return;
	}
	// 兜底路径:Math.random **不是**密码学安全的,这条路上产出的 id 是可预测的。
	// 本仓的用法(会话文件名、条目 id)只要求「不撞车」,所以可以接受;
	// 但别把这里产出的 uuid 当成 token / 密钥使用。
	for (let i = 0; i < bytes.length; i++) {
		// Math.random() 的值域是 [0,1),乘 256 再向下取整正好均匀覆盖 0..255。
		bytes[i] = Math.floor(Math.random() * 256);
	}
}

// ── §3 uuidv7():时间戳分支与单调 sequence ────────────────────────────────
/**
 * 生成一个 UUIDv7 字符串。
 * 无参数;不会抛错;每次调用都会推进模块级游标(§1),所以它**不是**纯函数。
 * @returns 形如 `0abcdef0-1234-7fff-bfff-f91122334455` 的 36 字符小写十六进制串,
 *          版本位固定为 7、variant 位固定为 0b10。
 */
export function uuidv7(): string {
	// 16 字节的随机源。真正用到的只有 [6..9](给 sequence 播种)与 [10..15](随机尾),
	// [0..5] 是白取的 —— 但这样索引与输出 `bytes` 的位置一一对齐,对照 RFC 布局时
	// 不用在脑子里做偏移换算。
	const random = new Uint8Array(16);
	// 每次调用都重取随机,哪怕这次走「同一毫秒」分支、播种值用不上:
	// 尾部 6 个字节(bytes[10..15])是每次都要的。测试断言 getRandomValues 被调 3 次。
	fillRandomBytes(random);
	// 注意它只是**候选值**。真正写进 uuid 的是下面那个只增不减的 lastTimestamp。
	const timestamp = Date.now();

	// 用 `>` 而不是 `>=`:时间戳相等(同一毫秒内的连续调用)必须走 else 去递增 sequence。
	// 反过来 `timestamp < lastTimestamp`(NTP 回拨、用户改系统时间)同样落进 else,
	// 于是 uuid 里的时间戳会**停在旧的、偏大的那个值**上,直到真实时间追上来。
	// 这是刻意的取舍:宁可时间戳撒谎,也不让 ID 序倒退 —— 会话树条目的先后靠它。
	if (timestamp > lastTimestamp) {
		// noUncheckedIndexedAccess 下需要 !:random 固定 16 字节,索引必然存在。
		// 【订正】上面这句是从上游 pi-minimal 带过来的说法。本仓根 tsconfig 只开
		// `strict`,**没开** `noUncheckedIndexedAccess`(见 /tsconfig.json),
		// Uint8Array 的索引访问本来就是 `number` —— 这些 `!` 在本仓是冗余的,
		// 留着无害,但别把它当成本仓的类型要求去照抄。
		// 进入新毫秒时,sequence 用 4 个随机字节**整个**播种(而不是从 0 起数),
		// 这样相邻毫秒之间的低位不可预测,同一毫秒内也不会因为「大家都从 0 开始」
		// 而在多进程间批量撞车。代价见下面的溢出分支:播种值可能天生就贴着
		// 0xffffffff,那么几次调用之后就会绕回。
		sequence = random[6]! * 0x1000000 + random[7]! * 0x10000 + random[8]! * 0x100 + random[9]!;
		lastTimestamp = timestamp;
	} else {
		// `>>> 0` 不是装饰:它把 0xffffffff + 1 = 0x100000000 折回 0,让下一行的
		// `=== 0` 能识别溢出。删掉它 sequence 会变成 2^32 —— 后面的位运算做 ToUint32
		// 照样把它当 0 用,但溢出**检测不到**、于是不借毫秒:这一毫秒里的计数器位从
		// 0xffffffff 直接跌回 0,字符串序**倒退**,单调性静默失效。
		sequence = (sequence + 1) >>> 0;
		if (sequence === 0) {
			// 计数器绕回,只能向未来「借」一毫秒来维持严格递增。
			// 后果:此刻 uuid 里的时间戳比真实时间快 1ms(连续绕回会连续借)。
			lastTimestamp++;
		}
	}

	// ── §4 uuidv7():16 字节按 RFC 9562 布局落位 ──────────────────────────
	// 布局速查:[0..5] = 48 位毫秒时间戳;[6] 高 4 位 = 版本 7;[8] 高 2 位 = variant 0b10;
	// sequence 的 32 位摊在 [6] 低 4 位 + [7] + [8] 低 6 位 + [9] + [10] 高 6 位;
	// 剩下 [10] 低 2 位 + [11..15] 共 42 位是纯随机。
	const bytes = new Uint8Array(16);
	// 时间戳有 48 位,超出 JS 位运算的 32 位上限,所以前五行用**除法**而不是 `>>>`:
	// 写成 `lastTimestamp >>> 40` 会先被 ToInt32 截成 32 位,高 16 位全丢。
	// 末尾的 `& 0xff` 顺带把除法留下的小数部分截掉(ToInt32 向零取整)。
	// 五个除数依次是 2^40 / 2^32 / 2^24 / 2^16 / 2^8(第六行 bytes[5] 不用除)——
	// 大端序、高位在前,这就是「uuid 字符串序 == 时间序」的物理来源。
	bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
	bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
	bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
	bytes[3] = (lastTimestamp / 0x10000) & 0xff;
	bytes[4] = (lastTimestamp / 0x100) & 0xff;
	// 最低那一字节不必除:`& 0xff` 本来就只看低 32 位,直接取即可。
	bytes[5] = lastTimestamp & 0xff;
	// 版本位:高 4 位固定 0x7,低 4 位放 sequence 的第 31..28 位。
	// `& 0x0f` 在「sequence 恒为 uint32」的前提下是冗余的(`>>> 28` 最大就是 15),
	// 属于防御性掩码,留着无害。
	bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f); // 版本位 0x7
	// sequence 的第 27..20 位,填满 rand_a 的低字节。
	bytes[7] = (sequence >>> 20) & 0xff;
	// variant 位:高 2 位固定 0b10,于是这一字节只可能落在 0x80..0xbf ——
	// 十六进制首位只会是 8/9/a/b,测试里那条正则的 `[89ab]` 卡的就是它。
	// 低 6 位继续放 sequence 的第 19..14 位。
	bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f); // variant 位 0b10
	// sequence 的第 13..6 位。
	bytes[9] = (sequence >>> 6) & 0xff;
	// sequence 只剩最后 6 位,左移 2 位腾出低 2 位塞随机 —— 这是「计数器」与「随机尾」
	// 的交界字节。到这里 32 位 sequence 正好写完(4 + 8 + 6 + 8 + 6 = 32)。
	bytes[10] = ((sequence & 0x3f) << 2) | (random[10]! & 0x03);
	// [11..15] 原样搬随机。其中 [12..15] 正是 `generateEntryId()` 用 `slice(-8)`
	// 切走的那 8 个十六进制字符 —— 纯随机、零时间信息,所以短 id **不可排序**。
	bytes[11] = random[11]!;
	bytes[12] = random[12]!;
	bytes[13] = random[13]!;
	bytes[14] = random[14]!;
	bytes[15] = random[15]!;

	return formatUuid(bytes);
}

// ── §5 formatUuid():16 字节 → 8-4-4-4-12 字符串 ──────────────────────────
/**
 * 把 16 字节渲染成标准 uuid 文本。纯函数;**不校验**入参长度(唯一调用方保证是 16)。
 * @param bytes 恰好 16 字节的缓冲区。
 * @returns 小写十六进制、`8-4-4-4-12` 分组的 36 字符串。
 */
function formatUuid(bytes: Uint8Array): string {
	// padStart(2, "0") 是承重的:0x05 不补零会渲染成 "5",后面按固定宽度切片就整体错位。
	// Array.from 的第二参是 map 回调,对 TypedArray 同样有效,省掉一次中间数组。
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	// 五段切的是**十六进制字符对**(即字节),4/2/2/2/6 个字节 → 8-4-4-4-12 个字符。
	// 注意第一段是 4 个字节而不是 4 个字符 —— 时间戳的高 32 位整个落在第一组里。
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
