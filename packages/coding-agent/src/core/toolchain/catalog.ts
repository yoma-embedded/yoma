/**
 * 可自动安装的工具链目录 —— 维护者钉住的**数据**,不是策略:每个包按宿主(平台-架构)
 * 给一个官方发布的压缩包 URL、sha256、字节数、压缩格式和解开后的目录布局。
 * install.ts 只认这张表:下载、校验、解压、记账全按它来,表里没有的宿主就是"这台机器
 * 装不了,回落到 families.ts 的人话安装指引"。
 *
 * ## 为什么是数据,为什么钉版本
 *
 * - URL 指向厂商的正式发布(Arm developer.arm.com、Kitware / ninja-build / xpack /
 *   git-for-windows 的 GitHub Releases),不指向任何自建镜像;镜像是运行期可选项
 *   (`YOMA_TOOLCHAIN_MIRROR` 或 artifact.mirrors),按顺序试、失败下一条。
 * - sha256 抄自厂商自己的校验文件(cmake 的 SHA-256.txt、xpack 的 .sha、Arm 的 .sha256asc、
 *   git-for-windows 的 Release 说明),下载完必须对得上,对不上就删。这是把"用户从
 *   浏览器下了个包"变成"agent 可以放心执行"的那一道闸门。
 * - 版本钉死而不是"取最新":最新意味着每台机器的 arm-gcc 版本取决于它哪天装的,
 *   而清单 / 项目构建对版本敏感;升版本是一次显式的目录改动,和依赖锁一个道理。
 *
 * ## 不在表里的东西
 *
 * ESP-IDF(带 Python 环境的安装器)、Keil(注册)、STM32CubeMX / CubeProgrammer(ST 账号)、
 * J-Link(点击许可)—— 它们不是"解压即用"的分发形态,只能人装。arm-gnu-toolchain 没有
 * darwin-x64 的 15.x 构建(Arm 停发了),Intel Mac 用 brew。
 *
 * 更新这张表:改 URL/版本时同步改 sha256/bytes,`toolchain-catalog.test.ts` 会核它们的形状;
 * 真实文件的一致性由维护者发布前跑一次真实安装确认。
 */

export type ArchiveKind = "zip" | "tar.gz" | "tar.xz";

/** `${process.platform}-${process.arch}` 里我们认识的那几个。 */
export type HostKey = "win32-x64" | "win32-arm64" | "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export interface CatalogArtifact {
	url: string;
	/** 备选下载地址,按顺序在 url 之前尝试(运行期 `YOMA_TOOLCHAIN_MIRROR` 排在它们前面)。 */
	mirrors?: string[];
	/** 十六进制小写。 */
	sha256: string;
	bytes: number;
	archive: ArchiveKind;
	/** 压缩包内成为"包目录"的那一层;空串 / 缺省 = 压缩包根本身。 */
	root?: string;
	/** 可执行文件所在的子目录(相对包目录);空串 = 包目录本身;缺省 "bin"。 */
	binDir?: string;
}

export interface CatalogPackage {
	/** 包 id,也是 `<configDir>/toolchains/<id>/<version>` 的目录名。 */
	id: string;
	/** 展示名,专有名词,不进 i18n。 */
	title: string;
	version: string;
	/** 这个包满足哪些工具 id(families.ts / 项目清单里的 id)。 */
	provides: string[];
	/** 包里可执行文件名的并集(不带扩展名),记账时按工具的声明名优先,这里兜底。 */
	bins: string[];
	homepage?: string;
	license?: string;
	artifacts: Partial<Record<HostKey, CatalogArtifact>>;
}

export const TOOLCHAIN_MIRROR_ENV = "YOMA_TOOLCHAIN_MIRROR";

const ARM_BASE = "https://developer.arm.com/-/media/Files/downloads/gnu/15.2.rel1/binrel";
const ARM_VERSION = "15.2.rel1";
const armRoot = (host: string) => `arm-gnu-toolchain-${ARM_VERSION}-${host}-arm-none-eabi`;

