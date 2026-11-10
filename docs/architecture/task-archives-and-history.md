# 用例任务归档和执行历史快照

## 文件增量选择

DDT 导入弹窗的多次拖放、文件选择操作均追加到当前清单，保留选择顺序。名称、大小、修改时间相同的文件视为重复选择；同名但大小或时间不同的文件保留，后续由预检判断用例冲突。支持逐个移除，上传预检期间禁止改变清单。任何一次选择包含不支持的文件时，拒绝该次选择并保留之前的清单；点击“重新选择”仍可回到清单继续调整。

## 手动归档与恢复

所有普通任务和 Rerun 任务均支持手动归档。活动任务卡片右侧提供“归档任务”图标，任务详情的“基本信息与执行策略”标题旁也提供同名按钮；确认弹窗说明只归档已保存的配置，保留全部用例和执行历史，未保存草稿不会保留。

已归档任务卡片使用“恢复任务”按钮替代执行按钮，任务详情的只读提示中也可恢复。恢复的是同一个任务，任务 ID、成员、配置和历史记录保持；恢复只将状态改回 `active`，不会修改原来的启停配置，也不会自动重新启用执行计划。活动／归档列表在操作成功后立即移除当前项并刷新；保留个人置顶。

手动归档在双数据库写事务中检查是否存在排队、调度、倒计时或执行中的批次，暂停中的活动批次同样阻止归档；返回 `409 CASE_SUITE_ARCHIVE_CONFLICT` 并附批次 ID，失败不改变任务或执行计划。没有活动批次时，归档状态、修订与配置版本快照、启用的 cron 停用同事务提交。Full 与新执行提交共用任务行锁，Lite 使用短写事务；两种归档共用活动批次判定查询。沿用有权限和修订号校验的 PATCH 接口，不新增数据库迁移或部署配置。

## Rerun 归档

入口位于“用例任务”工具栏，作用域是当前项目和版本，要求 `case_suite.manage`。由“以未通过用例创建任务”产生的新任务在创建事务中保存 `is_rerun` 来源标记，改名后仍可归档。升级时按旧默认 `Rerun-20…` 数字日期后缀识别已有任务；旧的自定义名称无法可靠追溯来源，可继续使用任务编辑中的单项归档，不能假设所有名字包含 Rerun 的任务都是重跑任务。

确认后浏览器依次请求有界窗口，每次最多100项，直到没有剩余符合条件的任务。已经处理的窗口持久保存，后续请求失败可重试剩余任务。归档只改变状态、修订号和修改人/时间，执行配置版本不改写，不删除成员或执行历史。关联 cron 会停用；任务详情的“恢复任务”按钮只恢复归档状态，定时执行需单独重新启用。

归档期间任务成员和配置只读：不能添加或移除普通／DDT 用例，不能修改名称、说明、启停状态、执行策略、执行计划和完成通知绑定。用例管理的目标任务选择列表在数据库分页前排除归档任务，任务详情隐藏成员编辑入口并锁定设置。旧页面或直接调用接口仍返回 `409 CASE_SUITE_ARCHIVED`，明确提示先恢复任务；恢复请求必须单独提交 `archived: false` 与 `expectedRevision`，不能混入配置修改。恢复后才可再次变更成员与配置。

只读设置隐藏悬浮保存栏，避免遮挡配置；恢复后归档选择框按服务器状态重新初始化，防止旧的勾选值导致后续保存时再次归档。复制为新任务不修改源任务，仍沿用原有权限。

应用层在读取用例前拒绝归档任务；SQLite 在短写事务内重新检查状态，PostgreSQL 在成员／配置写入前锁定任务行并重新检查，与归档操作串行化。被拒绝的操作不会改变成员、修订号、配置或版本快照。查看、导出、个人置顶和保留执行历史的任务删除仍沿用原有权限和语义；归档不冻结用例资产本身，也不改写已提交执行的快照。不新增迁移、缓存事实或基础设施依赖。

存在 queued、dispatching、scheduled、running 批次的任务跳过，包含倒计时和暂停中的活动批次。Lite 使用短写事务；Full 对候选任务加锁，再以新语句核对活动批次，和创建时的修订号、任务行锁共同定义操作顺序。归档状态、cron 停用、审计和读模型失效同事务完成。任务默认列表在 SQL 限制条数之前过滤 `active`，已归档任务通过 `?status=archived` 单独查询，保留个人置顶和原排序。

## 执行历史统计

原来的 `batch_counters` 快照绑定整页批次组合，一页中任一活动批次使整页定期重算，分页或筛选产生新组合也会重复聚合终态记录。

