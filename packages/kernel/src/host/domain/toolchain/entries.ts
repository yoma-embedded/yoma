/** 路径记录只说明用户保存了什么;入口定位必须复核文件类型和声明名。 */
import { statSync } from "node:fs";
import path from "node:path";
import { findOnPath, withPath } from "./locations.ts";
import type { ToolSpec } from "./schema.ts";

export function pathType(value: string): "file" | "dir" | undefined {
	try {
		const stat = statSync(value);
		return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : undefined;
	} catch {
		return undefined;
	}
}

/** 保留显式命名的文件映射;目录记录/单个入口的同目录兄弟文件按声明重新定位。 */
export function executableEntries(
	spec: ToolSpec,
	recorded: Record<string, string>,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	if (spec.pathKind === "dir") return {};
	const names = spec.bin ?? [];
	const files: Record<string, string> = {};
	const dirs: string[] = [];
	for (const [name, value] of Object.entries(recorded)) {
		const type = pathType(value);
		if (type === "dir") dirs.push(value, path.join(value, "bin"));
		if (type !== "file") continue;
		const declared = names.find((candidate) =>
			process.platform === "win32" ? candidate.toLowerCase() === name.toLowerCase() : candidate === name,
		);
		if (names.length === 0 || declared) {
			files[declared ?? name] = value;
			dirs.push(path.dirname(value));
		}
	}
	const searchEnv = withPath(env, [...new Set(dirs)]);
	for (const name of names) {
		const value = files[name] ?? findOnPath(name, searchEnv);
		if (value && pathType(value) === "file") files[name] = value;
	}
	return files;
}
