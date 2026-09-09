// 压缩 / 分支摘要共用的模型调用:不写缓存、独立 sessionId、瞬时错误重试。
import {
	type AssistantMessage,
	type Context,
	type Model,
	type Models,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../../types.ts";

/** 与 kernel/src/host/retry.ts 的轮级重试同一组数值。 */
export const SUMMARY_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

export function completeSummary(
	models: Models,
	model: Model<any>,
	context: Context,
	options: { maxTokens: number; signal?: AbortSignal; thinkingLevel?: ThinkingLevel },
): Promise<AssistantMessage> {
	const { maxTokens, signal, thinkingLevel } = options;
	const reasoning = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : undefined;
	const sessionId = uuidv7();
	return retryAssistantCall(
		() =>
			models.completeSimple(model, context, {
				maxTokens,
				signal,
				...(reasoning && { reasoning }),
				cacheRetention: "none",
				sessionId,
			}),
		SUMMARY_RETRY,
		signal,
	);
}
