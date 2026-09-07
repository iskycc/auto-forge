import { securityAuditAction, securityAuditCategories } from "@autoforge/contracts";
import { isPermission, type AuditEvent } from "@autoforge/domain";
import { permissionLabel } from "./permission-presentation";

const resourceLabels: Record<string, string> = {
  user: "用户",
  role: "角色",
  session: "登录会话",
  access_control: "访问权限",
  service_account: "服务账号",
  api_token: "接口访问令牌",
  ldap_configuration: "目录认证配置",
  project: "项目",
  project_version: "项目版本",
  test_stage: "测试阶段",
  project_runtime_asset: "项目运行资源",
  platform_configuration: "平台配置",
  platform_node: "平台节点",
  case_definition: "用例",
  case_suite: "用例任务",
  case_source: "用例来源",
  jar_import_job: "用例导入",
  ddt_case: "数据驱动用例",
  ddt_template: "字段模板",
  ddt_import: "数据驱动用例导入",
  runner: "执行机",
  runner_host: "执行机主机",
  runner_group: "执行机组",
  run_batch: "执行批次",
  run_attempt: "执行尝试",
  webhook: "回调通知",
  retention_policy: "数据保留策略",
};

const detailLabels: Record<string, string> = {
  displayName: "名称",
  name: "名称",
  resourceName: "对象名称",
  username: "账号",
  source: "账号来源",
  provider: "认证方式",
  permission: "请求的权限",
  permissions: "权限范围",
  scopes: "授权范围",
  roleId: "角色编号",
  scope: "作用范围",
  active: "已启用",
  enabled: "已启用",
  archived: "已归档",
  forcePasswordChange: "要求修改密码",
  restartRequired: "需要重启",
  status: "状态",
  state: "状态",
  revision: "修订号",
  version: "版本",
  currentVersion: "当前版本",
  restoredFromVersion: "恢复自版本",
  permissionCount: "权限数量",
  caseCount: "用例数量",
  memberCount: "成员数量",
  webhookCount: "回调数量",
  sourceSuiteId: "来源任务编号",
  caseDefinitionId: "用例编号",
  scheduleId: "计划编号",
  targetProjectId: "请求的项目编号",
  projectVersionId: "项目版本编号",
  sourceProjectVersionId: "来源版本编号",
  testStageId: "测试阶段编号",
  sourceId: "来源编号",
  jobId: "导入编号",
  templateId: "模板编号",
  caseId: "用例编号",
  fileName: "文件名称",
  sizeBytes: "文件大小（字节）",
  sha256: "文件摘要",
  kind: "资源类别",
  mode: "部署模式",
  slug: "项目标识",
  ownerUserId: "负责人编号",
  targetUserId: "目标用户编号",
  protocol: "连接协议",
  tlsRejectUnauthorized: "校验服务器证书",
  permanent: "永久有效",
  serviceAccountId: "服务账号编号",
  prefix: "令牌识别前缀",
  expiresAt: "到期时间",
  sessionId: "会话编号",
  reason: "原因",
  reasonCode: "原因",
  credentialVersion: "凭据版本",
  agentVersion: "代理版本",
  retentionDays: "保留天数",
  deletedCount: "删除数量",
  deleted: "已删除数量",
  inputMessages: "终端输入次数",
  inputBytes: "终端输入字节数",
  outputBytes: "终端输出字节数",
  imported: "导入数量",
  updated: "更新数量",
  created: "新增数量",
  skipped: "跳过数量",
  count: "数量",
  executionClass: "执行类",
  requested: "请求数量",
  succeeded: "成功数量",
  failed: "失败数量",
  port: "端口",
  hostname: "主机名",
  address: "节点地址",
  adapterEnabled: "启用执行适配器",
  assetId: "资源编号",
  architecture: "处理器架构",
  category: "数据类别",
  concurrency: "并发数",
  conflicts: "冲突数量",
  fromVersion: "变更前版本",
  toVersion: "变更后版本",
  deletedRecords: "已删除记录数",
  queuedObjectDeletes: "待清理对象数",
  completedObjectDeletes: "已清理对象数",
  host: "主机地址",
  hostKeySha256: "主机密钥指纹",
  installationMode: "安装方式",
  internalBaseUrl: "内部服务地址",
  jdkConfigured: "已配置 Java 工具链",
  jarBundleConfigured: "已配置依赖包",
  runAsRoot: "以系统管理员运行",
  operatingSystemId: "操作系统",
  suiteId: "任务编号",
  dataDirectory: "数据目录",
  draining: "停止接收新请求",
};

