# Full 三主机运行链路与容量诊断

适用当前 Full 三主机直连部署，不改变 Lite、Runner 协议或业务数据库事实来源。此处描述代码检查与本地真实中间件验证，不代表在用户的三台生产主机上完成过压测。

## 组件分布与执行链路

| 主机 | 组件 | 当前职责 |
| --- | --- | --- |
| A | Web、随平台启动或独立启动的 worker | 身份、HTTP、控制面、执行预检、调度计算、导入解析和只读投影；不执行用户 TestNG 进程 |
| B | 主 PostgreSQL、Redis | 业务和执行事实、assignment／lease、outbox、执行快照；实时日志分发、短期回放和共享请求限流 |
| C | MinIO、NATS JetStream | JAR、运行依赖、产物和归档；内部执行／后台消息持久交付 |
| 独立日志服务 | PostgreSQL 日志服务器 | 日级日志数据库和读取路由；可先与某台主机合设，但磁盘、连接和备份应独立评估 |

1. 提交任务将执行快照与 outbox 写入主库；outbox 发布 JetStream，失败可重试。
2. dispatcher 消费后写入 assignment，再确认内部消息。执行类和后台类使用独立持久 consumer。
3. Runner 只连接平台，领取后通过 lease 续租；实际 Java 进程在 Runner 主机执行。
4. 日志写入独立日志服务器并保留所属服务器／日期路由；Redis 只帮助实时分发，不能代替日志持久化及确认水位。
5. 结果由带版本条件的数据库状态变更确认；历史列表使用数据库投影／快照。MinIO 对象和 Redis 内容都不决定执行终态。

多个普通 worker 不等于多个 Runner 槽位。Web 内的控制、调度、维护、只读投影车道分别有资源和数据库连接预算。增加 worker 会同时增加数据库连接、CPU 和网络负载，不能直接按主机核数启动同等数量进程。

## 此次落实的改进

- HTTP 完成事件继续完整计入指标，但成功请求不输出逐条容器日志；4xx 输出 warning，5xx 输出 error。启动、关闭、后台异常等诊断日志继续保留。请求路径既有的能力令牌脱敏继续生效，不记录查询参数、请求体或认证头。
- 平台诊断的数据库、对象存储、任务队列、缓存卡片可打开运行指标。只在点击时读取，15 秒复用快照，同组件并发请求合并，3 秒返回可用结果或明确不可用状态。底层未完成探针保留单一在途请求，避免刷新放大连接数。
- PostgreSQL 查询当前库体积、连接、事务、缓冲命中及死锁；Web 池的等待数单独显示，不冒充所有 worker 的池统计。
- JetStream 只读取平台 stream 及两个 consumer 的消息、字节、待消费、待确认和重投递计数；不领取、ack 或移动消息。
- Redis 使用 INFO 白名单字段，不运行 KEYS、不遍历缓存内容；实例指标与平台逻辑库键数明确区分。
- MinIO 只读取 bucket 元数据。对象数量和逻辑体积来自已发布的存储清单快照并标明时间；没有快照时明确缺失，打开详情不会触发全桶扫描。需要更新时在“文件管理 → 存储空间”主动重新扫描。该体积不含旧版本、纠删码／副本开销等 MinIO 宿主机成本。
- 通用 Redis 连接关闭离线命令排队、限制原生待发送／待回复队列为 128；实时日志连接保持更小的 64 项预算。原生命令 timeout 只控制发送前排队，新增 3 秒调用方回复期限覆盖发出后等待。超时后的原生命令仍由驱动观察，晚到错误不会形成未处理拒绝；队列上限防止无限积压。
- Redis 限流读取失败返回明确的 503，不降级成本地限流。实时日志传输失败沿用持久化日志和本节点展示的回退行为；不改写数据库日志确认。上述保护限制等待与内存积压，不能消除中间件故障。

## 宿主机／数据卷磁盘余量

