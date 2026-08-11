import { validationIssueMessage, type ValidationIssue } from "./form-validation";

const FIELD_LABELS: Record<string, string> = {
  bootstrapToken: "平台配置引导令牌",
  "configuration.web.publicBaseUrl": "执行机可访问地址",
  "configuration.full.databaseUrl": "PostgreSQL URL",
  "configuration.full.natsServers": "NATS 地址",
  "configuration.full.redisUrl": "Redis URL",
  "configuration.full.minioEndpoint": "MinIO 地址",
  "configuration.full.minioAccessKey": "MinIO Access Key",
  "configuration.full.minioSecretKey": "MinIO Secret Key",
  "configuration.full.minioBucket": "MinIO Bucket",
  "configuration.full.minioRegion": "MinIO Region",
};

export function platformInitializationValidationMessage(details: unknown): string | undefined {
  return validationIssueMessage(details, FIELD_LABELS, {
    bootstrapToken: bootstrapTokenMessage,
  });
}

function bootstrapTokenMessage(issue: ValidationIssue): string | undefined {
  return issue.code === "too_small"
    ? "请粘贴 config/initial-admin-token 文件中的完整令牌（至少 32 位）。"
    : undefined;
}
