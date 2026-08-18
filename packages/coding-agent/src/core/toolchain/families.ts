/**
 * 芯片平台工具链预设:「我开发的是 STM32 / ESP32 / Nordic」→ 这台机器该有哪些工具。
 *
 * 每个平台就是一份**虚拟清单**:familyManifestText() 序列化后经
 * resolveToolchain({ manifestText }) 走与项目清单完全相同的一条路 —— 同一套七档探测、
 * 同一个 parseManifest 闸门(绝对路径、重复 id 在 toolchain-families.test.ts 的
 * 往返断言里就会被拦下)、同一份机器账本(<configDir>/toolchains.json)。这个文件
 * 因此只是数据,没有平台专属的探测逻辑 —— "这个工具通常装在哪"的知识在
 * locations.ts 的两张表里,按工具 id / from 查。
 *
 * 消费方是桌面端设置页的「本机工具链」面板(kernel host 的 toolchain.families /
 * familyStatus / familySet 三个 RPC):用户选平台 → 逐工具核账 → 缺的手填路径,
 * 落进机器账本 by:"user"。账本按工具 id 全机共享,所以**同一个 id 出现在两个平台
 * 里必须是同一个工具**(arm-gcc 在 STM32 与 Nordic 下共用一条定义,配一次两边都亮;
 * 项目清单里声明同名 id 的工具也直接白得这条记录)—— 这正是"工具链是电脑的属性、
 * 不是项目的属性"落到数据上的样子。
 *
 * side 不让预设声明、生成清单时一律钉成 "both":「这台机器上装没装 arm-gcc」与
 * 研发端/工位端身份无关,两侧的设置页都该看到全部条目。
 *
 * install 文案是设置页用户看的:中文为主,内嵌命令与官网域名。**不许出现绝对路径**
 * (parseManifest 全文档扫描会拒),"默认装在哪个目录"的知识属于 locations.ts。
 *
 * pathKind 是给"手填路径"用的验证档位:
 * - "exe" —— 填可执行文件,记账前要真跑出一个版本号(actions.ts 的默认严格档);
 * - "dir" —— 填安装目录(STM32CubeMX、ESP-IDF 根目录、Zephyr SDK):它们没有能安全
 *   `--version` 的入口(对 GUI spawn 会真的弹起程序),只验"绝对路径 + 存在"。
 */

import type { ProviderSpec, ToolchainManifest, ToolSpec } from "./schema.ts";

export type ToolchainFamilyPathKind = "exe" | "dir";

/** 预设工具 = 清单工具 + 两个 UI 专用字段;side 由 familyManifest 统一钉 "both",预设不许写。 */
export interface ToolchainFamilyTool extends Omit<ToolSpec, "side"> {
	/** 设置页行标题 —— 专有名词(Arm GNU Toolchain / ESP-IDF / …),中英一致,不进 i18n。 */
	title: string;
	pathKind: ToolchainFamilyPathKind;
}

export interface ToolchainFamily {
	id: string;
	/** 展示名 —— 芯片平台专有名词,不进 i18n。 */
	name: string;
	providers?: Record<string, ProviderSpec>;
	tools: ToolchainFamilyTool[];
}

// ─── 跨平台共用的工具定义 ──────────────────────────────────────────────────────
//
// 同一个 id 只有一份定义,被多个平台引用 —— 账本按 id 共享,两份漂移的定义会让
// "在 STM32 页配的 arm-gcc"和"Nordic 页看到的 arm-gcc"字面上是同一条账、语义上
// 却不是同一个工具。optional 是唯一允许每个平台自己定的字段(必备与否取决于平台
// 语境,不改变工具身份),用展开覆盖:`{ ...ARM_GCC, optional: true }`。

const ARM_GNU_PROVIDER: Record<string, ProviderSpec> = {
	"arm-gnu-toolchain": {
		name: "Arm GNU Toolchain",
		install: {
			win32: "winget install Arm.GnuArmEmbeddedToolchain,或从 developer.arm.com 的 Arm GNU Toolchain 下载页装官方安装包",
			darwin: "brew install --cask gcc-arm-embedded,或从 developer.arm.com 装官方 .pkg",
			linux: "apt install gcc-arm-none-eabi(Debian/Ubuntu),或从 developer.arm.com 装完整 Arm GNU Toolchain",
		},
	},
};

const ARM_GCC: ToolchainFamilyTool = {
	id: "arm-gcc",
	title: "Arm GNU 交叉编译器(arm-none-eabi-gcc)",
	pathKind: "exe",
	// 与 bk64.jsonc 同形:cmake 工具链文件把四个角色都钉死成这几个名字,官方分发装在
	// 同一目录,实践中一起解析到。
	bin: ["arm-none-eabi-gcc", "arm-none-eabi-g++", "arm-none-eabi-objcopy", "arm-none-eabi-size"],
	from: "arm-gnu-toolchain",
};

