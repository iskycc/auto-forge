import { createHash, createHmac } from "node:crypto";
import {
  AiResourceDeferral,
  AiModelRequestError,
  AI_EVIDENCE_INPUT_POLICY,
  type AiAnalysisRepository,
  type AiEvidence,
  type AiWork,
  type ExecutionControlRepository,
  type JarObjectStorePort,
} from "@autoforge/application";
import type { AiModelConfiguration } from "@autoforge/contracts";
import { isDomainError } from "@autoforge/domain";
import { parseSafeAnsiStream, type AnsiParserState } from "../src/lib/safe-ansi";
import {
  prepareAiText,
  shortenAiInput,
  redactAiJson,
  redactAiText,
  AI_INPUT_MAXIMUM_CHARACTERS,
} from "./ai-input-text";
export { redactAiJson, redactAiText } from "./ai-input-text";

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
    const inputTransformations: string[] = [];
    const evidence: AiEvidence = {
      version: 1,
      inputPolicy: AI_EVIDENCE_INPUT_POLICY,
      inputTransformations,
      stdoutComplete: true,
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
        AI_INPUT_MAXIMUM_CHARACTERS,
        Math.floor(
          (configuration.contextTokens -
            configuration.outputTokens * 4 -
            5600 -
            Buffer.byteLength(JSON.stringify(configuration.referencePrompts))) /
            6,
        ),
      ),
    );
    const append = async (text: string, label: string) => {
      if (remaining === 0) return;
      const redacted = redactAiText(text);
      for (const fragment of evidenceTextParts(redacted, partCharacters)) {
        signal.throwIfAborted();
        if (!this.canWork()) throw new AiResourceDeferral();
        if (evidence.parts.length >= 4096) {
          evidence.limitations.push(
            "证据分片超过本次清单预算，剩余正文未分析；可增大上下文后重新分析。",
          );
          remaining = 0;
          return;
        }
        const content = Buffer.from(fragment, "utf8");
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
      const executionInput = Object.fromEntries(
        ["class_name", "display_name", "case_type", "class_data_json", "parameters_json"]
          .filter((key) => source[key] !== undefined && source[key] !== null)
          .map((key) => [key, source[key]]),
      );
      for (const key of ["class_data_json", "parameters_json"]) {
        if (typeof executionInput[key] === "string") {
          try {
            executionInput[key] = JSON.parse(executionInput[key]);
          } catch {
            evidence.limitations.push(`${key} 不是可解析的 JSON，按文本处理。`);
          }
        }
      }
      let shortenedInput = false;
      await append(
        redactAiJson(executionInput, () => {
          shortenedInput = true;
        }),
        "input",
      );
      if (shortenedInput)
        inputTransformations.push("业务字段超过 5000 字符时仅保留末尾 2500 字符。");
      if (source.input_truncated) evidence.limitations.push("执行输入超过 8 MiB，未取得完整输入。");
    } else evidence.limitations.push("没有可读取的实际尝试或执行快照。");
    let stdoutBytes = 0;
    let ansiState: AnsiParserState | undefined;
    let afterSequence = -1;
    while (remaining > 0 && evidence.stdoutComplete) {
      signal.throwIfAborted();
      const page = await this.readStdoutPage(work.attemptId, afterSequence, signal);
      for (const chunk of page.items) {
        signal.throwIfAborted();
        if (!this.canWork()) throw new AiResourceDeferral();
        stdoutBytes += Buffer.byteLength(chunk.content);
        if (stdoutBytes > configuration.maximumEvidenceMiB * 1048576) {
          evidence.stdoutComplete = false;
          evidence.limitations.push("stdout 日志超出配置的采集空间预算，无法确认完整堆栈。");
          break;
        }
        const parsed = parseSafeAnsiStream(chunk.content, ansiState);
        ansiState = parsed.state;
        stackTexts.push(parsed.segments.map((segment) => segment.text).join(""));
      }
      if (page.truncated) {
        evidence.stdoutComplete = false;
        evidence.limitations.push("stdout 日志读取不完整或已离线归档。");
      }
      const last = page.items.at(-1)?.sequence;
      if (last === undefined || last <= afterSequence || page.nextSequence === undefined) break;
      afterSequence = last;
    }
    if (remaining === 0 && !evidence.limitations.some((value) => value.includes("预算")))
      evidence.limitations.push("用例证据达到采集空间预算，无法确认剩余日志已完整读取。");
    const stdout = stackTexts.join("");
    if (remaining === 0 || !stdout.length) {
      evidence.stdoutComplete = false;
      if (!stdout.length) evidence.limitations.push("没有可读取的 stdout 业务日志正文。");
    }
    const preparedStdout = shortenAiInput(redactAiText(stdout));
    if (preparedStdout.shortened)
      inputTransformations.push(
        "stdout 正文超过 5000 字符，仅提供末尾 2500 字符，不代表完整日志。",
      );
    await append(preparedStdout.text, "stdout");
    if (remaining === 0) evidence.stdoutComplete = false;
    const stacks = [...new Set(extractCompleteStacks(stdout, evidence.stdoutComplete))].sort();
    if (stacks.length && evidence.stdoutComplete)
      evidence.signature = `exact-stack-bundle-v2:${createHmac("sha256", this.signatureKey).update(JSON.stringify(stacks)).digest("hex")}`;
    else evidence.limitations.push("未取得可确认完整的堆栈集合；此项独立保留，不按摘要前缀合并。");
    if (work.strategy === "single_full_v2" && !evidence.stdoutComplete)
      throw new AiModelRequestError(
        `无法完成全文日志分析：${evidence.limitations.join("；")}请检查日志可用性或提高每例证据预算后重试。`,
        false,
      );
    if (stacks.length && evidence.signature.startsWith("exact-stack-bundle-")) {
      evidence.stackParts = [];
      const preparedStack = prepareAiText(stacks.join("\n\n"));
      if (preparedStack.shortened)
        inputTransformations.push(
          "堆栈文本超过 5000 字符，仅提供末尾 2500 字符；分组签名仍使用完整堆栈。",
        );
      for (const fragment of evidenceTextParts(preparedStack.text, partCharacters)) {
        signal.throwIfAborted();
        if (!this.canWork()) throw new AiResourceDeferral();
        const content = Buffer.from(fragment);
        const id = `stack-${evidence.stackParts.length + 1}`;
        const objectKey = `${prefix}/stacks/${id}-${digest(content)}.txt`;
        await put(this.objects, objectKey, content, "text/plain; charset=utf-8");
        evidence.stackParts.push({ id, objectKey, sizeBytes: content.length });
      }
    }
    const key = `${prefix}/manifest.json`;
    await put(this.objects, key, Buffer.from(JSON.stringify(evidence)), "application/json");
    return { key, evidence };
  }
  private async readStdoutPage(attemptId: string, afterSequence: number, signal: AbortSignal) {
    try {
      return await this.logs.listLogChunks({
        attemptId,
        stream: "stdout",
        afterSequence,
        limit: 16,
      });
    } catch (cause) {
      if (signal.aborted || cause instanceof AiResourceDeferral) throw cause;
      if (this.isBusy(cause) || (isDomainError(cause) && cause.code === "PLATFORM_LOG_BUSY"))
        throw new AiResourceDeferral({ cause });
      // Infrastructure domain messages are sanitized; raw driver messages may contain credentials.
      const knownFailure = isDomainError(cause);
      throw new AiModelRequestError(
        knownFailure
          ? `stdout 日志读取失败，${cause.code}：${cause.message}`
          : "stdout 日志读取失败，请检查日志服务连接、权限及归档状态后重试。",
        !knownFailure || cause.code === "PLATFORM_LOG_DATABASE_UNAVAILABLE",
        undefined,
        { cause },
      );
    }
  }
  async read(key: string): Promise<AiEvidence> {
    const evidence = JSON.parse(
      Buffer.from(await this.objects.read(key)).toString("utf8"),
    ) as AiEvidence;
    if (evidence.inputPolicy !== AI_EVIDENCE_INPUT_POLICY)
      throw new AiModelRequestError(
        "AI 证据处理规则已更新（清理颜色及长文本尾部裁剪），请重新分析以生成新证据。",
        false,
      );
    return evidence;
  }
  async part(part: AiEvidence["parts"][number]) {
    return Buffer.from(await this.objects.read(part.objectKey)).toString("utf8");
  }
}
/** UTF-16 slice boundaries must not replace half of a non-BMP log character during UTF-8 encoding. */
function* evidenceTextParts(text: string, maximumCharacters: number): Generator<string> {
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maximumCharacters);
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(text[end]!)
    )
      end -= 1;
    yield text.slice(offset, end);
    offset = end;
  }
}
/** Conservatively group only complete exception blocks, never the 4,096-character summary. */
export function extractCompleteStacks(text: string, complete = false): string[] {
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
  for (const rawLine of lines) {
    const line = normalizeStackLogLine(rawLine);
    if (/^[\w.$]+(?:Exception|Error)(?::.*)?$/u.test(line)) {
      if (current.length) finish();
      current = [line];
    } else if (current.length) {
      if (/^\s+(?:at\s+|Suppressed:|Caused by:|\.\.\.\s+\d+\s+more)|^Caused by:/u.test(line))
        current.push(line);
      else finish();
    }
  }
  // EOF closes a block only when the log repository confirmed the complete stdout stream.
  if (complete) finish();
  return stacks;
}
function normalizeStackLogLine(line: string): string {
  const cause = line.match(/(?:^|\s)((?:Caused by:|Suppressed:|\.\.\.\s+\d+\s+more).*)$/u);
  if (cause) return cause[1]!.startsWith("Caused by:") ? cause[1]! : `\t${cause[1]}`;
  const exception = line.match(/(?:^|\s|\])([\w.$]+(?:Exception|Error)(?::.*)?)$/u);
  if (exception) return exception[1]!;
  const frame = line.match(/(?:^|\s)(at\s+[\w.$/<>]+\([^\n]*\))\s*$/u);
  if (frame) return `\tat ${frame[1]!.slice(3).trim()}`;
  return line.trimEnd();
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
