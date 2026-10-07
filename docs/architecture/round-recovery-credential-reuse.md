# 轮次间环境恢复的 Jenkins 密钥复用

每个恢复步骤通过“复用密钥”选择本任务的其他步骤，或者有管理权限的其他任务。
本任务可复用已保存密钥、刚输入而尚未保存的密钥，以及可解析的复用链；自身引用和循环引用会被拒绝。
其他任务按任务名称或 Jenkins Job 链接查询，每页最多 50 条，允许跨项目和项目版本，
但调用者必须同时具有来源与目标项目的 `case_suite.manage` 权限。

复用限定在同一 Jenkins 服务地址（协议、主机、端口相同），不同 Job 路径可以复用。
不同服务地址需要单独输入密钥，避免把已有认证信息发往其他服务。
“测试配置”使用相同的权限和地址校验，只读取 Jenkins 任务与上一构建信息，不触发构建。

## 保存与安全边界

HTTP 输入使用临时 `apiKeySource: { suiteId, ruleId }`；它与明文 `apiKey` 互斥。
服务端在保存时解析来源，并以目标任务和步骤的独立加密用途
`case-suite-round-recovery:{suiteId}:{ruleId}` 重新加密，沿用已有事务和任务修订号保护。
来源不存在、权限不足、密钥缺失、循环引用或地址不匹配时，保存失败且不会产生部分更新。
同一次保存中被移除的本任务来源步骤不能继续复用其旧密钥。

任务策略和版本快照只保存已有的配置与 `apiKeyConfigured`，不保存明文、密文或复用引用。
来源查询只返回任务、恢复轮次与 Job 元数据，响应禁用缓存；保存成功后编辑器清空明文输入与临时引用。
目标密钥已经独立保存，来源后续改密钥、移除恢复步骤或删除任务不会影响目标。
取消复用或手动输入新密钥会清除临时来源；已有目标密钥在输入留空时继续保留。

Lite/SQLite 与 Full/PostgreSQL 使用同一应用规则和已有密钥附表，仅 JSON 查询由方言适配器实现。
列表使用游标分页，查询和权限核验不加载任务成员。本变更无新增依赖、数据库迁移或配置。
密钥仍属于控制面 Jenkins 恢复配置，不传给 Runner Agent，也不改变执行协议、恢复调度或离线边界。

## 验证（2026-10-07）

以下检查实际通过：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @autoforge/web build
pnpm test:e2e:matrix
pnpm exec tsc --noEmit -p tsconfig.tests.json

pnpm exec vitest run \
  packages/application/test/round-recovery-credentials.test.ts \
  packages/application/test/inspect-round-recovery.test.ts \
  packages/application/test/manage-case-suites.test.ts \
  packages/application/test/run-round-recovery.test.ts \
  packages/application/test/create-failure-case-suite.test.ts \
  packages/contracts/test/management.test.ts \
  apps/web/src/lib/round-recovery-credential-input.test.ts \
  apps/web/src/lib/round-recovery-credentials-api.test.ts \
  apps/web/src/components/ui-usage.test.ts --maxWorkers=2

# 使用临时 PostgreSQL，预先设置 AUTOFORGE_TEST_POSTGRES_URL。
pnpm exec vitest run \
  packages/db/test/round-recovery-credentials.integration.test.ts \
  packages/db/test/sqlite-case-suites.integration.test.ts --maxWorkers=2

# 使用隔离 Lite 数据目录、已构建的生产服务及预装 Chromium。
AUTOFORGE_E2E_EXTERNAL_SERVER=1 \
AUTOFORGE_E2E_DATA_DIR=/tmp/autoforge-jenkins-reuse-e2e-data \
AUTOFORGE_UI_SCREENSHOT_DIR=/tmp/autoforge-jenkins-reuse-screens \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
pnpm exec playwright test tests/e2e/case-suite-lifecycle.spec.ts \
  --grep 'Jenkins recovery credentials|terminal execution failures|case metadata, immutable versions'
```

共 109 项不同的单元/集成检查与 3 项 Lite Playwright 场景通过。
真实 SQLite/PostgreSQL 检查覆盖独立加密、来源移除、两侧项目权限、无部分更新、
53 条来源跨页查询、特殊字符搜索、孤立密钥行过滤及非法游标。
浏览器场景通过本地 Jenkins HTTP 测试服务核验实际 Basic 认证，覆盖未保存与已保存的本任务密钥、
跨任务复用、测试配置、查询失败重试、保存后清空输入、取消复用，以及移除来源后的独立可用性。
已有环境恢复执行规则、任务生命周期和失败用例创建任务也通过回归。

已实际查看 1024×768、1536×960 的深浅色选择弹框、本任务复用状态和查询失败状态，
并复查原有恢复步骤表单在 1024×768、1536×1024 的布局。
弹框层级、字段对齐、按钮间距、长文本换行、滚动边界和深色可读性正常，无新增变形或横向溢出。
截图保存在 `/tmp/autoforge-jenkins-reuse-screens`。

本地未运行 Full 完整部署、真实 Runner、离线发布物或高规模压测；本次已运行真实 PostgreSQL 适配器检查。
完整高资源验收按仓库规定由既有 GitHub Actions 执行，新适配器测试已加入 Full 质量脚本。