const ARM_GDB: ToolchainFamilyTool = {
	id: "arm-gdb",
	title: "Arm GDB(arm-none-eabi-gdb)",
	pathKind: "exe",
	optional: true,
	bin: ["arm-none-eabi-gdb", "gdb-multiarch"],
	from: "arm-gnu-toolchain",
	install: {
		// win32/darwin 回落 provider 的指引;linux 单独写 —— apt 的 gcc-arm-none-eabi 不带 gdb。
		linux: "apt 的 gcc-arm-none-eabi 不带 gdb —— apt install gdb-multiarch,或从 developer.arm.com 装完整工具链",
	},
};

const CMAKE: ToolchainFamilyTool = {
	id: "cmake",
	title: "CMake",
	pathKind: "exe",
	optional: true,
	bin: ["cmake"],
	install: {
		win32: "winget install Kitware.CMake",
		darwin: "brew install cmake",
		linux: "apt install cmake(Debian/Ubuntu)",
	},
};

const NINJA: ToolchainFamilyTool = {
	id: "ninja",
	title: "Ninja",
	pathKind: "exe",
	optional: true,
	bin: ["ninja"],
	install: {
		win32: "winget install Ninja-build.Ninja,或 pip install ninja",
		darwin: "brew install ninja",
		linux: "apt install ninja-build(Debian/Ubuntu)",
	},
};

const JLINK: ToolchainFamilyTool = {
	id: "jlink",
	title: "SEGGER J-Link 软件包",
	pathKind: "exe",
	optional: true,
	// win32 靠 PATHEXT 展开成 JLink.exe;macOS/Linux 的官方分发叫 JLinkExe。
	bin: ["JLink", "JLinkExe"],
	install: {
		win32: "从 segger.com 装 J-Link Software Pack(安装器会注册 JLink.exe 与驱动)",
		darwin: "从 segger.com 装 J-Link Software Pack(.pkg)",
		linux: "从 segger.com 装 J-Link Software Pack(.deb/.rpm)",
	},
};

const KEIL: ToolchainFamilyTool = {
	id: "keil",
	title: "Keil MDK 编译器(armclang/armcc)",
	pathKind: "exe",
	optional: true,
	// 探测编译器而不是 UV4.exe:UV4 是 GUI,对它 spawn --version 会真的弹起 IDE;
	// armclang/armcc 是老实的命令行程序,而且是构建真正要用的东西。
	bin: ["armclang", "armcc"],
	install: {
		win32: "从 keil.com 装 MDK(MDK-Community 免费,需注册);编译器在安装目录的 ARM 子目录下,把 armclang 所在的 bin 目录路径填进来即可",
	},
};

// ─── STM32 专属 ──────────────────────────────────────────────────────────────

const OPENOCD: ToolchainFamilyTool = {
	id: "openocd",
	title: "OpenOCD",
	pathKind: "exe",
	optional: true,
	bin: ["openocd"],
	install: {
		win32: "xpm install @xpack-dev-tools/openocd,或从 GitHub 的 xpack-dev-tools/openocd-xpack Releases 解压并把 bin 加进 PATH",
		darwin: "brew install openocd",
		linux: "apt install openocd(Debian/Ubuntu)",
	},
};

const STM32CUBEPROG: ToolchainFamilyTool = {
	id: "stm32cubeprog",
	title: "STM32CubeProgrammer(STM32_Programmer_CLI)",
	pathKind: "exe",
	optional: true,
	bin: ["STM32_Programmer_CLI"],
	install: {
		win32: "从 st.com 下载 STM32CubeProgrammer 安装(需免费 ST 账号)",
		darwin: "从 st.com 下载 STM32CubeProgrammer 安装(需免费 ST 账号)",
		linux: "从 st.com 下载 STM32CubeProgrammer 安装(需免费 ST 账号)",
	},
};

const STM32CUBEMX: ToolchainFamilyTool = {
	id: "stm32cubemx",
	title: "STM32CubeMX(安装目录)",
	pathKind: "dir",
	optional: true,
	// 没有 bin:装完自己用的 GUI,resolve.ts 对 bin 为空的工具只认账本/覆盖记录 ——
	// 在设置页手填安装目录就是把它记进账本的正门(locations.ts 的表键留着,给
	// 将来有 bin 的场景;bin 为空时 well-known/registry 两档不会被碰)。
	install: {
		win32: "从 st.com 下载 STM32CubeMX(需免费 ST 账号)",
		darwin: "从 st.com 下载 STM32CubeMX(需免费 ST 账号)",
		linux: "从 st.com 下载 STM32CubeMX(需免费 ST 账号)",
	},
};

// ─── ESP32 专属 ──────────────────────────────────────────────────────────────

const IDF: ToolchainFamilyTool = {
	id: "idf",
	title: "ESP-IDF(框架根目录)",
	pathKind: "dir",
	// IDF_PATH 是最稳的信号(export 脚本之外 idf.py 通常不在 PATH 上);
	// well-known 档指向官方安装器与手动 clone 的惯常位置(见 locations.ts)。
	bin: ["idf.py"],
	env: ["IDF_PATH"],
	install: {
		win32: "用 Espressif 官方安装器(dl.espressif.com/dl/esp-idf)安装;装完把 esp-idf 根目录填进来",
		darwin: "按 docs.espressif.com 的 Get Started:git clone esp-idf 后跑 install.sh,再把根目录填进来",
		linux: "按 docs.espressif.com 的 Get Started:git clone esp-idf 后跑 install.sh,再把根目录填进来",
	},
};

