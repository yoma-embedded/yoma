/**
 * flash 工具:探针独占执行器。
 *
 * 2026-08 起不再内置 probe-rs(Windows 上它要求换 WinUSB 驱动,与厂商驱动互斥 ——
 * 对 J-Link 用户等于弄坏 SEGGER 全家)。烧录命令由模型自带(OpenOCD / J-Link
 * Commander / STM32CubeProgrammer CLI / pyocd / west / esptool …),这个工具只管
 * 三件 bash 给不了的事:
 *
 * 1. 探针租约:gdb server、日志采集与烧录抢同一个探针时,错误要指名持有者 ——
 *    bash 起的进程在租约体系里是隐形的,所以凡碰探针的命令都该走这里。
 * 2. 有界超时 + 杀树(runEngine):挂死的烧录器攥着探针不放,下一次失败长得和
 *    硬件坏了一模一样。
 * 3. flash-state 落账:exit 0 且给了 elfPath 时记录 sha256,gdb attach 用它判断
 *    "手里的 ELF 是不是就是片子里跑的那个"。
 *
 * 错误分类学与其他引擎工具不同:烧录器非零退出**不抛错**,而是把输出连同
 * "占用/没插"的分诊当正常结果返回 —— 没插探针是常态而非异常,模型要读到
 * 提示才知道让用户接硬件。只有超时/中断才抛。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@yoma/agent";
import { type Static, Type } from "typebox";
import {
	assertEngineSettled,
	claimProbe,
	clamp,
	describeProbeConflict,
	probeFailedHint,
	releaseProbe,
	runEngine,
} from "./engines.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type ToolDefinition, wrapToolDefinition } from "./types.ts";

const flashSchema = Type.Object({
	command: Type.Array(Type.String(), {
		description:
			'The flasher argv (no shell), e.g. ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"].',
	}),
	elfPath: Type.Optional(
		Type.String({
			description:
				"The image this command flashes. On success its hash is recorded so gdb start can verify the chip runs exactly this build. Pass it whenever the command programs firmware.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Kill the command after this long (default 120000, clamped to 5000–600000). Flashing normally takes seconds; a hung flasher keeps the probe hostage.",
		}),
	),
});

export type FlashToolInput = Static<typeof flashSchema>;

export interface FlashToolDetails {
	command: string[];
	exitCode: number | null;
	/** elfPath 给了且 exit 0 时:已写进 flash-state.json 的镜像绝对路径。 */
	recordedElf?: string;
}

/** 烧录动真实硬件,默认超时比引擎默认值紧。 */
const FLASH_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_TIMEOUT_MS = 5 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 最后一次成功烧录的记录。gdb 会话靠它判断"手里的 ELF 是不是就是片子里跑的那个"。
 *
 * 这条记录挡的是整套工具里最贵的一次失败,而且那次失败**没有任何错误文本**:
 * 改了代码、重编了、忘了烧,然后问 agent 为什么新逻辑不生效。行号偏几行、
 * 调用栈看着合理、变量值看着合理,于是模型写出一份完全自洽、完全虚构的根因分析。
 */
export interface FlashState {
	elfPath: string;
	sha256: string;
	at: number;
}

export const FLASH_STATE_FILE = path.join(".yoma", "flash-state.json");

