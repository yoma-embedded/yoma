// 凭证独立性验收:FileCredentialStore 的读写与权限,resolveModel 的
// auth.json/环境变量/settings.json 选择顺序,以及请求时 getAuth 的热更新语义。
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FileCredentialStore, resolveModel } from "../src/acp/models.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `my-pi-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

// 开发机上真实存在的 key 环境变量会污染选择逻辑,逐个摘掉、用完还原。
const ENV_KEYS = ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "MY_PI_PROVIDER", "MY_PI_MODEL"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function writeAuth(configDir: string, auth: unknown): void {
	writeFileSync(join(configDir, "auth.json"), JSON.stringify(auth));
}

describe("FileCredentialStore", () => {
	it("returns undefined for missing files and survives corrupt JSON", async () => {
		const dir = createTempDir();
		const store = new FileCredentialStore(join(dir, "auth.json"));
		expect(await store.read("deepseek")).toBeUndefined();

		writeFileSync(join(dir, "auth.json"), "not json{");
		expect(await store.read("deepseek")).toBeUndefined();
	});

	it("stores credentials with 0600 permissions and reads them back", async () => {
		const dir = createTempDir();
		const path = join(dir, "auth.json");
		const store = new FileCredentialStore(path);

		await store.modify("deepseek", async () => ({ type: "api_key", key: "sk-test" }));

		expect(await store.read("deepseek")).toEqual({ type: "api_key", key: "sk-test" });
		// NTFS 没有 POSIX 权限位(Windows 上 Node 恒报 0666/0444),0600 只在 POSIX 下可断言。
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("modify preserves other providers and delete removes only the target", async () => {
		const dir = createTempDir();
		const store = new FileCredentialStore(join(dir, "auth.json"));

		await store.modify("deepseek", async () => ({ type: "api_key", key: "sk-a" }));
		await store.modify("moonshotai-cn", async () => ({ type: "api_key", key: "sk-b" }));
		await store.delete("deepseek");

		expect(await store.read("deepseek")).toBeUndefined();
		expect(await store.read("moonshotai-cn")).toEqual({ type: "api_key", key: "sk-b" });
	});
});

describe("resolveModel", () => {
	it("picks the first stored-key provider and registers only credentialed ones", async () => {
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { type: "api_key", key: "sk-d" } });

		const { models, model } = await resolveModel(dir);

		expect(model.provider).toBe("deepseek");
		expect(model.id).toBe("deepseek-v4-pro");
		// 没凭证的家不注册,Zed 的模型下拉里也就不会出现选了必炸的项。
		expect(models.getModel("moonshotai-cn", "kimi-k2.5")).toBeUndefined();
	});

	it("falls back to standard env vars when auth.json is absent", async () => {
		const dir = createTempDir();
		process.env.MOONSHOT_API_KEY = "env-key";

		const { models, model } = await resolveModel(dir);

		expect(model.provider).toBe("moonshotai-cn");
		const auth = await models.getAuth(model);
		expect(auth?.auth.apiKey).toBe("env-key");
		expect(auth?.source).toBe("MOONSHOT_API_KEY");
	});

	it("prefers the stored key over the environment and hot-reloads edits", async () => {
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { type: "api_key", key: "stored-key" } });
		process.env.DEEPSEEK_API_KEY = "env-key";

		const { models, model } = await resolveModel(dir);
		expect((await models.getAuth(model))?.auth.apiKey).toBe("stored-key");

		// 解析发生在每次请求时:改 auth.json 立即生效,不用重启 ACP 进程。
		writeAuth(dir, { deepseek: { type: "api_key", key: "rotated-key" } });
		expect((await models.getAuth(model))?.auth.apiKey).toBe("rotated-key");
	});

	it("honors settings.json defaults and lets MY_PI_* env vars override them", async () => {
		const dir = createTempDir();
		writeAuth(dir, {
			deepseek: { type: "api_key", key: "sk-d" },
			"moonshotai-cn": { type: "api_key", key: "sk-m" },
		});
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ defaultProvider: "moonshotai-cn", defaultModel: "kimi-k2.5" }),
		);

		const fromSettings = await resolveModel(dir);
		expect(fromSettings.model.provider).toBe("moonshotai-cn");
		expect(fromSettings.model.id).toBe("kimi-k2.5");

		process.env.MY_PI_PROVIDER = "deepseek";
		process.env.MY_PI_MODEL = "deepseek-v4-flash";
		const fromEnv = await resolveModel(dir);
		expect(fromEnv.model.provider).toBe("deepseek");
		expect(fromEnv.model.id).toBe("deepseek-v4-flash");
	});

	it("throws actionable guidance when nothing is configured", async () => {
		const dir = createTempDir();
		await expect(resolveModel(dir)).rejects.toThrow(/auth\.json/);

		process.env.MY_PI_PROVIDER = "deepseek";
		await expect(resolveModel(dir)).rejects.toThrow(/DEEPSEEK_API_KEY/);
	});
});