const CMAKE_VERSION = "4.4.3";
const CMAKE_BASE = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}`;

const NINJA_VERSION = "1.13.2";
const NINJA_BASE = `https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}`;

const OPENOCD_VERSION = "0.12.0-7";
const OPENOCD_BASE = `https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v${OPENOCD_VERSION}`;

const MINGIT_VERSION = "2.55.0.5";
const MINGIT_BASE = "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5";

export const TOOLCHAIN_CATALOG: readonly CatalogPackage[] = [
	{
		id: "arm-gnu-toolchain",
		title: "Arm GNU Toolchain",
		version: ARM_VERSION,
		provides: ["arm-gcc", "arm-gdb"],
		bins: ["arm-none-eabi-gcc", "arm-none-eabi-g++", "arm-none-eabi-objcopy", "arm-none-eabi-size", "arm-none-eabi-gdb"],
		homepage: "https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads",
		license: "GPL-3.0 (binaries redistributed by Arm)",
		artifacts: {
			// 实测(2026-09-05):Windows 的 zip **没有**顶层包装目录,bin/ lib/ arm-none-eabi/ 直接在根上;
			// Linux / macOS 的 tar.xz 才有 arm-gnu-toolchain-<ver>-<host>-arm-none-eabi/ 这一层。
			"win32-x64": {
				url: `${ARM_BASE}/${armRoot("mingw-w64-x86_64")}.zip`,
				sha256: "7936cac895611023ffb22a64b8e426098c7104cb689778c1894572ca840b9ece",
				bytes: 295922350,
				archive: "zip",
				root: "",
				binDir: "bin",
			},
			"linux-x64": {
				url: `${ARM_BASE}/${armRoot("x86_64")}.tar.xz`,
				sha256: "597893282ac8c6ab1a4073977f2362990184599643b4c5ee34870a8215783a16",
				bytes: 155499480,
				archive: "tar.xz",
				root: armRoot("x86_64"),
				binDir: "bin",
			},
			"linux-arm64": {
				url: `${ARM_BASE}/${armRoot("aarch64")}.tar.xz`,
				sha256: "d061559d814b205ed30c5b7c577c03317ec447ca51cd5a159d26b12a5bbeb20c",
				bytes: 149029088,
				archive: "tar.xz",
				root: armRoot("aarch64"),
				binDir: "bin",
			},
			"darwin-arm64": {
				url: `${ARM_BASE}/${armRoot("darwin-arm64")}.tar.xz`,
				sha256: "1938a84b7105c192e3fb4fa5e893ba25f425f7ddab40515ae608cd40f68669a8",
				bytes: 141961944,
				archive: "tar.xz",
				root: armRoot("darwin-arm64"),
				binDir: "bin",
			},
		},
	},
	{
		id: "cmake",
		title: "CMake",
		version: CMAKE_VERSION,
		provides: ["cmake"],
		bins: ["cmake", "ctest", "cpack"],
		homepage: "https://cmake.org/download/",
		license: "BSD-3-Clause",
		artifacts: {
			"win32-x64": {
				url: `${CMAKE_BASE}/cmake-${CMAKE_VERSION}-windows-x86_64.zip`,
				sha256: "4d52ebab7193a698651639ed80d8d04fd903358843572cf44c7fd234cb7c26ab",
				bytes: 54408599,
				archive: "zip",
				root: `cmake-${CMAKE_VERSION}-windows-x86_64`,
				binDir: "bin",
			},
			"linux-x64": {
				url: `${CMAKE_BASE}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz`,
				sha256: "d6c83076c575bc00b823522ac974bda66d0af05d6ddc30e739c12385cf32c6cc",
				bytes: 64872980,
				archive: "tar.gz",
				root: `cmake-${CMAKE_VERSION}-linux-x86_64`,
				binDir: "bin",
			},
			"linux-arm64": {
				url: `${CMAKE_BASE}/cmake-${CMAKE_VERSION}-linux-aarch64.tar.gz`,
				sha256: "2efc974dbd63b4444c0e8494b92f2e80c2d7e635b4b80eac2916985ddd8f72a6",
				bytes: 52036576,
				archive: "tar.gz",
				root: `cmake-${CMAKE_VERSION}-linux-aarch64`,
				binDir: "bin",
			},
			"darwin-arm64": {
				url: `${CMAKE_BASE}/cmake-${CMAKE_VERSION}-macos-universal.tar.gz`,
				sha256: "0c5d65251c14cc884bfa16bdbed3c263ce5bffe2e21c0d0d00962cb0610464fa",
				bytes: 89445170,
				archive: "tar.gz",
				root: `cmake-${CMAKE_VERSION}-macos-universal/CMake.app/Contents`,
				binDir: "bin",
			},
			"darwin-x64": {
				url: `${CMAKE_BASE}/cmake-${CMAKE_VERSION}-macos-universal.tar.gz`,
				sha256: "0c5d65251c14cc884bfa16bdbed3c263ce5bffe2e21c0d0d00962cb0610464fa",
				bytes: 89445170,
				archive: "tar.gz",
				root: `cmake-${CMAKE_VERSION}-macos-universal/CMake.app/Contents`,
				binDir: "bin",
			},
		},
	},
	{
		id: "ninja",
		title: "Ninja",
		version: NINJA_VERSION,
		provides: ["ninja"],
		bins: ["ninja"],
		homepage: "https://ninja-build.org/",
		license: "Apache-2.0",
		artifacts: {
			"win32-x64": {
				url: `${NINJA_BASE}/ninja-win.zip`,
				sha256: "07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65",
				bytes: 291570,
				archive: "zip",
				root: "",
				binDir: "",
			},
			"linux-x64": {
				url: `${NINJA_BASE}/ninja-linux.zip`,
				sha256: "5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6",
				bytes: 134040,
				archive: "zip",
				root: "",
				binDir: "",
			},
			"linux-arm64": {
				url: `${NINJA_BASE}/ninja-linux-aarch64.zip`,
				sha256: "fd2cacc8050a7f12a16a2e48f9e06fca5c14fc4c2bee2babb67b58be17a607fc",
				bytes: 126256,
				archive: "zip",
				root: "",
				binDir: "",
			},
			"darwin-arm64": {
				url: `${NINJA_BASE}/ninja-mac.zip`,
				sha256: "c99048673aa765960a99cf10c6ddb9f1fad506099ff0a0e137ad8960a88f321b",
				bytes: 314051,
				archive: "zip",
				root: "",
				binDir: "",
			},
			"darwin-x64": {
				url: `${NINJA_BASE}/ninja-mac.zip`,
				sha256: "c99048673aa765960a99cf10c6ddb9f1fad506099ff0a0e137ad8960a88f321b",
				bytes: 314051,
				archive: "zip",
				root: "",
				binDir: "",
			},
		},
	},
	{
		id: "openocd",
		title: "OpenOCD (xPack)",
		version: OPENOCD_VERSION,
		provides: ["openocd"],
		bins: ["openocd"],
		homepage: "https://xpack-dev-tools.github.io/openocd-xpack/",
		license: "GPL-2.0",
		artifacts: {
			"win32-x64": {
				url: `${OPENOCD_BASE}/xpack-openocd-${OPENOCD_VERSION}-win32-x64.zip`,
				sha256: "6bfd3c97135aafef8affc9af1acf34fd0e2b9ca26044506f6abd7f95b7630052",
				bytes: 3225998,
				archive: "zip",
				root: `xpack-openocd-${OPENOCD_VERSION}`,
				binDir: "bin",
			},
			"linux-x64": {
				url: `${OPENOCD_BASE}/xpack-openocd-${OPENOCD_VERSION}-linux-x64.tar.gz`,
				sha256: "94b3790983beaf8ed57e646c0620dd66d705fddae03d290823a6ed3b439468d6",
				bytes: 2802056,
				archive: "tar.gz",
				root: `xpack-openocd-${OPENOCD_VERSION}`,
				binDir: "bin",
			},
			"linux-arm64": {
				url: `${OPENOCD_BASE}/xpack-openocd-${OPENOCD_VERSION}-linux-arm64.tar.gz`,
				sha256: "db73a3ab91c556ecec2405a7e02d404b11139df6aba1031cad94a7e6766d06cc",
				bytes: 2736149,
				archive: "tar.gz",
				root: `xpack-openocd-${OPENOCD_VERSION}`,
				binDir: "bin",
			},
			"darwin-arm64": {
				url: `${OPENOCD_BASE}/xpack-openocd-${OPENOCD_VERSION}-darwin-arm64.tar.gz`,
				sha256: "667342c086984f3e5a55b4e0d5f711add13fb04de040fca493303000e6c19327",
				bytes: 2385815,
				archive: "tar.gz",
				root: `xpack-openocd-${OPENOCD_VERSION}`,
				binDir: "bin",
			},
			"darwin-x64": {
				url: `${OPENOCD_BASE}/xpack-openocd-${OPENOCD_VERSION}-darwin-x64.tar.gz`,
				sha256: "668ad25350103a4357e11629ec833eae5982e973889ce25bad0c2963e37fa8bf",
				bytes: 2481762,
				archive: "tar.gz",
				root: `xpack-openocd-${OPENOCD_VERSION}`,
				binDir: "bin",
			},
		},
	},
	{
		// MinGit:便携版 git,只给 Windows —— macOS 的 git 随 Xcode 命令行工具、Linux 走包管理器。
		id: "git",
		title: "Git (MinGit)",
		version: MINGIT_VERSION,
		provides: ["git"],
		bins: ["git"],
		homepage: "https://gitforwindows.org/",
		license: "GPL-2.0",
		artifacts: {
			"win32-x64": {
				url: `${MINGIT_BASE}/MinGit-${MINGIT_VERSION}-64-bit.zip`,
				sha256: "56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e",
				bytes: 38989688,
				archive: "zip",
				root: "",
				binDir: "cmd",
			},
		},
	},
];

/** `${platform}-${arch}` → HostKey;不认识的组合(如 win32-ia32)返回 undefined。 */
export function hostKey(platform: string = process.platform, arch: string = process.arch): HostKey | undefined {
	const key = `${platform}-${arch}`;
	switch (key) {
		case "win32-x64":
		case "win32-arm64":
		case "darwin-arm64":
		case "darwin-x64":
		case "linux-x64":
		case "linux-arm64":
			return key;
		default:
			return undefined;
	}
}

/** 第一个 provides 包含 toolId 的包。 */
export function catalogPackageFor(
	toolId: string,
	catalog: readonly CatalogPackage[] = TOOLCHAIN_CATALOG,
): CatalogPackage | undefined {
	return catalog.find((pkg) => pkg.provides.includes(toolId));
}

export function catalogArtifact(pkg: CatalogPackage, host: HostKey | undefined): CatalogArtifact | undefined {
	return host === undefined ? undefined : pkg.artifacts[host];
}

/** 给 UI / 提示词看的"能装"摘要 —— 不带 URL 与 sha,那些是 install.ts 的事。 */
export interface Installable {
	packageId: string;
	title: string;
	version: string;
	bytes: number;
}

export function installableFor(
	toolId: string,
	host: HostKey | undefined,
	catalog: readonly CatalogPackage[] = TOOLCHAIN_CATALOG,
): Installable | undefined {
	const pkg = catalogPackageFor(toolId, catalog);
	if (!pkg) return undefined;
	const artifact = catalogArtifact(pkg, host);
	if (!artifact) return undefined;
	return { packageId: pkg.id, title: pkg.title, version: pkg.version, bytes: artifact.bytes };
}
