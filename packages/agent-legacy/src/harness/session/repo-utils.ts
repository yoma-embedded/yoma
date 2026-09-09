import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
import { Session } from "./session.ts";
import { uuidv7 } from "./uuid.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

/** FileSystem 的 Result 世界与 session 的 throw 世界之间的适配边界。 */
export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

/** fork 的取材逻辑(Step 5 的 repo 会用到):position "at" 含目标条目,"before" 要求目标是 user 消息。 */
export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
	} else {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	return storage.getPathToRoot(effectiveLeafId);
}
