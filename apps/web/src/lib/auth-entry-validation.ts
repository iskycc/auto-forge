import { validationIssueMessage, type ValidationIssue } from "./form-validation";

const FIELD_LABELS: Record<string, string> = {
  bootstrapToken: "一次性管理员引导令牌",
  username: "用户名",
  displayName: "显示名称",
  password: "密码",
  provider: "登录来源",
};

export function authEntryValidationMessage(details: unknown): string | undefined {
  return validationIssueMessage(details, FIELD_LABELS, {
    bootstrapToken: bootstrapTokenMessage,
  });
}

function bootstrapTokenMessage(issue: ValidationIssue): string | undefined {
  return issue.code === "too_small"
    ? "请粘贴 config/initial-admin-token 文件中的完整令牌（至少 32 位）。"
    : undefined;
}