const PYTHON: ToolchainFamilyTool = {
	id: "python",
	title: "Python 3",
	pathKind: "exe",
	optional: true,
	bin: ["python3", "python"],
	install: {
		win32: "winget install Python.Python.3.12,或从 python.org 安装",
		darwin: "brew install python@3.12",
		linux: "apt install python3 python3-venv(Debian/Ubuntu)",
	},
};

const ESPTOOL: ToolchainFamilyTool = {
	id: "esptool",
	title: "esptool(串口烧录)",
	pathKind: "exe",
	optional: true,
	bin: ["esptool", "esptool.py"],
	install: {
		win32: "pip install esptool(ESP-IDF 环境里已自带,独立使用才需要单装)",
		darwin: "pip install esptool(ESP-IDF 环境里已自带,独立使用才需要单装)",
		linux: "pip install esptool(ESP-IDF 环境里已自带,独立使用才需要单装)",
	},
};

// ─── Nordic 专属 ─────────────────────────────────────────────────────────────

const WEST: ToolchainFamilyTool = {
	id: "west",
	title: "west(Zephyr / nRF Connect SDK 构建入口)",
	pathKind: "exe",
	optional: true,
	bin: ["west"],
	install: {
		win32: "pip install west(nRF Connect for Desktop 的 Toolchain Manager 也会带一份)",
		darwin: "pip install west",
		linux: "pip install west",
	},
};

const ZEPHYR_SDK: ToolchainFamilyTool = {
	id: "zephyr-sdk",
	title: "Zephyr SDK(安装目录)",
	pathKind: "dir",
	optional: true,
	bin: ["arm-zephyr-eabi-gcc"],
	env: ["ZEPHYR_SDK_INSTALL_DIR"],
	install: {
		win32: "从 GitHub 的 zephyrproject-rtos/sdk-ng Releases 解压(通常解到用户目录的 zephyr-sdk-x.y.z)并跑 setup.cmd",
		darwin: "从 GitHub 的 zephyrproject-rtos/sdk-ng Releases 解压并跑 setup.sh",
		linux: "从 GitHub 的 zephyrproject-rtos/sdk-ng Releases 解压并跑 setup.sh",
	},
};

const NRFUTIL: ToolchainFamilyTool = {
	id: "nrfutil",
	title: "nrfutil(nRF 设备管理/烧录)",
	pathKind: "exe",
	optional: true,
	bin: ["nrfutil"],
	install: {
		win32: "从 nordicsemi.com 下载 nrfutil 可执行文件并加进 PATH",
		darwin: "从 nordicsemi.com 下载 nrfutil 可执行文件并加进 PATH",
		linux: "从 nordicsemi.com 下载 nrfutil 可执行文件并加进 PATH",
	},
};

// ─── 平台目录 ────────────────────────────────────────────────────────────────

export const TOOLCHAIN_FAMILIES: readonly ToolchainFamily[] = [
	{
		id: "stm32",
		name: "STM32",
		providers: ARM_GNU_PROVIDER,
		tools: [ARM_GCC, ARM_GDB, CMAKE, NINJA, OPENOCD, STM32CUBEPROG, JLINK, STM32CUBEMX, KEIL],
	},
	{
		id: "esp32",
		name: "ESP32(ESP-IDF)",
		tools: [IDF, PYTHON, ESPTOOL],
	},
	{
		// 全部 optional 是有意的:NCS/Zephyr、裸机 gcc、Keil 是三条并行路线,没有哪个
		// 工具是"不装就一定错"的 —— UI 按 ok/total 计数展示,不用 needsAttention。
		id: "nordic",
		name: "Nordic(nRF)",
		providers: ARM_GNU_PROVIDER,
		tools: [WEST, ZEPHYR_SDK, { ...ARM_GCC, optional: true }, NRFUTIL, JLINK, KEIL],
	},
];

export function findToolchainFamily(id: string): ToolchainFamily | undefined {
	return TOOLCHAIN_FAMILIES.find((family) => family.id === id);
}

/** 预设 → 标准清单:剥掉 UI 专用字段,side 统一钉 "both"(见文件头)。 */
export function familyManifest(family: ToolchainFamily): ToolchainManifest {
	return {
		schema: "yoma/toolchain@1",
		providers: family.providers,
		tools: family.tools.map(({ title: _title, pathKind: _pathKind, ...spec }) => ({ ...spec, side: "both" as const })),
	};
}

/**
 * 序列化成 resolveToolchain 的 manifestText 注入形态。走文本而不是直接塞对象是
 * 刻意的:让预设过一遍 parseManifest 的全部闸门(schema 标签、重复 id、from 指向、
 * 绝对路径扫描),预设写坏与项目清单写坏报的是同一种人话错误。
 */
export function familyManifestText(family: ToolchainFamily): string {
	return JSON.stringify(familyManifest(family));
}
