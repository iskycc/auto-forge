# 已删除 Agent 的连接提醒

节点“注销 → 删除”保留历史外键所需的墓碑，但删除其 Runner 凭据材料并从正常节点列表移除。主机上的 Agent 服务如果尚未卸载，仍会尝试心跳、reconcile、领取或上报；认证继续拒绝，不会恢复节点或授予执行权。

## 提醒与卸载

执行节点页在存在连接拒绝记录时，为具有全局 `runner.manage` 权限的管理员展示独立“已删除 Agent 连接提醒”；没有记录时整个区域隐藏，不保留空卡片或空白占位。记录包括原数据库节点名称、旧版本、节点 ID 和首次／最近拒绝时间，按节点合并、游标分页，每页 10 条，可手动刷新。该区域不参与正常节点总数、在线状态、执行机组或调度资源计算，匿名及仅查看账号不能读取专用接口。

记录仅针对数据库里同时具有注销和删除标记的已知节点；未知 ID 不产生记录，不采用未鉴权请求里自报的名称、版本、标签、IP 或资源信息。请求携带的旧 ID 也不能作为已核验的主机身份，界面明确说明这一点，防止据此自动连接或删除错误主机。

点击“卸载 Agent”复用现有受限管理 API 和 SSH 清理流程：

- 有有效已保存连接时可以复用；也可切换为重新填写。
- 没有保存的连接或密码时，明确提示输入执行机地址、用户名及 SSH／sudo 密码，再探测并通过可信渠道核验主机指纹。手工凭据只用于本次卸载，不自动持久化；关闭弹窗清空密码。
- 不因出现提醒自动卸载。最终操作仍需独立确认，远端工具检查 Runner ID 与受控目录，只清理该身份的 Agent、本地执行数据及缓存；平台执行历史和已上传日志保留。
- 远端清理失败时保留提醒和已保存连接，显示具体错误并允许重试。成功后在同一主库事务中清除提醒、SSH 密文并维持墓碑；即使墓碑原来已存在，也允许完成远端卸载。
- PostgreSQL 对相关墓碑行串行化，SQLite 通过短写事务／原子语句排序；卸载完成前产生的迟到采样不能重新生成提醒。成功卸载后若真的仍有新的失败请求，可重新出现，避免隐藏残留服务。

## 日志与资源边界

HTTP 指标继续记录每个请求，401 及原错误响应保持不变。容器警告按 Runner ID 在每个 Web 进程内合并：首次输出，随后一分钟内的重复鉴权失败不逐条输出，下个窗口附带被合并请求数。心跳、启动 reconcile、领取、续租和携带 Runner 头的日志／完成等请求共享窗口；普通用户登录错误、其他业务 4xx 及所有 5xx 仍正常记录。采样字典有固定容量，不保存令牌、密码、请求体或查询参数。

数据库记录每个 Web 进程最多每节点一分钟探测一次，并有全局探测预算和有界字典；多 Web 的最终时间更新仍由数据库条件写限制。未知 ID 只执行一次有界主键判断，不生成持久记录。采样失败保留原鉴权拒绝并输出受限诊断，不能将数据库故障变成认证成功。提醒的最近时间是采样时间，最多按分钟更新，不能当作 Agent 在线心跳。

## 持久化与升级

Lite 使用 SQLite，Full 使用 PostgreSQL 的 `runner_rejected_contacts`；业务记录均可从主库恢复，内存只负责降低重复采样成本。不需要 Redis／NATS／MinIO，不改变 Runner Protocol，也兼容旧 Agent，不要求先更新 Agent 才能发现残留请求。

新增 SQLite `0100_runner_rejected_contacts.sql` 和 PostgreSQL `0099_runner_rejected_contacts.sql`，仅创建按 Runner 外键关联的小型提醒表。升级前备份主库，Full 同步升级 Web／Worker；单个迁移失败事务回滚，修复后重试。回退旧服务时可保留新增表，旧版本继续拒绝凭据但不展示或维护新提醒，不删除历史数据。采集从升级后收到的拒绝请求开始，不追溯历史容器日志。

## 验证（2026-11-12）

95 项定向回归通过，包含真实 SQLite／PostgreSQL，未跳过 Full 数据库场景。验证新库创建、从上一版本 schema 升级、DDL 故障回滚、未知／正常／仅注销节点不生成删除提醒、重复／并发采样、分页、旧凭据继续失效、正常列表隔离，以及卸载事务回滚后提醒与 SSH 密文一起保留、成功后一起清除。现有执行控制、心跳权限及真实本地 SSH 测试服务的卸载顺序、远端身份不匹配和失败恢复也通过。

```sh
# 私密测试环境注入 AUTOFORGE_TEST_POSTGRES_URL；数据库场景串行运行。
pnpm exec vitest run \
  packages/application/test/control-executions.test.ts \
  packages/application/test/observe-deleted-runner-contacts.test.ts \
  packages/application/test/manage-runners.test.ts \
  packages/db/test/runner-rejected-contacts.integration.test.ts \
  packages/db/test/runner-rejected-contacts-migrations.integration.test.ts \
  packages/db/test/runner-uninstall.integration.test.ts \
  apps/web/server/runner-auth-log-sampler.test.ts \
  apps/web/server/http-request-observer.test.ts \
  apps/web/src/lib/runner-rejected-contacts-api.test.ts \
  apps/web/src/lib/runner-agent-uninstall.test.ts \
  apps/web/src/lib/runner-agent-installer-transfer.test.ts \
  apps/web/src/components/ui-usage.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Lite 与 Full 的生产 Playwright 场景各一项通过；Full 使用双 Web、一个 Worker 和真实 PostgreSQL／NATS／Redis／MinIO。通过真实 HTTP 注册、注销、删除后，旧凭据的启动领取与连续 16 次心跳全部返回 401，数据库只出现一条原节点提醒，不采用自报的版本或标签，不重新加入正常节点。两种模式的容器日志分别只输出一条该节点的鉴权警告；匿名读取提醒继续返回 401。

```sh
pnpm exec playwright test tests/e2e/runner-telemetry.spec.ts \
  --grep 'deleted Agents remain rejected' --workers=1
pnpm exec playwright test --config playwright.full.config.ts \
  tests/e2e/runner-telemetry.spec.ts --grep 'deleted Agents remain rejected' --workers=1
```

浏览器验证没有保存的 SSH 凭据提示、手工密码输入、主机指纹及永久清理确认、探测失败和卸载失败的恢复，以及取消后密码清空。此部分通过受控 HTTP 响应验证 UI，不连接或清理真实执行主机；远端真实 SSH 协议边界由本地测试 SSH 服务覆盖，没有新增真实 systemd 或业务 JVM 验收。

实际查看 Lite／Full 1024×768 与 1536×960 截图，包含浅色卸载密码表单、深色提醒列表；长节点名、时间、按钮与页脚排布正常，无新增溢出或变形。截图位于本机 `/var/tmp/autoforge-deleted-agent-ui` 和 `/var/tmp/autoforge-deleted-agent-full-ui`。变更文件格式、ESLint、相关类型、19 行 E2E 覆盖矩阵、Web／Worker 生产构建通过。未运行完整标准 CI、十万规模负载或发布包断网验收。

空列表展示补充（2026-11-12）：Playwright 在修复前复现了零记录仍显示整块卡片的问题。现在空列表不渲染提醒区域；有记录时继续展示清理入口，后续页因记录变化而为空时仍可返回上一页。Lite／Full 的相关场景均验证零记录隐藏、旧凭据持续拒绝、新记录出现及卸载表单；已查看 1024×768、1536×960 截图，没有新增空白占位或布局变形。
