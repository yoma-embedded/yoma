// 参考 pi-minimal 同名测试。适配:vitest 的 vi.stubGlobal/vi.fn/vi.spyOn
// 改为 bun:test 的 Object.defineProperty + mock + spyOn。
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { uuidv7 } from "../../src/harness/session/uuid.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// bun 与 vitest 不同,所有测试文件共享一个模块图:先跑的文件若碰过 uuidv7()
// (如 InMemorySessionStorage 构造默认 metadata id),模块级单调游标已是真实时间。
// stub 的时间戳必须比真实时间大,才能确定性地走进"新时间戳"分支。
const TIMESTAMP = 0x0abcdef01234; // ≈ 公元 2344 年

function parseTimestamp(uuid: string): number {
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
	if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
});

describe("uuidv7", () => {
	it("uses the RFC 9562 layout and preserves monotonic order", () => {
		const randomValues = [
			new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xfe, 0x01, 0x11, 0x22, 0x33, 0x44, 0x55]),
			new Uint8Array(16),
			new Uint8Array(16),
		];
		const getRandomValues = mock((bytes: Uint8Array) => {
			bytes.set(randomValues.shift() ?? new Uint8Array(bytes.length));
			return bytes;
		});
		Object.defineProperty(globalThis, "crypto", { value: { getRandomValues }, configurable: true });
		const dateNow = spyOn(Date, "now").mockReturnValue(TIMESTAMP);

		try {
			const first = uuidv7();
			const second = uuidv7();
			const third = uuidv7();

			expect(first).toBe("0abcdef0-1234-7fff-bfff-f91122334455");
			expect(second).toBe("0abcdef0-1234-7fff-bfff-fc0000000000");
			expect(third).toBe("0abcdef0-1235-7000-8000-000000000000");
			expect(first).toMatch(UUID_V7_RE);
			expect(second).toMatch(UUID_V7_RE);
			expect(third).toMatch(UUID_V7_RE);
			expect(parseTimestamp(first)).toBe(TIMESTAMP);
			expect(parseTimestamp(second)).toBe(TIMESTAMP);
			expect(parseTimestamp(third)).toBe(TIMESTAMP + 1);
			expect(first < second).toBe(true);
			expect(second < third).toBe(true);
			expect(getRandomValues).toHaveBeenCalledTimes(3);
		} finally {
			dateNow.mockRestore();
		}
	});
});
