# 容量与故障运行手册

## 监控基线

关注 HTTP 5xx/延迟、SQLite/PG 连接与锁等待、队列 available/leased/dead-letter、调度延迟、活跃
lease、Runner capacity/busy、日志字节、产物数、失败 attempt、清理 pending/dead-letter 和数据盘
空间。指标默认关闭；高基数 batch/run/attempt/runner ID 只进入结构化日志，不作为指标标签。
系统诊断在平台数据卷使用率达到 85% 时预警、95% 时严重告警。Full 模式下该值只覆盖平台配置卷；
PostgreSQL 与 MinIO 数据卷还必须使用基础设施自身的容量告警，并在同一值班面板汇总。

## 故障处置

- 磁盘接近满：立即暂停导入和新执行、排空 Runner，先运行保留影响预览；不要直接删除对象。
  通过清理任务删除并核对死信。SQLite 至少预留当前数据库+WAL 两倍空间用于备份/升级。
- SQLite 锁：确认只有一个 Lite Web/嵌入式 worker 使用数据卷，检查长事务和异常进程；不要删除
  WAL/SHM。停止服务后备份并执行恢复演练。
- PostgreSQL 连接耗尽：停止扩 worker，检查每副本池和慢事务；恢复后逐批启动，防止连接风暴。
- NATS 故障：Web 的 PostgreSQL outbox 保留事实；恢复 JetStream 后 relay 重发。不要手工把
  assignment 标成成功。
- Redis 故障：业务事实不丢失；限速/缓存暂不可用时 readiness 失败。恢复后允许缓存重建。
- MinIO 故障：停止产物密集执行；元数据仍在 PostgreSQL。恢复 bucket 后重试上传/清理并核对摘要。
- Runner 大面积离线：暂停计划、排空剩余 Runner，区分 heartbeat 与 lease；等待租约恢复逻辑产生
  唯一终态/重试，禁止手工复制 running 任务。
- 队列积压：确认 worker readiness、死信错误码和下游容量，再有界增加 worker；监视 PG/NATS/MinIO
  反压，不无界提高并发。
- 密钥轮换：先备份与记录审计，按数据库/MinIO/LDAP、API token、Runner credential、平台主密钥
  顺序执行；每步验证旧凭据失效和新凭据 readiness。
- 回滚：停止 Web/worker，保留故障诊断，用上一镜像加升级前完整备份恢复；不做数据库原地降级。

Compose 模板默认启动一个 Web 与一个 worker；Full 可横向扩展。`pnpm test:full` 会同时启动两个
Web 与两个 worker 副本，共享 PostgreSQL、JetStream、MinIO 和 Redis，并通过两个 Web 副本读取同一
登录会话和 E2E 结果。副本必须使用同一份平台密文配置；端口差异仅是本地验收需要，生产由不同
主机/Pod 和负载均衡器处理。worker 依赖 outbox/JetStream 至少一次与数据库条件写防超卖。

滚动升级时先排空一半 worker，再逐个替换 Web；readiness 失败的副本不得接流量。终端 WebSocket
必须按 Runner/会话做粘性路由，普通 API 无此要求。支持规模以
[`performance-baseline.md`](./performance-baseline.md) 的固定门禁和目标硬件 24 小时 soak 为证据，
不能从默认并发推断。
