// MyPiAcpAgent 的协议层测试:Zed 真正驱动的那一半。
//
// 之前只有纯映射函数被钉住,类本身和 8 个 RPC 方法一次都没被实例化过 ——
// 也就是说 session/new 少发一个字段、set_config_option 返回值形状不对这类问题,
// 只能在编辑器里以"框不见了"的形式暴露。
//
// 这里全程离线:faux provider 顶掉真模型,会话写进临时目录,cx 换成收集器。
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@yoma/my-pi/node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyPiAcpAgent } from "../src/acp/agent.ts";

interface Notification {
	method: string;
	params: any;
}

/** 假的客户端上下文。真 SDK 那边就是这两个口子。 */
function createClient() {
	const notifications: Notification[] = [];
	return {
		notifications,
		cx: { notify: async (method: string, params: any) => void notifications.push({ method, params }) },
		updates: (kind?: string) =>
			notifications
				.filter((n) => n.method === "session/update")
				.map((n) => n.params.update)
				.filter((u) => kind === undefined || u.sessionUpdate === kind),
	};
}

let workdir: string;
let fauxCount = 0;

function setup() {
	const models = createModels();
	// 两个 provider,才测得出跨 provider 切换 —— 单 provider 时注册表的 bug 是隐形的。
	const first = fauxProvider({ provider: `faux-a-${++fauxCount}` });
	const second = fauxProvider({ provider: `faux-b-${fauxCount}` });
	models.setProvider(first.provider);
	models.setProvider(second.provider);

	const agent = new MyPiAcpAgent({
		env: new NodeExecutionEnv({ cwd: workdir }),
		models,
		model: first.getModel(),
		protocolVersion: 1,
		sessionsDir: join(workdir, "sessions"),
		logsDir: join(workdir, "logs"),
	});
	return { agent, models, first, second };
}

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), "mypi-acp-"));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("initialize", () => {
	it("echoes the protocol version and declares loadSession", async () => {
		const { agent } = setup();
		const result = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
		expect(result.protocolVersion).toBe(1);
		expect(result.agentCapabilities.loadSession).toBe(true);
	});
});

describe("session/new", () => {
	it("returns configOptions — without them Zed renders no dropdowns at all", async () => {
		const { agent } = setup();
		const client = createClient();
		const result: any = await agent.newSession({ cwd: workdir }, client.cx);

		expect(result.sessionId).toBeTruthy();
		expect(result.configOptions.map((o: any) => o.id)).toEqual(["model", "thought_level"]);
		expect(result.configOptions.map((o: any) => o.category)).toEqual(["model", "thought_level"]);
	});

	it("also returns modes, so the thinking picker works whichever representation the client binds to", async () => {
		const { agent } = setup();
		const result: any = await agent.newSession({ cwd: workdir }, createClient().cx);
		expect(result.modes.currentModeId).toBe("off");
		expect(result.modes.availableModes.map((m: any) => m.id)).toContain("off");
	});

	it("announces slash commands — this is what puts \"/ for commands\" in the composer", async () => {
		const { agent } = setup();
		const client = createClient();
		await agent.newSession({ cwd: workdir }, client.cx);

		const announced = client.updates("available_commands_update");
		expect(announced).toHaveLength(1);
		expect(announced[0]!.availableCommands.map((c: any) => c.name).sort()).toEqual(["compact", "status"]);
	});

	it("lists models from every registered provider", async () => {
		const { agent, first, second } = setup();
		const result: any = await agent.newSession({ cwd: workdir }, createClient().cx);
		const values = result.configOptions[0].options.map((o: any) => o.value);
		expect(values).toContain(`${first.getModel().provider}/${first.getModel().id}`);
		expect(values).toContain(`${second.getModel().provider}/${second.getModel().id}`);
	});
});

