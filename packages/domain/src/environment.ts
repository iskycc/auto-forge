// 历史批次与 Runner Protocol v1 仍能读取空的兼容字段；产品层不再创建或管理这些配置。
export type ExecutionEnvironmentVariable = {
  name: string;
  value: string;
};

export type ExecutionEnvironmentSecretBinding = {
  name: string;
  secretId: string;
  secretVersionId: string;
};
