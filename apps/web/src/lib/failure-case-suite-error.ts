import { z } from "zod";
import { ApiClientError } from "./client-api";

export type FailureCaseSuiteError = { message: string; details: string[]; requestId?: string };

const issueSchema = z.object({
  field: z.string().max(512).optional(),
  path: z
    .array(z.union([z.string().max(128), z.number()]))
    .max(16)
    .optional(),
  message: z.string().max(2048),
  code: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const fieldLabels: Record<string, string> = {
  name: "任务名称",
  configuration: "配置",
  concurrency: "并发上限",
  priority: "优先级",
  retryLimit: "重跑次数",
  retryMode: "重跑方式",
  runnerIds: "执行节点",
  runnerGroupId: "执行机组",
  adapter: "Adapter",
  environmentAddresses: "环境 IP",
  suiteName: "Suite 名称",
  testName: "Test 名称",
  projectVersionId: "项目版本",
  roundRecoveryRules: "轮次环境恢复",
  retryConcurrencyRules: "重跑并发规则",
  artifactPatterns: "产物规则",
  runnerLabels: "节点标签",
  queueTimeoutMs: "排队期限",
  claimTimeoutMs: "领取期限",
  uploadTimeoutMs: "上传期限",
  case: "用例",
};

const sourceLabels: Record<string, string> = {
  task_snapshot: "原任务配置快照",
  batch_snapshot: "执行批次配置快照",
  case_selection: "用例范围",
};

export function failureCaseSuiteError(cause: unknown, fallback: string): FailureCaseSuiteError {
  const message = cause instanceof Error ? cause.message : fallback;
  if (!(cause instanceof ApiClientError)) return { message, details: [] };
  const rawDetails = cause.details;
  const context = z
    .object({ source: z.string().optional(), issues: z.array(z.unknown()) })
    .safeParse(rawDetails);
  const scope = context.success ? (sourceLabels[context.data.source ?? ""] ?? "") : "";
  const rawIssues = Array.isArray(rawDetails)
    ? rawDetails
    : context.success
      ? context.data.issues
      : [];
  const details: string[] = [];
  for (const issue of rawIssues.slice(0, 10)) {
    const parsed = issueSchema.safeParse(issue);
    if (!parsed.success) continue;
    const value = parsed.data;
    const field = value.field ?? value.path?.map(String).join(".") ?? "configuration";
    const label = field
      .split(".")
      .map((part) => fieldLabels[part] ?? part)
      .join(" / ");
    const reason = cause.code === "VALIDATION_FAILED" ? validationReason(value) : value.message;
    details.push(`${scope ? `${scope} · ` : ""}${label || "配置"}：${reason}`);
  }
  return { message, details, ...(cause.requestId ? { requestId: cause.requestId } : {}) };
}

function validationReason(issue: z.infer<typeof issueSchema>): string {
  if (issue.code === "too_small" && issue.minimum !== undefined)
    return `内容不能为空或少于 ${issue.minimum} 个字符。`;
  if (issue.code === "too_big" && issue.maximum !== undefined)
    return `不能超过 ${issue.maximum} 个字符或条目。`;
  if (issue.code === "unrecognized_keys") return "请求包含不支持的字段，请刷新页面后重试。";
  if (issue.code === "invalid_type") return "字段类型不正确。";
  return "字段格式或取值不符合要求，请检查后重试。";
}