describe("session/set_config_option", () => {
	it("switches the model across providers and echoes the new state", async () => {
		const { agent, second } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		const target = `${second.getModel().provider}/${second.getModel().id}`;

		const result = await agent.setSessionConfigOption(
			{ sessionId, configId: "model", value: target },
			client.cx,
		);

		// configOptions 是必填字段:SDK 对这个方法没有 void→{} 的兜底 mapper,
		// 返回 undefined 会在响应校验时失败。
		expect(result.configOptions.find((o) => o.id === "model")!.currentValue).toBe(target);
	});

	it("pushes config_option_update so the picker re-syncs", async () => {
		const { agent, second } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);

		await agent.setSessionConfigOption(
			{ sessionId, configId: "model", value: `${second.getModel().provider}/${second.getModel().id}` },
			client.cx,
		);

		const pushed = client.updates("config_option_update");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.configOptions.map((o: any) => o.id)).toEqual(["model", "thought_level"]);
	});

	it("rejects an unknown model instead of silently keeping the old one", async () => {
		const { agent } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);

		await expect(
			agent.setSessionConfigOption({ sessionId, configId: "model", value: "nope/nope" }, client.cx),
		).rejects.toThrow(/Unknown model/);
	});

	it("rejects an unknown config id", async () => {
		const { agent } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);

		await expect(
			agent.setSessionConfigOption({ sessionId, configId: "colour", value: "blue" }, client.cx),
		).rejects.toThrow(/Unknown config option/);
	});

	it("rejects a thinking level the current model does not support", async () => {
		const { agent } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);

		// faux 模型 reasoning:false,所以只有 off 合法。
		await expect(
			agent.setSessionConfigOption({ sessionId, configId: "thought_level", value: "high" }, client.cx),
		).rejects.toThrow(/Unsupported thinking level/);
	});

	it("rejects an unknown session", async () => {
		const { agent } = setup();
		await expect(
			agent.setSessionConfigOption({ sessionId: "missing", configId: "model", value: "x/y" }, createClient().cx),
		).rejects.toThrow(/not found/);
	});
});

describe("session/prompt", () => {
	it("streams assistant text as agent_message_chunk and ends the turn", async () => {
		const { agent, first } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		first.setResponses([fauxAssistantMessage("hello from faux")]);

		const result = await agent.prompt(
			{ sessionId, prompt: [{ type: "text", text: "hi" }] },
			client.cx,
		);

		expect(result.stopReason).toBe("end_turn");
		const said = client.updates("agent_message_chunk").map((u: any) => u.content.text).join("");
		expect(said).toContain("hello from faux");
	});

	it("runs /status locally without consulting the model", async () => {
		const { agent, first } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		first.setResponses([fauxAssistantMessage("the model must not be called")]);

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/status" }] }, client.cx);

		expect(result.stopReason).toBe("end_turn");
		const said = client.updates("agent_message_chunk").map((u: any) => u.content.text).join("");
		expect(said).toContain("**model**");
		expect(said).not.toContain("the model must not be called");
		// 命令没有进模型,所以剧本原封不动。
		expect(first.getPendingResponseCount()).toBe(1);
	});

	it("passes ordinary text containing a slash through to the model", async () => {
		const { agent, first } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		first.setResponses([fauxAssistantMessage("answered")]);

		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "what is src/acp.ts?" }] }, client.cx);

		expect(first.getPendingResponseCount()).toBe(0);
	});

	it("rejects a prompt for an unknown session", async () => {
		const { agent } = setup();
		await expect(
			agent.prompt({ sessionId: "missing", prompt: [{ type: "text", text: "hi" }] }, createClient().cx),
		).rejects.toThrow(/not found/);
	});
});

describe("session/load", () => {
	it("restores the model and thinking level chosen in the previous process", async () => {
		const { agent, second } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		const target = `${second.getModel().provider}/${second.getModel().id}`;
		await agent.setSessionConfigOption({ sessionId, configId: "model", value: target }, client.cx);

		// 换一个 agent 实例来 load,模拟 Zed 重启后接上同一个会话文件。
		const reopened = new MyPiAcpAgent({
			env: new NodeExecutionEnv({ cwd: workdir }),
			models: (agent as any).options.models,
			model: (agent as any).options.model,
			protocolVersion: 1,
			sessionsDir: join(workdir, "sessions"),
			logsDir: join(workdir, "logs"),
		});
		const fresh = createClient();
		const loaded: any = await reopened.loadSession({ sessionId, cwd: workdir }, fresh.cx);

		expect(loaded.configOptions.find((o: any) => o.id === "model").currentValue).toBe(target);
	});

	it("replays history so the client can redraw the conversation", async () => {
		const { agent, first } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		first.setResponses([fauxAssistantMessage("prior answer")]);
		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "prior question" }] }, client.cx);

		const fresh = createClient();
		await agent.loadSession({ sessionId, cwd: workdir }, fresh.cx);

		const kinds = fresh.updates().map((u: any) => u.sessionUpdate);
		expect(kinds).toContain("user_message_chunk");
		expect(kinds).toContain("agent_message_chunk");
		expect(kinds).toContain("available_commands_update");
	});

	it("rejects a session that does not exist", async () => {
		const { agent } = setup();
		await expect(agent.loadSession({ sessionId: "missing", cwd: workdir }, createClient().cx)).rejects.toThrow(
			/not found/,
		);
	});
});