PostgreSQL 原生 `pg_database_size`、`pg_tablespace_size` 提供已占用大小，**不能计算宿主机文件系统剩余空间**。参见 [PostgreSQL 15 管理函数](https://www.postgresql.org/docs/15/functions-admin.html)与[磁盘使用说明](https://www.postgresql.org/docs/15/diskusage.html)。

`fast-deploy/node-b`、`fast-deploy/log-postgres` 和 `deploy/compose/full-bind/log-postgres` 的 PostgreSQL 健康检查会在容器内使用 `df -Pk "$PGDATA"`，原子更新 `$PGDATA/autoforge-storage-capacity.json`，没有新增容器或必运行脚本。bind 目录挂载在哪个文件系统，采样就报告哪个文件系统。已有部署需更新 Compose 并重建该 PostgreSQL 容器，数据目录保持原 bind 配置。

平台只执行固定路径、4096 字节上限的 `pg_read_file` 读取，校验版本、容量与时间；缺失、权限不足、内容损坏和超过两分钟都明确显示，未自动安装扩展、运行数据库 Shell 或授予权限。无法更改健康检查的数据库可由运维按同一 JSON 格式原子写入采样，数据库角色需具备该文件的读取权限；不要为了显示容量向普通业务账号授予整个文件系统权限。

```json
{"schemaVersion":1,"capacityBytes":107374182400,"availableBytes":64424509440,"sampledAt":"2026-10-31T08:00:00Z"}
```

入口：**平台设置 → 日志数据库 → 查看容量**。当前写入服务器自动读取一次，其他服务器点击时读取；15 秒缓存、同服务器请求合并，最多四个服务器同时检查。低于 20% 提示注意。数据库连接仍使用已有服务端凭据，返回值不包含用户名密码或 URL。

显示的是 **PGDATA 文件系统**，不是整台宿主机所有挂载点的空间汇总。独立 tablespace 或另挂的 WAL 文件系统需另行监控；容器 PGDATA 没有正确 bind 到数据盘时，此处会如实显示容器层对应的文件系统。日志库日级分库和归档删除不会自动收缩所有 PostgreSQL 文件；需要结合 VACUUM、WAL 保留、备份、归档状态判断磁盘释放。

## 三主机资源利用与后续调优

| 观察到的指标 | 优先动作与边界 |
| --- | --- |
| Web 主池等待持续大于 0 | 先核对活动连接、长事务和 SQL 延迟，再计算连接预算。预算包含所有 Web／独立 worker 主池、执行池、调度车道、维护／投影池、时钟池及独立日志库池，不能只把 `databasePoolMax` 当作实例总连接数。为迁移、诊断、DBA 和故障恢复保留余量 |
| JetStream 待消费增长且数据库正常 | 检查 worker 活性、后台／执行类 consumer、CPU 和网络，再逐步增加 worker。待确认消息不是 Runner 正在执行数，不能据此提高任务并发 |
| Redis 淘汰、客户端阻塞或回复超时 | 检查 B 主机内存与磁盘；实时回放有 TTL，但共享限流 key 也在该实例，随意采用淘汰策略可能削弱限流。先核算业务峰值，再配置 maxmemory，不自动修改用户的 Redis 策略 |
| MinIO 访问慢、C 主机磁盘延迟高 | 分析 JAR／依赖下载、归档和 JetStream 写盘竞争。将 MinIO 与 NATS 的数据目录绑定到合适的数据盘，必要时拆盘或拆机；增加 Web worker 不能解决存储延迟 |
| 主库大而日志库正常 | 查看执行记录、快照、outbox／工作队列保留与索引；不能将所有主库数据转存 Redis。已结束记录仍以数据库快照读取，缓存不能绕过版本条件 |
| 日志数据卷余量低 | 先完成月度归档校验和下载确认，再按既有独立确认流程清理在线日志／平台归档副本。MinIO 和日志数据库的容量分别观察 |

目前三主机中间件仍为单实例；这些改动提供诊断和有界退避，不构成高可用集群。Redis、NATS 或主库重启仍可能暂时返回 503；应使用任务幂等入口和既有恢复流程，不能靠反复提交绕过故障。若需要容忍任意主机故障，应另行设计 PostgreSQL 故障切换、JetStream 副本、MinIO 拓扑和 Redis 可用性，并进行真实故障演练。

此次没有增加新的业务 Redis 缓存、放大数据库连接池、自动修改中间件内存参数或替换 outbox／租约机制；在没有三台实际主机的负载数据前，这些调整不能作为已经验证的性能结论。

## 验证记录（2026-10-31）

- `pnpm --filter @autoforge/web build`、`pnpm --filter @autoforge/worker build` 通过；Web／server／工作线程使用最终代码构建。
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.server.json`、`apps/web/tsconfig.worker.json`、`apps/worker/tsconfig.json`、`tsconfig.tests.json` 分别通过；Web 页面类型检查由生产构建执行并通过。
- 两组定向 `pnpm exec vitest run ... --maxWorkers=1 --no-file-parallelism` 共 31 个文件、181 项通过。覆盖请求日志及指标、脱敏、关联表格读回、预检／幂等／指纹冲突／部分失败、两种 DDT 仓储、按日日志及历史日志路由、真实 PostgreSQL／Redis／JetStream／MinIO、Redis 回复超时恢复、UI 组件约束和运行指标。
- `node --test scripts/operations/fast-deploy.test.mjs scripts/release/build-deployment-bundle.test.mjs` 共 7 项通过，包含实际 Compose 展开、采样 Shell 成功／失败／保留上次采样、部署包与新增指南交付。
- `pnpm test:e2e:matrix`、`pnpm licenses:check`、改动范围 `prettier --check`、`eslint --max-warnings=0`、`git diff --check` 通过。
- 最终生产构建上运行 `pnpm exec playwright test tests/e2e/ddt-management.spec.ts tests/e2e/platform-operations.spec.ts tests/e2e/log-databases.spec.ts --grep='SR association Excel transfers|middleware usage opens lazily|log server capacity reports' --workers=1`：Lite 2 项、Full 3 项通过。SR 用例、分类、候选类和历史直接关联使用实际导入数据；Full 连接本地真实 PostgreSQL、Redis、MinIO、NATS，并读取实际数据卷采样。重复导入为零变更，错误指标请求可刷新恢复。
- 已实际查看 1024×768、1536×1024 截图及深色主题，检查 SR 工具栏／导入预览、中间件详情、日志库容量；无页面横向溢出、按钮重叠或弹窗变形，长内容使用弹窗内滚动。截图和命令记录保存在本机 `/var/tmp/autoforge-usage-20261031/`，未提交生成产物。

本轮未执行完整根目录测试、Go Runner 执行／离线验收或三台物理主机的故障压测；本次无 Runner 协议、执行器、依赖或数据库迁移变化。Full 本地真实中间件验证不等于已经对用户内网完成现场验收。临时容器及其匿名数据卷已清理。
