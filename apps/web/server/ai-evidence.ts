import { createHash, createHmac } from "node:crypto";
import {
  AiResourceDeferral,
  type AiAnalysisRepository,
  type AiEvidence,
  type AiWork,
  type ExecutionControlRepository,
  type JarObjectStorePort,
} from "@autoforge/application";
import type { AiModelConfiguration } from "@autoforge/contracts";

export class AiEvidenceStore {
  constructor(
    private readonly repository: AiAnalysisRepository,
    private readonly logs: ExecutionControlRepository,
    private readonly objects: JarObjectStorePort,
    private readonly signatureKey: string,
    private readonly canWork: () => boolean = () => true,
    private readonly isBusy: (error: unknown) => boolean = () => false,
  ) {}
  async collect(
    work: AiWork,
    configuration: AiModelConfiguration,
    signal: AbortSignal,
  ): Promise<{ key: string; evidence: AiEvidence }> {
    const source = await this.repository.source(work.attemptId);
    const evidence: AiEvidence = {
      version: 1,
      executionRunId: work.executionRunId,
      attemptId: work.attemptId,
      parts: [],
      limitations: [],
      signature: `unclassified:${work.id}`,
    };
    const prefix = `ai-analysis/${work.projectId}/${work.jobId}/${work.executionRunId}`;
    let remaining = configuration.maximumEvidenceMiB * 1048576;
    const stackTexts: string[] = [];
    const partCharacters = Math.max(
      512,
      Math.min(
        8000,
        Math.floor((configuration.contextTokens - configuration.outputTokens * 4 - 4000) / 6),
      ),
    );
    const append = async (text: string, label: string) => {
      if (remaining === 0) return;
      const redacted = redactAiText(text);
      for (let offset = 0; offset < redacted.length; offset += partCharacters) {
        signal.throwIfAborted();
        if (!this.canWork()) throw new AiResourceDeferral();
        if (evidence.parts.length >= 4096) {
          evidence.limitations.push(
            "证据分片超过本次清单预算，剩余正文未分析；可增大上下文后重新分析。",
          );
          remaining = 0;
          return;
        }
        const content = Buffer.from(redacted.slice(offset, offset + partCharacters), "utf8");
        if (content.length > remaining) {
          remaining = 0;
          if (!evidence.limitations.includes("用例证据超出配置的采集空间预算，剩余正文未分析。"))
            evidence.limitations.push("用例证据超出配置的采集空间预算，剩余正文未分析。");
          return;
        }
        remaining -= content.length;
        const id = `${label}-${evidence.parts.length + 1}`;
        const objectKey = `${prefix}/parts/${id}-${digest(content)}.txt`;
        await put(this.objects, objectKey, content, "text/plain; charset=utf-8");
        evidence.parts.push({ id, objectKey, sizeBytes: content.length });
      }
    };
    if (source) {
      const executionInput = { ...source };
      for (const key of ["class_data_json", "parameters_json"]) {
        if (typeof executionInput[key] === "string") {
          try {
            executionInput[key] = JSON.parse(executionInput[key]);
          } catch {
            evidence.limitations.push(`${key} 不是可解析的 JSON，按文本处理。`);
          }
        }
      }
      await append(redactAiJson(executionInput), "input");
      if (source.input_truncated) evidence.limitations.push("执行输入超过 8 MiB，未取得完整输入。");
    } else evidence.limitations.push("没有可读取的实际尝试或执行快照。");
    for (const stream of ["stdout", "stderr", "agent"] as const) {
      let afterSequence = -1;
      try {
        while (remaining > 0) {
          signal.throwIfAborted();
          const page = await this.logs.listLogChunks({
            attemptId: work.attemptId,
            stream,
            afterSequence,
            limit: 16,
          });
          for (const chunk of page.items) {
            await append(
              `[${stream} sequence=${chunk.sequence} time=${chunk.recordedAt}]\n${chunk.content}`,
              stream,
            );
            if (stream !== "agent" && remaining > 0) stackTexts.push(chunk.content);
          }
          if (page.truncated) evidence.limitations.push(`${stream} 日志读取不完整或已离线归档。`);
          const last = page.items.at(-1)?.sequence;
          if (last === undefined || last <= afterSequence || page.nextSequence === undefined) break;
          afterSequence = last;
        }
      } catch (error) {
        if (signal.aborted || error instanceof AiResourceDeferral) throw error;
        if (this.isBusy(error)) throw new AiResourceDeferral({ cause: error });
        evidence.limitations.push(`${stream} 日志读取失败，无法断言该流没有错误。`);
      }
    }
    const stacks = extractCompleteStacks(stackTexts.join(""));
    if (stacks.length && !evidence.limitations.length)
      evidence.signature = `exact-stack-bundle-v1:${createHmac("sha256", this.signatureKey).update(JSON.stringify(stacks)).digest("hex")}`;
    else evidence.limitations.push("未取得可确认完整的堆栈集合；此项独立保留，不按摘要前缀合并。");
    const key = `${prefix}/manifest.json`;
    await put(this.objects, key, Buffer.from(JSON.stringify(evidence)), "application/json");
    return { key, evidence };
  }
  async read(key: string): Promise<AiEvidence> {
    return JSON.parse(Buffer.from(await this.objects.read(key)).toString("utf8")) as AiEvidence;
  }
  async part(part: AiEvidence["parts"][number]) {
    return Buffer.from(await this.objects.read(part.objectKey)).toString("utf8");
  }
}
/** Conservatively group only complete exception blocks, never the 4,096-character summary. */
export function extractCompleteStacks(text: string): string[] {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split("\n");
  const stacks: string[] = [];
  let current: string[] = [];
  const finish = () => {
    if (
      current.some((line) => /^\s+at\s+/u.test(line)) &&
      !current.some((line) => /truncated|已截断/iu.test(line))
    )
      stacks.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    if (/^[\w.$]+(?:Exception|Error)(?::.*)?$/u.test(line)) {
      if (current.length) finish();
      current = [line];
    } else if (current.length) {
      if (/^\s+(?:at\s+|Suppressed:|Caused by:|\.\.\.\s+\d+\s+more)|^Caused by:/u.test(line))
        current.push(line);
      else finish();
    }
  }
  // An unterminated final block may have been cut off; only a following delimiter closes it.
  return stacks;
}
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function put(
  objects: JarObjectStorePort,
  objectKey: string,
  content: Uint8Array,
  mediaType: string,
) {
  await objects.putObject({
    objectKey,
    sha256: digest(content),
    sizeBytes: content.length,
    mediaType,
    content: (async function* () {
      yield content;
    })(),
  });
}
/** Apply before splitting so secret values crossing a chunk boundary cannot leak. */
export function redactAiText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token)\s*["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}
export function redactAiJson(value: unknown) {
  return JSON.stringify(value, (key, cell: unknown) =>
    /(?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token|cookie|private[_-]?key)/iu.test(
      key,
    )
      ? "[REDACTED]"
      : typeof cell === "string"
        ? redactAiText(cell)
        : cell,
  );
}