describe("session/set_mode", () => {
	it("accepts a supported level and pushes current_mode_update", async () => {
		const { agent } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);

		await agent.setSessionMode({ sessionId, modeId: "off" }, client.cx);

		expect(client.updates("current_mode_update")).toEqual([
			{ sessionUpdate: "current_mode_update", currentModeId: "off" },
		]);
	});

	it("rejects a level the model does not support", async () => {
		const { agent } = setup();
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		await expect(agent.setSessionMode({ sessionId, modeId: "max" }, client.cx)).rejects.toThrow(/Unknown mode/);
	});
});

describe("automatic compaction after a turn", () => {


	/** 窗口必须大于 DEFAULT_COMPACTION_SETTINGS.reserveTokens(16384)才有真阈值。 */
	function setupWithWindow(contextWindow: number) {
		const models = createModels();
		const faux = fauxProvider({
			provider: `faux-c-${++fauxCount}`,
			models: [{ id: "small", contextWindow, maxTokens: 4096 }],
		});
		models.setProvider(faux.provider);
		const agent = new MyPiAcpAgent({
			env: new NodeExecutionEnv({ cwd: workdir }),
			models,
			model: faux.getModel(),
			protocolVersion: 1,
			sessionsDir: join(workdir, "sessions"),
			logsDir: join(workdir, "logs"),
		});
		return { agent, faux };
	}

	// faux provider 会按内容自己合成 usage,忽略消息上带的 usage 字段 —— 所以这里
	// 靠调窗口大小来跨阈值,而不是靠注入 token 数,免得依赖 faux 的具体计数方式。

	it("stays silent when the turn leaves plenty of room", async () => {
		const { agent, faux } = setupWithWindow(200000);
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		faux.setResponses([fauxAssistantMessage("answer")]);

		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }, client.cx);

		const said = client.updates("agent_message_chunk").map((u: any) => u.content.text).join("");
		expect(said).not.toContain("🗜️");
		expect(said).not.toContain("自动压缩失败");
	});

	it("reacts when the turn pushes context past the threshold", async () => {
		// 窗口只比 reserveTokens(16384)大一点点,阈值≈16,任何一轮都会越线。
		const { agent, faux } = setupWithWindow(16400);
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		// 两条:一条回答用,一条给压缩自己那次摘要调用用。
		faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("SUMMARY")]);

		const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }, client.cx);

		const said = client.updates("agent_message_chunk").map((u: any) => u.content.text).join("");
		expect(said).toContain("已自动压缩");
		expect(said).not.toContain("自动压缩失败");
		// 压缩是善后动作:它的成败都不该影响用户已经拿到的这一轮答案。
		expect(result.stopReason).toBe("end_turn");
		expect(said).toContain("answer");
	});

	it("does not compact twice in a row on the same stale usage", async () => {
		// 保留下来的消息带的是压缩前那个更大上下文的 usage,信了它就会一路压到没东西可压。
		const { agent, faux } = setupWithWindow(16400);
		const client = createClient();
		const { sessionId }: any = await agent.newSession({ cwd: workdir }, client.cx);
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("SUMMARY")]);
		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }, client.cx);

		const compactionsAfterFirstTurn = client
			.updates("agent_message_chunk")
			.filter((u: any) => u.content.text.includes("已自动压缩")).length;
		expect(compactionsAfterFirstTurn).toBe(1);
	});
});
