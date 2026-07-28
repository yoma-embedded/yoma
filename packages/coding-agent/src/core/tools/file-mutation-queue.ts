/**
 * 同一个文件的修改串行化;不同文件仍然并行。
 * 移植自 pi coding-agent/src/core/tools/file-mutation-queue.ts。
 *
 * 为什么需要它:模型可以在一轮里并行发出多个 write/edit。两个 edit 打同一个文件时,
 * 后者必须看到前者写完的内容,否则"先读后写"的读会读到旧版本,一次修改被悄悄丢掉。
 *
 * 与 pi 的差异:键的规范化用注入的 FileSystem.canonicalPath(pi 用 node:fs 的 realpath),
 * 路径不存在时退回绝对路径 —— 新建文件的场景本来就还没有 realpath。
 */
import type { FileSystem } from "@yoma/my-pi";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

async function getMutationQueueKey(env: FileSystem, filePath: string): Promise<string> {
	const absolute = await env.absolutePath(filePath);
	const resolvedPath = absolute.ok ? absolute.value : filePath;
	// 走一次 canonicalPath,这样 a/b 与 a/../a/b、以及符号链接指向同一文件时用同一把锁。
	const canonical = await env.canonicalPath(resolvedPath);
	return canonical.ok ? canonical.value : resolvedPath;
}

export async function withFileMutationQueue<T>(env: FileSystem, filePath: string, fn: () => Promise<T>): Promise<T> {
	// registrationQueue 让"取键 + 挂链"这一步本身也串行,避免两个调用同时读到同一个 currentQueue。
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(env, filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