新增 `run_batch_history_snapshots`，按 `batch_id`、权威批次 `version` 和快照格式版本保存计数。任务执行列表先读取有权限范围内的分页元数据，再以有界窗口读取历史快照；全部已命中时，不注册统计读模型，不查询历史 ExecutionRun／RunAttempt。活动批次与缺失快照的旧终态记录才交由现有后台统计读取，成功生成终态结果时保存可独立复用的数据库快照。

旧历史首次访问仍需后台补齐，页面显示准备状态，不伪造结果。新列表计数查询版本升级为3，避免旧整页缓存导致升级后不生成独立历史快照。活动批次保留原来的约5秒统计刷新；终态快照不因页面组合、项目其他操作或普通缓存清理而过期。批次状态或版本不匹配时忽略旧快照并重新构建，写入也验证当前状态和版本，避免并发终止期间保存旧结果。

分页、权限、任务名称、控制状态等权威元数据仍执行轻量索引查询，快照不参与鉴权、执行控制、调度或租约判断。快照可以从权威执行数据重建；删除任务保留执行历史及快照，删除批次时快照通过外键清理。单用例列表的直接结果与日志入口不变。

## 双模式升级与恢复

SQLite `0091_suite_rerun_and_history_snapshots.sql` 和 PostgreSQL `0089_suite_rerun_and_history_snapshots.sql` 新增任务来源标记、查询索引和历史快照表。沿用顺序、校验和受控迁移，支持事务失败回滚；升级前按现有流程备份主库，Full 同步升级 Web 和全部 worker。没有新服务、运维配置或离线资源依赖。

Rerun 来源标记、归档和快照均在主库持久化，Lite 不要求 Redis／NATS／MinIO，Full 不依赖缓存保存业务事实。进程重启后已经归档的任务和历史统计可直接恢复，尚未完成的统计通过原有租约和后台读模型继续生成。降级使用升级前备份，不手工删除迁移记录或修改已应用迁移校验和。

## 归档只读验证（2026-11-09）

- 缺陷测试先复现归档后仍可变更成员／配置的问题。75 项相关回归通过，包含应用、领域、API 错误映射、真实 SQLite／PostgreSQL 成员写入、执行计划和通知绑定；新增的双数据库竞态场景验证“校验用例期间被归档”仍拒绝写入，归档边界定向分组 9 项通过。
- `pnpm typecheck`、测试类型检查、受影响 TypeScript 文件的 ESLint、格式检查和 `pnpm --filter @autoforge/web build` 通过。
- 生产 Lite 的 Playwright `task-archives-history.spec.ts --grep 'one-click Rerun'` 完整流程通过：真实 DDT 成员、批量归档、添加任务选择排除归档项、7 类旧页面／直接接口修改请求返回归档冲突、成员与修订保持不变、只读详情、独立恢复、归档勾选同步及恢复后成员增删。
- 实际查看 1024×960、1536×960 的目标任务选择弹窗，以及深浅色归档设置截图；无新增横向溢出、按钮遮挡或布局变形。本轮未运行完整 CI／E2E 矩阵、Full 浏览器场景或发布；Full 持久化语义由真实 PostgreSQL 集成覆盖。

## 手动归档与恢复扩展验证（2026-11-09）

- 新增双数据库测试先复现普通任务在有活动批次时仍可归档的问题；SQLite／真实 PostgreSQL 验证四种活动状态均阻止归档，终态后可归档同一普通任务，启用的执行计划原子停用，恢复后 ID、配置、成员、执行历史保持，计划继续停用。包含批量 Rerun 归档在内的 71 项定向回归通过。
- 全仓 `pnpm typecheck`、受影响文件 ESLint、格式检查和 Web 生产构建通过，无新增依赖或迁移。
- 生产 Lite 的 Playwright 两项完整场景通过：原有 Rerun 归档与只读保护，以及含 DDT 成员的普通任务从列表／详情手动归档与恢复、取消归档、恢复后成员保留和未保存草稿处理。截图覆盖 1024×960、1536×960 的深浅色活动列表、归档列表、归档确认框与只读详情；实际审查无新增换行异常、遮挡或溢出。Full 浏览器完整矩阵及发布未运行。

## 任务锁定

任务卡片和详情页提供“锁定任务／解除锁定”。锁定人为操作时的已登录身份，不能由请求体指定；名称、时间与身份 ID 保存到主数据库，重启后仍然生效。锁定不复制到通过“复制任务”新建的任务，不改写既有执行快照。

锁定后，仅锁定人且仍具有项目任务管理权限时，才能修改配置、增删普通／DDT 成员、修改执行计划、通知绑定及公开执行接入、删除、归档／恢复或解除锁定；管理员没有隐式越权解锁。其他用户可以按原权限查看任务与历史、导出清单和设置个人置顶，页面移除任务写操作入口。锁定用于配置维护，已有执行与调度继续遵循原权限和执行控制，不因锁定中断。

