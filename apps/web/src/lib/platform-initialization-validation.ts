import { validationIssueMessage, type ValidationIssue } from "./form-validation";

const FIELD_LABELS: Record<string, string> = {
  bootstrapToken: "平台配置引导令牌",
  "configuration.web.publicBaseUrl": "外部访问地址",
  "configuration.web.runnerBaseUrl": "内部访问地址（Runner）",
  "configuration.full.databaseUrl": "PostgreSQL 主库连接信息",
  "configuration.full.natsServers": "NATS 地址",
  "configuration.full.redisUrl": "Redis 连接信息",
  "configuration.full.minioEndpoint": "MinIO 地址",
  "configuration.full.minioAccessKey": "MinIO Access Key",
  "configuration.full.minioSecretKey": "MinIO Secret Key",
  "configuration.full.minioBucket": "MinIO Bucket",
  "configuration.full.minioRegion": "MinIO Region",
  "configuration.full.natsToken": "NATS 认证 Token",
  "configuration.full.logServer.host": "日志库 IP / 主机名",
  "configuration.full.logServer.port": "日志库端口",
  "configuration.full.logServer.username": "日志库管理员用户名",
  "configuration.full.logServer.password": "日志库管理员密码",
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