const valueLabels: Record<string, string> = {
  local: "本地账号",
  ldap: "目录账号",
  system: "系统",
  project: "项目",
  active: "正常",
  disabled: "已停用",
  enabled: "已启用",
  archived: "已归档",
  draining: "排空中",
  succeeded: "成功",
  failed: "失败",
  rejected: "已拒绝",
  revoked: "已撤销",
  deregistered: "已注销",
  jdk: "Java 工具链",
  dependencies: "依赖包",
  dependency: "依赖包",
  lite: "精简模式",
  full: "完整模式",
  invalid_or_initialized: "引导令牌无效或平台已初始化",
  invalid_bootstrap_token: "管理员引导令牌无效",
  already_initialized: "平台已完成初始化",
  "Browser disconnected": "浏览器连接已断开",
  "Browser closed terminal": "用户已关闭终端",
  "Runner disconnected": "执行机连接已断开",
  "Runner terminal failed": "执行机终端启动失败",
  "Terminal process exited": "终端进程已退出",
  "Control plane is shutting down": "平台正在关闭",
  execution: "执行记录",
  log: "执行日志",
  artifact: "执行产物",
  source: "用例来源",
  analytics: "分析数据",
  audit: "安全审计",
  session: "登录会话",
  queue: "任务队列",
  systemd: "系统服务",
  user: "用户服务",
  standalone: "独立进程",

  LDAP_UNAVAILABLE: "目录服务暂不可用",
  LDAP_CREDENTIAL_REJECTED: "目录账号或密码校验失败",
  LDAP_LOGIN_FINALIZATION_FAILED: "目录认证后的账号或会话保存失败",
};

export type AuditDetail = { label: string; value: string };
export type AuditEventPresentation = {
  id: string;
  recordedAt: string;
  action: string;
  category: string;
  result: AuditEvent["result"];
  resultLabel: string;
  actor: string;
  actorId: string;
  resource: string;
  resourceId: string;
  project: string;
  details: AuditDetail[];
};

export function auditResourceLabel(resourceType: string): string {
  return resourceLabels[resourceType] ?? "其他重要数据";
}

export function presentAuditEvent(
  event: AuditEvent,
  names: {
    users?: ReadonlyMap<string, string>;
    runners?: ReadonlyMap<string, string>;
    projects?: ReadonlyMap<string, string>;
  } = {},
): AuditEventPresentation {
  const operation = securityAuditAction(event.action);
  const actorType =
    event.action === "auth.login" && !event.actorId
      ? "未识别账号"
      : event.actorType === "runner"
        ? "执行机"
        : event.actorType === "user"
          ? "用户"
          : "系统";
  const actorName =
    typeof event.details.actorName === "string" ? event.details.actorName : undefined;
  const actor =
    actorName ??
    (event.actorId
      ? ((event.actorType === "runner"
          ? names.runners?.get(event.actorId)
          : names.users?.get(event.actorId)) ?? `${actorType} · ${event.actorId.slice(0, 8)}`)
      : actorType);
  const details = Object.entries(event.details)
    .filter(([key]) => key !== "eventDescription" && key !== "actorName")
    .map(([key, value]) => ({
      label: detailLabels[key] ?? "补充信息",
      value: auditDetailValue(key, value),
    }));
  return {
    id: event.id,
    recordedAt: event.recordedAt,
    action: operation?.label ?? "历史安全事件",
    category: operation ? securityAuditCategories[operation.category] : "其他安全事件",
    result: event.result,
    resultLabel:
      event.result === "succeeded" ? "成功" : event.result === "rejected" ? "已拒绝" : "失败",
    actor,
    actorId: event.actorId ?? "",
    resource: auditResourceLabel(event.resourceType),
    resourceId: event.resourceId ?? "",
    project: event.projectId
      ? (names.projects?.get(event.projectId) ?? `项目 · ${event.projectId.slice(0, 8)}`)
      : "全平台",
    details: [
      ...details,
      { label: "事件编号", value: event.id },
      ...(event.resourceId ? [{ label: "对象编号", value: event.resourceId }] : []),
      ...(event.requestId ? [{ label: "请求编号", value: event.requestId }] : []),
    ],
  };
}

function auditDetailValue(key: string, value: AuditEvent["details"][string]): string {
  if (value === null) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (key === "permission") return isPermission(value) ? permissionLabel(value) : "未识别的权限";
  if (key === "permissions" || key === "scopes") {
    return value
      .split(/[,\s]+/u)
      .map((permission) =>
        isPermission(permission) ? permissionLabel(permission) : "未识别的权限",
      )
      .join("、");
  }
  if (
    [
      "source",
      "provider",
      "scope",
      "status",
      "state",
      "kind",
      "mode",
      "reason",
      "reasonCode",
      "category",
      "installationMode",
    ].includes(key) &&
    valueLabels[value]
  )
    return valueLabels[value];
  if (key === "reasonCode") return "操作未通过安全校验";
  return value;
}

export function auditCsv(events: readonly AuditEvent[]): string {
  const headers = [
    "时间（UTC）",
    "操作者",
    "操作描述",
    "审计分类",
    "操作结果",
    "资源类型",
    "资源编号",
    "项目编号",
    "请求编号",
    "事件详情",
  ];
  const rows = events.map((event) => {
    const item = presentAuditEvent(event);
    return [
      event.recordedAt,
      item.actor,
      item.action,
      item.category,
      item.resultLabel,
      item.resource,
      event.resourceId ?? "",
      event.projectId ?? "",
      event.requestId ?? "",
      item.details.map((detail) => `${detail.label}：${detail.value}`).join("；"),
    ];
  });
  return "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  const text = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}
