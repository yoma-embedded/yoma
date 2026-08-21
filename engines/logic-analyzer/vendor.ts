#!/usr/bin/env bun
// 把 DSView(DreamSourceLab,GPLv3)里我们需要的那几个子树拷进 vendor/,钉住提交。
//   bun engines/logic-analyzer/vendor.ts --from D:\toy\DSView
//
// 拷的是**子集**,不是整棵树:采集库 libsigrok4DSL、解码库 libsigrokdecode4DSL(含 150 个
// Python 解码器)、它们共用的 common/(minizip + xlog)、固件与 FPGA 位流 res/(MIT,见
// res/license.txt),以及一个 .dsl 样例(demo/logic/protocol.demo)当 decode 路径的黄金文件。
// Qt 界面、FFTW、测试、打包脚本一概不要 —— 引擎只做"碰硬件"和"跑解码器"两件事。
//
// 为什么 vendored 而不是 submodule:与 engines/ 其余部分同一条纪律(2026-08-17 两个引擎仓
// 整体吸收进本仓);而且我们要对上游打补丁(Python 3.13+ 移除了 PyEval_InitThreads 等),
// 补丁住在本仓里比住在 fork 仓里更容易被 typecheck/CI 看见。补丁文件在 patches/,
// 本脚本拷完源码后逐个应用;重新 vendored 一个新提交时,冲突会在这一步直接暴露。
// libsigrokdecode4DSL 的 config.h / version.h 不 vendor:那是 autotools 产物、上游 gitignore,
// 由 CMakeLists.txt 从 *.in 生成。
//
// 版本记在 vendor/UPSTREAM.json;引擎 --version 会把它印出来,这样"用户的 DSView 比我们
// 内置的固件新"这种 HDL 版本不匹配才有得查。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, "vendor");

const fromAt = process.argv.indexOf("--from");
const from = fromAt >= 0 && process.argv[fromAt + 1] ? path.resolve(process.argv[fromAt + 1]!) : "";
if (!from || !existsSync(path.join(from, "libsigrok4DSL", "libsigrok.h"))) {
	console.error("用法: bun engines/logic-analyzer/vendor.ts --from <DSView 检出目录>");
	process.exit(2);
}

/** 要拷的子树:[源相对路径, 目标相对路径, 排除的顶层条目] */
const SUBTREES: Array<[string, string, string[]]> = [
	["libsigrok4DSL", "libsigrok4DSL", ["tests"]],
	["libsigrokdecode4DSL", "libsigrokdecode4DSL", ["contrib"]],
	["common", "common", []],
	["DSView/res", "res", []],
	["DSView/demo", "demo", []],
];
/** minizip 里带 main() 的 demo 与我们用不到的工具 —— 不进来,省得误编。 */
const DROP_FILES = ["common/minizip/miniunz.c", "common/minizip/minizip.c", "common/minizip/mztools.c", "common/minizip/mztools.h"];

const commit = (await $`git -C ${from} rev-parse HEAD`.text()).trim();
const describe = (await $`git -C ${from} describe --tags --always`.text()).trim();
const remote = (await $`git -C ${from} remote get-url origin`.text().catch(() => "")).trim();

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

for (const [src, dst, exclude] of SUBTREES) {
	const s = path.join(from, src);
	const d = path.join(vendor, dst);
	cpSync(s, d, {
		recursive: true,
		filter: (p) => {
			const rel = path.relative(s, p);
			if (!rel) return true;
			const top = rel.split(path.sep)[0]!;
			if (exclude.includes(top)) return false;
			if (/__pycache__|\.pyc$/.test(rel)) return false;
			return true;
		},
	});
}
for (const f of DROP_FILES) rmSync(path.join(vendor, f), { force: true });
cpSync(path.join(from, "COPYING"), path.join(vendor, "COPYING"));

// 应用补丁(patches/*.patch,按文件名顺序;-p1 相对 vendor/)。
const patches = path.join(here, "patches");
if (existsSync(patches)) {
	for (const name of readdirSync(patches).filter((n) => n.endsWith(".patch")).sort()) {
		const file = path.join(patches, name);
		const r = await $`git apply --directory=engines/logic-analyzer/vendor --verbose ${file}`.cwd(path.resolve(here, "..", "..")).nothrow();
		if (r.exitCode !== 0) {
			console.error(`补丁 ${name} 应用失败 —— 上游这次改动碰到了我们打补丁的地方,先合补丁再 vendored。`);
			process.exit(1);
		}
		console.log(`patched  ${name}`);
	}
}

let files = 0, bytes = 0;
const walk = (p: string) => {
	for (const e of readdirSync(p, { withFileTypes: true })) {
		const q = path.join(p, e.name);
		if (e.isDirectory()) walk(q);
		else { files++; bytes += statSync(q).size; }
	}
};
walk(vendor);

writeFileSync(
	path.join(vendor, "UPSTREAM.json"),
	JSON.stringify({ repo: remote || "https://github.com/DreamSourceLab/DSView", commit, describe, subtrees: SUBTREES.map(([s, d]) => `${s} -> ${d}`), vendoredAt: new Date().toISOString().slice(0, 10) }, null, "\t") + "\n",
);
console.log(`vendored DSView ${describe} (${commit.slice(0, 10)}) → ${path.relative(process.cwd(), vendor)}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
