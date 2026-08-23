// 凭证独立性验收:FileCredentialStore 的读写与权限,resolveModel 的
// auth.json/环境/settings.json 选择顺序、注册 == 已配置,以及请求时 getAuth 的热更新语义。
//
// 环境一律经 AuthContext 注入,不动 process.env:目录有 40 家 provider,开发机上任何一个
// ANTHROPIC_API_KEY / ~/.aws/credentials 都会让"没配凭据"这类前提不成立,逐个删环境变量
// 在两家的时候就已经是体力活,四十家根本列不全。YOMA_PROVIDER / YOMA_MODEL 是 yoma 自己的
// 开关,仍然直接读 process.env,所以只保留这两个的保存/还原。
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthContext, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { configurableProviders, FileCredentialStore, NO_AMBIENT_AUTH, resolveModel } from "../src/acp/models.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `yoma-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

const YOMA_ENV = ["YOMA_PROVIDER", "YOMA_MODEL"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of YOMA_ENV) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of YOMA_ENV) {
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

/** 只有给定环境变量存在的 AuthContext;文件一律不存在。 */
function envOnly(vars: Record<string, string>): AuthContext {
	return { env: async (name) => vars[name], fileExists: async () => false };
}

const isolated = { authContext: NO_AMBIENT_AUTH };

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

	it("heals a stored key that is missing type (or uses the old api-key discriminator)", async () => {
		const dir = createTempDir();
		const path = join(dir, "auth.json");
		writeFileSync(path, JSON.stringify({ deepseek: { key: "sk-no-type" } }));
		const store = new FileCredentialStore(path);

		expect(await store.read("deepseek")).toEqual({ type: "api_key", key: "sk-no-type" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ deepseek: { type: "api_key", key: "sk-no-type" } });

		writeFileSync(path, JSON.stringify({ deepseek: { type: "api-key", key: "sk-old" } }));
		expect(await store.read("deepseek")).toEqual({ type: "api_key", key: "sk-old" });
	});
});