export async function sha256File(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** 读不到/读坏了都返回 undefined:这是提示信息,不该成为烧录或调试的拦路虎。 */
export async function readFlashState(env: ExecutionEnv): Promise<FlashState | undefined> {
	const file = path.join(env.cwd, FLASH_STATE_FILE);
	const read = await env.readTextFile(file);
	if (!read.ok) return undefined;
	try {
		const parsed = JSON.parse(read.value) as FlashState;
		return typeof parsed?.sha256 === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function writeFlashState(env: ExecutionEnv, state: FlashState): Promise<void> {
	const file = path.join(env.cwd, FLASH_STATE_FILE);
	await env.createDir(path.dirname(file), { recursive: true });
	await env.writeFile(file, `${JSON.stringify(state, null, "\t")}\n`);
}

const DESCRIPTION = `Runs a flashing or probe-control command (OpenOCD, J-Link Commander, STM32CubeProgrammer CLI, pyocd, west, esptool, ...) with exclusive access to the debug probe.

- Use this instead of bash for ANY command that touches the debug probe (flash, erase, reset, option bytes). The probe lease lives here: a concurrent gdb or log session is told who holds the probe instead of a fake "no probe found", and a hung flasher is killed with its whole process tree instead of keeping the probe hostage.
- command is an argv array; it runs without a shell. Typical recipes:
  - OpenOCD: ["openocd","-f","interface/stlink.cfg","-f","target/stm32g4x.cfg","-c","program build/fw.elf verify reset exit"]
  - J-Link: write a command file first (r / loadfile build/fw.hex / r / g / qc), then ["JLink","-Device","STM32G431CB","-If","SWD","-Speed","4000","-AutoConnect","1","-CommanderScript","flash.jlink"] (the binary is JLinkExe on macOS/Linux). J-Link Commander can exit 0 even when it failed — read the output, never trust its exit code alone.
  - STM32CubeProgrammer: ["STM32_Programmer_CLI","-c","port=SWD","-w","build/fw.elf","-v","-rst"]
- Always pass elfPath (the image the command flashes) when programming firmware: on success its hash is recorded, and gdb start verifies the chip is running exactly this build — the guard against debugging stale firmware.
- A non-zero exit comes back as data, not an error. It usually means no probe connected, a vendor-driver mismatch, or the probe is held by another process — read the output and the appended hint.
- There is no built-in probe enumeration; use bash for that (J-Link's ShowEmuList, lsusb, Get-PnpDevice) or the vendor tool itself.
- Make sure the firmware actually starts afterwards: include a reset in the command (OpenOCD "reset", J-Link "r" then "g", CubeProgrammer "-rst") or reset through gdb. Never claim firmware is running on hardware unless flashing and a reset both succeeded.`;

export function createFlashToolDefinition(env: ExecutionEnv): ToolDefinition<typeof flashSchema, FlashToolDetails> {
	return {
		name: "flash",
		label: "flash",
		description: DESCRIPTION,
		promptSnippet: "Run flashing / probe commands (OpenOCD, J-Link, vendor CLIs) with exclusive probe access",
		promptGuidelines: [
			"Run every command that touches the debug probe through the flash tool, not bash — the probe lease and hung-flasher cleanup live there.",
			"Never claim firmware is running on hardware unless flashing and a reset both succeeded.",
		],
		parameters: flashSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const command = params.command;
			if (command.length === 0 || !command[0]?.trim()) {
				throw new Error('flash requires command — the flasher argv, e.g. ["openocd","-f",...] or ["JLink","-CommanderScript",...]');
			}
			const elf = params.elfPath ? await resolveToCwd(env, params.elfPath) : undefined;
			if (elf) {
				const exists = await env.exists(elf);
				if (!exists.ok || !exists.value) throw new Error(`elfPath not found: ${elf}`);
			}

			const label = path.basename(command[0]!);
			// runEngine 是一次性调用,租约只在这一次调用期间成立。
			const holder = claimProbe("flash", label);
			if (holder) throw new Error(`flash: ${describeProbeConflict(holder)}`);
			let result: Awaited<ReturnType<typeof runEngine>>;
			try {
				result = await runEngine(command[0]!, command.slice(1), {
					cwd: env.cwd,
					signal,
					timeoutMs: clamp(params.timeoutMs, FLASH_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
				});
			} finally {
				releaseProbe("flash");
			}
			// 只判超时/中断:烧录器非零退出不抛错(见文件头),那条策略留在下面。
			assertEngineSettled(result, `flash ${label}`);

			const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
			const details: FlashToolDetails = { command, exitCode: result.exitCode };
			if (result.exitCode !== 0) {
				const text = `flash \`${label}\` failed (exit ${result.exitCode}):\n${output || "(no output)"}\n${probeFailedHint(output)}`;
				return { content: [{ type: "text", text }], details };
			}
			let recorded = "";
			if (elf) {
				// 落盘失败不该让一次成功的烧录变成报错 —— 它只是让 gdb 少一条校验线索。
				const ok = await writeFlashState(env, { elfPath: elf, sha256: await sha256File(elf), at: Date.now() })
					.then(() => true)
					.catch(() => false);
				if (ok) {
					details.recordedElf = elf;
					recorded = `\nrecorded ${elf} as the image on the target — gdb start will verify against it.`;
				}
			}
			return {
				content: [{ type: "text", text: `${output || `flash \`${label}\` completed (exit 0)`}${recorded}` }],
				details,
			};
		},
	};
}

export function createFlashTool(env: ExecutionEnv) {
	return wrapToolDefinition(createFlashToolDefinition(env));
}
