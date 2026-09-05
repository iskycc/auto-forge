import type { Permission } from "@autoforge/domain";

type PermissionPresentation = {
  label: string;
  description: string;
};

const PERMISSION_PRESENTATIONS = {
  "case.read": { label: "查看用例", description: "查看用例定义、版本和参数元数据" },
  "case.manage": { label: "管理用例", description: "创建、编辑、恢复和删除用例" },
  "case_source.read": { label: "查看文件来源", description: "查看导入来源和同步状态" },
  "case_source.manage": { label: "管理文件来源", description: "导入、同步、归档和删除来源" },
  "case_suite.read": { label: "查看用例任务", description: "查看任务配置和成员范围" },
  "case_suite.manage": { label: "管理用例任务", description: "创建、编辑、复制和归档任务" },
  "run.read": { label: "查看执行与质量洞察", description: "查看执行记录、状态和质量分析" },
  "analysis.assign": {
    label: "分配用例分析",
    description: "将当前项目的失败用例分析分配给已有分析人员",
  },
  "analysis.manage": { label: "认领与分析用例", description: "认领最终失败用例并记录分析类别" },
  "run.create": { label: "发起执行", description: "从任务或单用例发起执行" },
  "run.cancel": { label: "终止执行", description: "取消排队中或运行中的执行" },
  "run.retry": { label: "重试执行", description: "重试失败或未完成的执行" },
  "log.read": { label: "查看执行日志", description: "查看执行过程的标准输出和错误日志" },
  "artifact.read": { label: "查看执行产物", description: "查看和下载报告、截图等执行产物" },
  "runner.read": { label: "查看执行节点", description: "查看执行节点、资源和在线状态" },
  "runner.manage": { label: "管理执行节点", description: "注册、轮换、禁用和注销执行节点" },
  "runner.terminal": { label: "使用执行节点终端", description: "创建并操作授权的交互终端" },
  "user.read": { label: "查看用户", description: "查看用户、状态和角色绑定" },
  "user.manage": { label: "管理用户", description: "创建、禁用和维护用户账号" },
  "role.read": { label: "查看角色与权限", description: "查看角色定义和授权关系" },
  "role.manage": { label: "管理角色与授权", description: "创建、编辑、分配和撤销角色" },
  "ldap.read": { label: "查看 LDAP 配置", description: "查看目录连接和登录配置" },
  "ldap.manage": { label: "管理 LDAP 配置", description: "配置、测试和同步 LDAP 目录" },
  "project.read": { label: "查看项目", description: "查看项目、版本和成员信息" },
  "project.manage": { label: "管理项目", description: "创建、编辑、归档项目并管理成员" },
  "audit.read": { label: "查看安全审计", description: "查看安全审计事件" },
  "audit.export": { label: "导出审计记录", description: "导出安全审计事件" },
  "settings.read": { label: "查看平台设置", description: "查看平台配置和治理策略" },
  "settings.manage": { label: "管理平台设置", description: "修改平台配置和治理策略" },
  "api_token.manage": {
    label: "管理服务账号与令牌",
    description: "创建服务账号并签发或撤销 API 令牌",
  },
} satisfies Record<Permission, PermissionPresentation>;

export function permissionLabel(permission: string): string {
  return permissionPresentation(permission)?.label ?? permission;
}

export function permissionDescription(permission: string): string {
  return (
    permissionPresentation(permission)?.description ?? "此权限来自较新版本，请联系管理员确认用途"
  );
}

function permissionPresentation(permission: string): PermissionPresentation | undefined {
  return PERMISSION_PRESENTATIONS[permission as Permission];
}
