export const securityAuditCategories = {
  access: "登录与访问",
  user: "用户与授权",
  project: "项目配置",
  case: "用例资产",
  suite: "任务配置",
  platform: "平台配置",
  runner: "执行机管理",
} as const;

export type SecurityAuditCategory = keyof typeof securityAuditCategories;

// This catalog is the shared recording and reading boundary, including historical records.
// Operational progress, retries, previews and connectivity checks deliberately have no entry.
const actionsByCategory = {
  access: {
    "auth.login": "用户登录",
    "auth.logout": "退出登录",
    "auth.access_denied": "越权访问被拒绝",
    "terminal.session_create": "授权执行机终端访问",
    "terminal.session_started": "开始执行机终端访问",
    "terminal.session_finished": "结束执行机终端访问",
    "case_definition.share": "创建用例共享链接",
    "run_batch.share": "创建执行结果共享链接",
    "attempt_log.share": "创建执行日志共享链接",
  },
  user: {
    "auth.bootstrap": "初始化管理员账号",
    "user.create": "创建用户",
    "user.disable": "停用用户",
    "user.enable": "启用用户",
    "user.password_reset": "重置用户密码",
    "user.password_change": "修改账号密码",
    "user.sessions_revoke": "撤销用户全部会话",
    "session.revoke": "撤销登录会话",
    "role.create": "创建角色",
    "role.update": "修改角色权限",
    "role.delete": "删除角色",
    "role.assign_system": "分配系统角色",
    "role.assign_project": "分配项目角色",
    "role.remove_system": "撤销系统角色",
    "role.remove_project": "撤销项目角色",
    "ldap.configure": "修改目录认证配置",
    "service_account.create": "创建服务账号",
    "service_account.update": "修改服务账号",
    "api_token.issue": "签发接口访问令牌",
    "api_token.revoke": "撤销接口访问令牌",
  },
  project: {
    "project.create": "创建项目",
    "project.archive": "归档项目",
    "project.transfer_owner": "转移项目负责人",
    "project_version.create": "创建项目版本",
    "test_stage.create": "创建测试阶段",
    "project_version.runtime_update": "修改项目版本运行配置",
    "project_version.runtime_delete": "删除项目版本运行配置",
    "project_version.runtime_inherit": "继承项目版本运行配置",
    "project_runtime_asset.upload": "上传项目运行资源",
    "project_runtime_asset.register": "登记项目运行资源",
    "jenkins.project_dependency.replace": "更新项目依赖包",
  },
  case: {
    "case_definition.update": "修改用例",
    "case_definition.delete": "删除用例",
    "case_definition.delete_many": "批量删除用例",
    "case_definition.restore_version": "恢复用例历史版本",
    "case_definition.inherit_version": "跨版本继承用例",
    "case_source.import_queued": "提交用例导入",
    "case_source.sync": "同步用例来源",
    "case_source.set_authoritative": "设置权威用例来源",
    "case_source.archive": "归档用例来源",
    "case_source.restore": "恢复用例来源",
    "case_source.delete": "删除用例来源",
    "ddt_case.bulk_update": "批量修改数据驱动用例",
    "ddt_case.execution_class": "修改数据驱动用例执行类",
    "ddt_case.trash": "将数据驱动用例移入回收站",
    "ddt_case.history_restore": "恢复数据驱动用例历史版本",
    "ddt_case.recycle_restore": "从回收站恢复数据驱动用例",
    "ddt_case.update": "修改数据驱动用例",
    "ddt_case.recycle_purge": "永久删除数据驱动用例",
    "ddt_template.create": "创建数据驱动字段模板",
    "ddt_template.update": "修改数据驱动字段模板",
    "ddt_template.delete": "删除数据驱动字段模板",
    "ddt_import.confirm": "确认导入数据驱动用例",
  },
  suite: {
    "case_suite.create": "创建用例任务",
    "case_suite.update": "修改用例任务",
    "case_suite.copy": "复制用例任务",
    "case_suite.add_cases": "向任务添加用例",
    "case_suite.remove_cases": "批量移除任务用例",
    "case_suite.remove_case": "移除任务用例",
    "case_suite.add_ddt_cases": "向任务添加数据驱动用例",
    "case_suite.remove_ddt_cases": "移除任务中的数据驱动用例",
    "case_suite.schedule_update": "保存任务执行计划",
    "case_suite.schedule_delete": "删除任务执行计划",
    "case_suite.webhooks_update": "修改任务回调绑定",
  },
  platform: {
    "settings.platform.bootstrap": "初始化平台配置",
    "settings.platform.update": "修改平台配置",
    "platform.node_updated": "修改平台节点配置",
    "retention_policy.update": "修改数据保留策略",
    "retention.execute": "清理过期数据",
    "storage.runtime_asset_delete": "删除运行资源",
    "webhook.create": "创建回调通知配置",
    "webhook.update": "修改回调通知配置",
    "webhook.delete": "删除回调通知配置",
  },
  runner: {
    "runner.register": "注册执行机",
    "runner.lifecycle_update": "修改执行机状态",
    "runner.deregister": "注销执行机",
    "runner.purge": "删除已注销执行机",
    "runner.credential_rotation_request": "轮换执行机凭据",
    "runner.credential_revoke": "撤销执行机凭据",
    "runner.install.complete": "安装执行机代理",
    "runner.install.rollback": "回滚执行机代理",
    "runner.update.complete": "更新执行机代理",
    "runner.update.batch": "批量更新执行机代理",
    "runner_group.create": "创建执行机组",
    "runner_group.update": "修改执行机组",
    "runner_group.delete": "删除执行机组",
  },
} satisfies Record<SecurityAuditCategory, Record<string, string>>;

export const securityAuditActions = Object.entries(actionsByCategory).flatMap(
  ([category, actions]) =>
    Object.entries(actions).map(([action, label]) => ({
      action,
      label,
      category: category as SecurityAuditCategory,
    })),
);

const actionCatalog = new Map(securityAuditActions.map((entry) => [entry.action, entry]));

export function securityAuditAction(action: string) {
  return actionCatalog.get(action);
}

export function securityAuditActionCodes(category?: SecurityAuditCategory): string[] {
  return securityAuditActions
    .filter((entry) => !category || entry.category === category)
    .map((entry) => entry.action);
}
