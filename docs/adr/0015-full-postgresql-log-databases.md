# ADR 0015：Full 独立 PostgreSQL 日志库与固定批次路由

- 状态：已接受，已实现
- 本地写入兼容已由 [ADR 0017](./0017-full-postgresql-log-writes-only.md) 收紧为仅历史读取；Full 新日志必须写 PostgreSQL。
- 日期：2026-10-27
- 补充 ADR 0012；原本地日志与节点路由继续用于历史批次及本地写入模式。

## 决策

1. Full 可登记多个独立 PostgreSQL 日志库。主平台业务库保存日志库目录、加密连接串、当前写入选择、
   确认水位和每个批次的库 ID；日志库保存完整正文、去重摘要、连续水位及逻辑正文大小。
   日志库不能使用业务数据库；部署模板提供独立实例、凭据和宿主机目录。
2. 批次首次写入前，在短主库事务中固化 `run_batch_log_storage.database_id`。空值表示原本地模式。
   选择写入库通过 revision 条件更新；批次绑定与选择由同一设置行锁排序。切换立即影响未绑定的新批次，
   已绑定的在途与历史批次保持原库。不会按当前活动库猜测历史正文位置。
3. 每个日志库登记自己的永久数据库 ID 及平台密钥指纹。连接使用前核验身份；编辑连接只能指向同一个库。
   各平台节点共享主库与主密钥即可读取相同日志库，不依赖最初接收上传的 Web 节点。
   加密使用现有 AES-GCM 端口，purpose 绑定日志库 ID；API 和页面不回显连接串。
   重复登记同一平台的同一库返回原 ID；正文库身份写成、主库登记未写成时，重试可补全登记。
4. 正文事务先提交，再在主库记录大小及确认水位，最后确认 Agent。跨库之间不假定原子事务。
   两阶段之间失败时 Agent 重传相同块，按批次、attempt、stream、sequence 去重；不同正文或时间戳拒绝，
   主库元数据可从重传修复。完成事务只读写主库水位，不在持有主库连接时连接日志 PostgreSQL。
5. 数据库故障、身份错误或已登记正文缺失应明确报错；不切换既有批次到备用库，也不返回空日志伪装成功。
   每个上下文最多持有四个日志连接池、每池两条连接，空闲池可驱逐；配置目录使用游标分页，
   数据库数量不受连接池缓存大小限制。SQL、日志页、搜索扫描和上传批次均有界。
   日志库的锁超时归类为日志存储故障，不触发主业务库拥塞退让；通知保留对应日志库 ID。
6. 日志正文使用 `BYTEA`，支持 UTF-8 与 NUL 等日志内容，由 PostgreSQL TOAST 管理大字段压缩。
   普通页面、公开页、导出和版本复制共用原日志端口。逻辑正文大小与 PostgreSQL 物理占用分别管理。
7. 保留策略按已绑定库删除正文。批次删除后保留绑定供失败清理重试；成功后清除孤儿绑定。
   管理入口提供新增、连接检查、修改连接和切换，不提供直接删除历史库登记的操作。

## Lite、升级与恢复

Lite 继续使用批次 SQLite、本地对象、SQLite 队列，不创建日志 PostgreSQL 连接，不展示日志库管理。
主库兼容迁移为 SQLite `0085`、PostgreSQL `0083`，日志库有单独 `log-postgresql/0001` 迁移历史，
通过管理员显式登记操作运行，不向日志库应用业务 schema。

历史 SQLite 不自动迁移；已有 `attempt_logs_path` 或节点归属的批次继续读取原日志节点。
版本复制为目标批次重新选择并固定存储，不能复制源库绑定。新增存储不改变 Runner Protocol。

升级、备份与恢复须把主库、所有已登记日志库、MinIO 和保留的节点本地日志作为一致集合；
主库的定位记录和确认水位不能替代正文。主密钥也是恢复连接串的必要材料。
主库与日志库迁移失败均由本库事务回滚；旧版本不能读取新日志库，回退需恢复升级前一致备份，
不能只回退镜像。跨平台搬迁或复制日志库不属于自动扩容；原库身份必须随备份保留。

## 管理接口

所有写接口校验同源和 `settings.manage`，读取要求 `settings.read`；Lite 返回不支持。

| 方法 | 地址 | 请求／行为 |
| --- | --- | --- |
| GET | `/api/v1/settings/log-databases?cursor=...` | 每页最多 50 个库，返回下一游标、当前库 ID 和设置 revision |
| POST | `/api/v1/settings/log-databases` | `name`、`databaseUrl`；登记、迁移并校验身份，同库重试返回原 ID |
| PATCH | `/api/v1/settings/log-databases/{id}` | `name`、完整 `databaseUrl`；校验同库后更新加密连接 |
| POST | `/api/v1/settings/log-databases/{id}/check` | 检查连接与库身份 |
| PUT | `/api/v1/settings/log-databases/active` | `databaseId`、`revision`；ID 为 null 时为后续新批次选择本地模式 |

响应和审计不包含连接串；管理写入审计记录库 ID、脱敏地址和操作类型。
日志库错误携带具体库 ID，不包含密码或驱动错误堆栈。

## 验证记录（2026-10-27）

- 真实 PostgreSQL 测试覆盖多库切换、跨读取实例恢复、并发重传、乱序缺口、内容冲突与事务回滚、
  中文及 NUL 正文、单连接完成事务、错误数据库身份、断开连接、连接更新、孤儿清理，以及超过四个库后的连接池回收。
- 对主库元数据更新注入真实 SQL 失败，验证已提交正文可通过重传补全确认，不重复正文或累计大小；
  模拟中断登记，重试沿用正文库身份并补全主库登记。
- SQLite／PostgreSQL 验证从上一 schema 升级、失败回滚、历史保留；原有日志和版本复制回归通过。
  单独验证从源日志库读取 65 块中文日志，并把完整版本副本的日志固定到另一个目标日志库。
- 生产构建的 Full 页面经过带数据 Playwright：页面登记、切换、切换后两个公开日志页读取，
  并在独立日志 PostgreSQL 容器、不同账号与端口上重跑。通过有效 Runner 凭据与租约向真实日志上传接口写入，
  验证切换后在途批次继续上传到原库；序号存储覆盖协议允许的安全整数范围。
  实际查看 1024×768 和 1536×960 深浅色页面与弹窗截图。
  停止全部 Full 基础设施后，Lite 的生产启动和同一 Playwright 场景回归通过。
  本机隔离容器验证不等同于跨物理主机、生产并发容量、HA 或真实 JVM 批跑验收。

主要检查命令包括 `pnpm exec tsc --noEmit -p tsconfig.tests.json`、
`pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/worker typecheck`、
`pnpm --filter @autoforge/worker build`、
`pnpm exec playwright test tests/e2e/log-databases.spec.ts --workers=1 --reporter=list`、
`node --test scripts/release/build-deployment-bundle.test.mjs` 和 `node scripts/quality/validate-e2e-matrix.mjs`。
定向 Vitest 覆盖新日志库、旧本地日志、节点路由、双库迁移、错误与通知、API 权限和版本复制；
相关 TypeScript／TSX／MJS 经过 Prettier、ESLint 与 `git diff --check`。
