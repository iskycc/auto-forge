export type ValidationIssue = {
  code?: string;
  format?: string;
  message?: string;
  minimum?: number;
  path?: unknown[];
};

type IssueMessageOverride = (issue: ValidationIssue) => string | undefined;

export function validationIssueMessage(
  details: unknown,
  fieldLabels: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, IssueMessageOverride>> = {},
): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const issue = details.find(isValidationIssue);
  if (!issue) return undefined;
  const path =
    issue.path?.filter((part): part is string => typeof part === "string").join(".") ?? "";
  const label = fieldLabels[path] ?? path.split(".").at(-1) ?? "提交内容";
  return `${label}：${overrides[path]?.(issue) ?? defaultIssueMessage(issue)}`;
}

function defaultIssueMessage(issue: ValidationIssue): string {
  if (issue.code === "invalid_format" && issue.format === "url") {
    return "请输入包含协议的完整 URL，例如 https://autoforge.internal。";
  }
  if (issue.message?.trim()) return issue.message.trim();
  if (issue.code === "too_small" && typeof issue.minimum === "number") {
    return `至少需要 ${issue.minimum} 个字符或条目。`;
  }
  return "输入值不符合要求。";
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return Boolean(value && typeof value === "object" && "path" in value);
}
