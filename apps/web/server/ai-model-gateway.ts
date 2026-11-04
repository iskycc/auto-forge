import {
  AiModelRequestError,
  type AiModelGatewayPort,
  type AiModelMessage,
} from "@autoforge/application";
import { z } from "zod";

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().max(128),
                type: z.literal("function"),
                function: z.object({ name: z.string().max(64), arguments: z.string().max(100000) }),
              }),
            )
            .max(8)
            .optional(),
        }),
      }),
    )
    .min(1)
    .max(8),
});

/** Provider-neutral function calling; retries belong to durable work items, never this client. */
export class OpenAiCompatibleGateway implements AiModelGatewayPort {
  constructor(private readonly transport: typeof fetch = fetch) {}
  async complete(input: Parameters<AiModelGatewayPort["complete"]>[0]): Promise<AiModelMessage> {
    const url = new URL(`${input.configuration.baseUrl.replace(/\/+$/u, "")}/chat/completions`);
    if (["169.254.169.254", "metadata.google.internal"].includes(url.hostname))
      throw new AiModelRequestError("不允许使用主机元数据服务作为模型端点。", false);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.configuration.modelId,
          messages: input.messages,
          tools: input.tools,
          tool_choice: "required",
          parallel_tool_calls: false,
          max_tokens: input.configuration.outputTokens,
          stream: false,
        }),
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      throw new AiModelRequestError("模型网络连接失败，请检查模型端点或网络。", true, undefined, {
        cause: error,
      });
    }
    if (!response.ok) {
      const retry = retryAfter(response.headers.get("retry-after"));
      if (retry !== undefined && retry > 7 * 86400000)
        throw new AiModelRequestError(
          "模型要求等待超过 7 天，本次初析停止，请联系模型维护人。",
          false,
        );
      const text = await boundedText(response, 65536);
      const quota = /insufficient_quota|billing|quota_exceeded/iu.test(text);
      throw new AiModelRequestError(
        quota ? "模型额度或计费不足，请联系管理员。" : `模型请求失败（HTTP ${response.status}）。`,
        !quota && (response.status === 429 || response.status === 408 || response.status >= 500),
        retry,
      );
    }
    const decoded = responseSchema.safeParse(JSON.parse(await boundedText(response, 1024 * 1024)));
    if (!decoded.success)
      throw new AiModelRequestError("模型响应格式不兼容，请检查工具调用能力。", false);
    const choice = decoded.data.choices[0]!;
    if (choice.finish_reason === "length")
      throw new AiModelRequestError("模型输出被截断，请增加输出预算。", false);
    return {
      role: "assistant",
      content: choice.message.content ?? null,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    };
  }
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now ? time - now : undefined;
}
async function boundedText(response: Response, maximumBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new AiModelRequestError("模型响应超出大小限制。", false);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
