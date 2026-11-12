# 任务用例范围调整

## 普通用例从任务排除

在“用例管理 → TestNG 用例”勾选用例，或通过“导入用例”上传表格／粘贴类路径清单匹配后，选择“目标用例任务”，点击“从任务中排除”。目录勾选和“全选当前结果”收集的完整选择同样适用，不局限于已经渲染的目录行。

确认框显示目标任务名称、所选数量和影响范围。取消不提交请求；确认只移除所选用例与指定任务的成员关系，未加入该任务的用例自动忽略。不会删除用例定义、版本、其他任务成员、已有执行记录或正在执行的批次快照；后续新执行才使用调整后的任务范围。可再通过“加入任务”恢复成员。

操作栏统一左对齐、固定间距并自然换行，1024px 最小桌面视口也不拉伸按钮。目标任务沿用当前项目／版本及 `case_suite.manage` 权限筛选；已归档任务和他人锁定任务不提供为可编辑目标。选择后若任务被另一页面归档或锁定，服务端仍会拒绝排除，页面展示具体原因并保留勾选以便处理后重试。

成功后清理浏览器读取快照、刷新目录成员筛选并取消已处理用例的勾选；其他新勾选项保留。请求期间禁用任务选择、加入／排除／删除及未加入筛选，避免改变本次目标。请求超时明确提示可能已提交，可核对后重试；重复排除不重复删除用例或生成无变化的版本。

## 持久化与边界

复用现有 `DELETE /api/v1/case-suites/{suiteId}/cases`，正文为 `caseDefinitionIds`。入口保留登录、同源、项目任务管理权限和操作审计；应用层先核验归档／锁定，仓储在写事务内再次核验。SQLite 使用短写事务，PostgreSQL 锁定任务行，成员删除、任务修订及不可变版本快照同事务提交。

单次支持最多 100,000 项，数据库按现有有界 SQL 批次处理，整个请求保持原子性；不加载全任务明细、历史 attempt 或用例日志。Lite／Full 共用相同 UI、契约和应用服务，无需新迁移、队列、缓存服务或 Runner 协议。

## 验证记录（2026-11-12）

8 个文件、96 项定向回归通过，包含真实 SQLite／PostgreSQL 的任务事务、锁定与归档保护、幂等及现有清单选择逻辑。PostgreSQL 测试地址通过本机测试环境注入，没有跳过 Full 分支：

```bash
pnpm exec vitest run \
  packages/application/test/manage-case-suites.test.ts \
  packages/db/test/suite-ddt-removal.integration.test.ts \
  packages/db/test/sqlite-case-suites.integration.test.ts \
  packages/domain/test/case-suite-lock.test.ts \
  apps/web/src/lib/case-directory-selection.test.ts \
  apps/web/src/lib/case-selection-stats.test.ts \
  apps/web/src/lib/case-path-import.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=1 --no-file-parallelism
```

新增浏览器用例先在旧生产构建确认缺少按钮，再于最终生产构建分别通过 Lite 与 Full。Full 使用双 Web、Worker 和真实 PostgreSQL／NATS／Redis／MinIO，两个模式均验证空选择禁用、手动勾选、含表头的类路径清单、取消、页面打开后任务被归档而拒绝操作、恢复后重试、非成员自动忽略、重复排除、重新加入及“未加入”筛选。直接核对目标任务、其他任务、原用例定义和历史批次的执行明细 ID，确认只改变目标成员关系。

```bash
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts --grep 'TestNG selections exclude ordinary cases' --workers=1
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/case-suite-lifecycle.spec.ts --grep 'TestNG selections exclude ordinary cases' --workers=1
```

实际查看 1024×768、1536×960 的深浅色操作栏与确认弹窗截图，包含长任务名称；按钮靠左、固定间距并正常换行，未见新增溢出或页面变形。截图保存在本机 `/var/tmp/autoforge-testng-exclusion-ui/` 和 `/var/tmp/autoforge-testng-exclusion-full-ui/`，不提交测试数据或产物。

受影响文件的 `pnpm exec prettier --check`、`pnpm exec eslint --max-warnings=0`、`pnpm --filter @autoforge/web typecheck`、`pnpm exec tsc --noEmit -p tsconfig.tests.json`、`pnpm test:e2e:matrix`（19 行）及 Web／Worker 生产构建均通过。重型检查串行限额执行，测试服务与容器在结束后清理。本轮未重跑十万级压力、真实 Runner JVM 或完整离线发布验收；该功能不修改这些路径。