describe("resolveModel", () => {
	it("picks the first stored-key provider and registers only configured ones", async () => {
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { type: "api_key", key: "sk-d" } });

		const { models, model } = await resolveModel(dir, isolated);

		expect(model.provider).toBe("deepseek");
		// 没钉模型时取目录里的第一个(pi-ai 生成的顺序)。
		expect(model.id).toBe(models.getModels("deepseek")[0]!.id);
		// 注册 == 已配置:没凭证的家不注册,Zed 的模型下拉里也就不会出现选了必炸的项。
		expect(models.getProviders().map((p) => p.id)).toEqual(["deepseek"]);
		expect(models.getModel("moonshotai-cn", "kimi-k2.5")).toBeUndefined();
	});

	it("takes the catalog from pi-ai: all 40 builtin providers are registrable", async () => {
		const dir = createTempDir();
		const ids = builtinProviders().map((p) => p.id);
		const auth: Record<string, unknown> = {};
		for (const id of ids) auth[id] = { type: "api_key", key: "k" };
		writeAuth(dir, auth);

		const { models } = await resolveModel(dir, isolated);
		const registered = models.getProviders().map((p) => p.id);
		// 只存一个 key 不算配置好的三家:cloudflare 两家还要 account id,openai-codex 只有 OAuth。
		// 其余(含 radius,目录要联网拉但 key 本身算配置)全注册。
		expect(ids.filter((id) => !registered.includes(id))).toEqual([
			"cloudflare-ai-gateway",
			"cloudflare-workers-ai",
			"openai-codex",
		]);
		expect(models.getModels().length).toBeGreaterThan(1000);
	});

	it("sends max_tokens (not max_completion_tokens) to DeepSeek", async () => {
		// DeepSeek 静默忽略 max_completion_tokens,压缩/摘要的输出上限靠这个字段 ——
		// 从前在手写表里钉死,现在要确认 pi-ai 的目录同样钉了。
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { type: "api_key", key: "sk-d" }, "moonshotai-cn": { type: "api_key", key: "k" } });

		const { models } = await resolveModel(dir, isolated);
		const compatOf = (provider: string, id: string) =>
			(models.getModel(provider, id) as Model<"openai-completions"> | undefined)?.compat;

		for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
			expect(compatOf("deepseek", id)?.maxTokensField).toBe("max_tokens");
		}
		expect(compatOf("moonshotai-cn", "kimi-k2.5")?.maxTokensField).toBe("max_tokens");
	});

	it("falls back to the provider's standard env var when auth.json is absent", async () => {
		const dir = createTempDir();
		const authContext = envOnly({ MOONSHOT_API_KEY: "env-key" });

		const { models, model } = await resolveModel(dir, { authContext });

		// MOONSHOT_API_KEY 同时喂国际站 moonshotai 和国内站 moonshotai-cn(pi-ai 两家共用这个变量),
		// 两家都算配置好;默认落到目录序靠前的国际站。要国内站就写 settings.json 或 YOMA_PROVIDER。
		expect(models.getProviders().map((p) => p.id)).toEqual(["moonshotai", "moonshotai-cn"]);
		expect(model.provider).toBe("moonshotai");
		const auth = await models.getAuth(models.getModel("moonshotai-cn", "kimi-k2.5")!);
		expect(auth?.auth.apiKey).toBe("env-key");
		expect(auth?.source).toBe("MOONSHOT_API_KEY");
	});

	it("registers a provider configured only through its env var, and nothing else", async () => {
		const dir = createTempDir();
		const { models, model } = await resolveModel(dir, { authContext: envOnly({ ANTHROPIC_API_KEY: "sk-ant" }) });
		expect(model.provider).toBe("anthropic");
		expect(models.getProviders().map((p) => p.id)).toEqual(["anthropic"]);
	});

	it("prefers the stored key over the environment and hot-reloads edits", async () => {
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { type: "api_key", key: "stored-key" } });

		const { models, model } = await resolveModel(dir, { authContext: envOnly({ DEEPSEEK_API_KEY: "env-key" }) });
		expect((await models.getAuth(model))?.auth.apiKey).toBe("stored-key");

		// 解析发生在每次请求时:改 auth.json 立即生效,不用重启 ACP 进程。
		writeAuth(dir, { deepseek: { type: "api_key", key: "rotated-key" } });
		expect((await models.getAuth(model))?.auth.apiKey).toBe("rotated-key");
	});

	it("honors settings.json defaults and lets YOMA_* env vars override them", async () => {
		const dir = createTempDir();
		writeAuth(dir, {
			deepseek: { type: "api_key", key: "sk-d" },
			"moonshotai-cn": { type: "api_key", key: "sk-m" },
		});
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ defaultProvider: "moonshotai-cn", defaultModel: "kimi-k2.5" }),
		);

		const fromSettings = await resolveModel(dir, isolated);
		expect(fromSettings.model.provider).toBe("moonshotai-cn");
		expect(fromSettings.model.id).toBe("kimi-k2.5");

		process.env.YOMA_PROVIDER = "deepseek";
		process.env.YOMA_MODEL = "deepseek-v4-flash";
		const fromEnv = await resolveModel(dir, isolated);
		expect(fromEnv.model.provider).toBe("deepseek");
		expect(fromEnv.model.id).toBe("deepseek-v4-flash");
	});

	it("throws actionable guidance when nothing is configured", async () => {
		const dir = createTempDir();
		// 内核的 preflight 拿这条错误当"没配 key"的证据,而且要能从里面抄出 auth.json 的格式。
		await expect(resolveModel(dir, isolated)).rejects.toThrow(/auth\.json.*"type":"api_key"/);

		process.env.YOMA_PROVIDER = "deepseek";
		await expect(resolveModel(dir, isolated)).rejects.toThrow(/No API key for provider deepseek/);

		process.env.YOMA_PROVIDER = "nope";
		await expect(resolveModel(dir, isolated)).rejects.toThrow(/Unknown provider: nope\. Known providers: .*deepseek/);
	});

	it("treats a key without type as configured instead of silently ignoring it", async () => {
		const dir = createTempDir();
		writeAuth(dir, { deepseek: { key: "sk-no-type" } });
		const { model } = await resolveModel(dir, isolated);
		expect(model.provider).toBe("deepseek");
	});
});

describe("configurableProviders", () => {
	it("lists exactly the providers a single API key can unlock", async () => {
		const list = await configurableProviders();
		const ids = list.map((p) => p.id);
		const builtin = builtinProviders().map((p) => p.id);

		for (const id of ids) expect(builtin).toContain(id);
		for (const id of ["deepseek", "moonshotai-cn", "anthropic", "openai", "google", "openrouter"]) {
			expect(ids).toContain(id);
		}
		// 只有 OAuth / 要账号 id、区域、项目 / 目录要联网拉 —— 填一个 key 永远亮不起"已连接"。
		for (const id of [
			"openai-codex",
			"radius",
			"amazon-bedrock",
			"google-vertex",
			"cloudflare-ai-gateway",
			"cloudflare-workers-ai",
		]) {
			expect(ids).not.toContain(id);
		}
		// 名字跟 pi-ai 走,桌面端不再另维护一份。
		expect(list.find((p) => p.id === "deepseek")?.name).toBe("DeepSeek");
	});
});