锁定不限制正常执行、公开链接执行或 Jenkins 执行。公开执行页的“修改环境 IP”继续向所有可公开执行的已登录用户开放，不要求其为锁定人或拥有任务编辑权限；该入口只覆盖当前立即／倒计时执行的 IP 快照，不修改任务默认 IP、成员范围或修订号。后续省略覆盖参数时仍使用原任务地址。

所有成员、配置与生命周期写事务在 SQLite 短写事务或 PostgreSQL 行锁内复核锁定人，不能依赖前端按钮状态或事务前的一次读取。锁定／解锁使用当前修订号条件更新，修订号递增，不增加任务配置版本；旧页面提交返回冲突，其他身份写入返回 `403 / CASE_SUITE_LOCKED`。批量归档 Rerun 跳过其他人锁定的任务；按范围清空 DDT 触及他人锁定任务时拒绝该任务的成员移除。

新增 `PUT /api/v1/case-suites/{suiteId}/lock`，正文为 `locked` 和 `expectedRevision`，要求登录、同源和项目 `case_suite.manage`，成功后记录锁定／解除锁定审计。Lite 使用 SQLite，Full 使用 PostgreSQL；不依赖 Redis、NATS 或 MinIO，也不修改 Runner 协议。

升级包含 SQLite `0098_suite_locks_ddt_import_reasons.sql` 与 PostgreSQL `0097_suite_locks_ddt_import_reasons.sql`，均只新增可空列。历史任务默认未锁定。部署前备份并停止旧平台与工作器写入，应用迁移后同步升级全部 Web／Worker；单份迁移在事务内失败会回滚，可修复后重试。回退旧服务不会执行新锁定保护，回退期间需暂停任务编辑，不要删除新增列或历史说明。

### 2026-11-09 锁定与覆盖历史验证

15 个文件、155 项定向测试通过，真实 PostgreSQL 场景没有跳过；覆盖 SQLite／PostgreSQL 的新库、旧库升级、DDL 失败回滚与恢复，两个并发锁定请求只有一个成功，他人锁定任务的成员／配置／归档／恢复／删除／计划／通知／公开接入保护，修订冲突及批量归档跳过，以及导入覆盖理由和字段前后值持久化。

主要命令如下，PostgreSQL 地址仅通过本机临时测试环境注入：

```bash
pnpm exec vitest run \
  packages/domain/test/case-suite-lock.test.ts packages/domain/test/case-suite.test.ts \
  packages/db/test/suite-lock-migration.integration.test.ts \
  packages/db/test/ddt-compact-import.integration.test.ts \
  packages/db/test/suite-ddt-removal.integration.test.ts \
  packages/db/test/public-suite-execution.integration.test.ts \
  packages/application/test/manage-case-suites.test.ts \
  packages/application/test/public-suite-execution.test.ts \
  packages/application/test/manage-webhooks.test.ts packages/application/test/platform-operations.test.ts \
  apps/web/src/lib/api-error-mapping.test.ts apps/web/src/lib/case-suite-lock-api.test.ts \
  apps/web/src/lib/case-suite-delete-api.test.ts apps/web/src/lib/case-suite-schedule-api.test.ts \
  apps/web/src/lib/public-suite-execution-api.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @autoforge/db typecheck
pnpm --filter @autoforge/web typecheck
pnpm exec tsc --noEmit -p tsconfig.tests.json
pnpm --filter @autoforge/web build
```

生产 Lite 浏览器使用 `AUTOFORGE_E2E_EXTERNAL_SERVER=1`、独立数据目录及单 worker，分别运行：

```bash
pnpm exec playwright test tests/e2e/task-archives-history.spec.ts tests/e2e/ddt-management.spec.ts --grep '(task locks persist|DDT import refreshes an already opened)' --workers=1
pnpm exec playwright test tests/e2e/task-archives-history.spec.ts --grep 'manual task archiving and restoring preserves DDT members' --workers=1
```

三项通过：项目管理员之间的锁定与解除保护、真实表格覆盖后的说明／操作者／字段差异和未保存草稿保留，以及原有普通任务归档／恢复后 DDT 成员保留。初次覆盖说明表单验收发现控件名称包含帮助文字，补齐明确的可访问名称后复验通过。实际查看 1024×768、1536×960 的锁定弹窗、深浅色任务卡片／只读详情与字段差异弹窗，以及两个尺寸的覆盖说明表单截图；维护按钮整组换行，未出现新增溢出。证据位于本机 `/var/tmp/autoforge-suite-lock-ui/`，不提交截图或测试数据。

受影响文件的 Prettier／ESLint、测试类型与差异检查通过，重型检查串行限额执行。本轮未跑 Full 整栈浏览器、真实 Runner 或完整离线发布验收，不将定向回归等同于完整发布检查。
