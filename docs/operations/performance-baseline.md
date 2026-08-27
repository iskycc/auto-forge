# 性能与稳定性基线

`pnpm test:performance` 是可重复、无公网依赖的单机基线。它使用真实 TestNG 发现器、调度领域逻辑、
SQLite 持久队列和执行日志仓储，固定验证以下支持规模：

| 路径          |                                                固定负载 |                            通过阈值 |
| ------------- | ------------------------------------------------------: | ----------------------------------: |
| JAR 静态发现  |                             2,000 class / 10,000 method |                               30 秒 |
| 调度窗口      | 100,000-run 任务中的 4,096 run / 50 Runner / 1,000 slot |              2 秒且零超卖、均衡分配 |
| Lite 执行批次 |                            100,000 run / 4,096 调度窗口 |                 60 秒且摘要计数完整 |
| Lite 任务终止 |                                      100,000 queued run |              5 秒且全部原子进入终态 |
| Lite 并发预留 |                                    25 Runner / 500 slot |       5 秒且 500 个 assignment 完整 |
| Lite 协议链路 |                8 Runner / 500 slot / 500 日志与完成上报 | 90 秒；读 P95 < 1.5 秒、最大 < 5 秒 |
| Lite 任务成员 |                                            100,000 case |           60 秒且只生成一个任务版本 |
| Lite 队列     |                        10,000 job / 8 worker connection |       60 秒且零重复、100 次租约恢复 |
| Lite 日志     |                                20,000 chunk，约 9.7 MiB |         60 秒，500 条分页且完整水位 |

阈值是回归门禁，不是所有硬件的吞吐承诺。正式容量评估还需按实际 JAR、日志大小、磁盘延迟、
Runner 时长和保留期测量，并预留至少 30% 余量。测试会输出 JSON 计时证据；CI 使用 GitHub
`ubuntu-24.04` runner，开发机结果不能直接替代生产硬件压测。

`pnpm test:lite-concurrency` 通过生产构建和真实 HTTP Route Handler 创建 500 个用例，使用 8 个
虚拟 Runner 完成注册、心跳、领取、日志上传和完成上报，同时持续读取执行记录接口。CI 和 Release
checks 都把 JSON 指标与失败 trace 上传为 workflow artifact，便于比较任务创建、领取、协议完成及
页面读延迟。它模拟的是 500 个控制面协议槽位，不启动 500 个 JVM，也不把短用例等同于真实业务
用例耗时。

GitHub 官方当前为公开仓库标准 `ubuntu-24.04` 托管机提供 4 vCPU、16 GB 内存和 14 GB SSD；因此
这个 Job 是资源更紧的代码回归门禁，不是 16U/32G 生产容量证明。16U/32G 的 500 并发承诺仍需在
同规格 self-hosted runner 或发布候选环境运行真实 Agent/JVM soak。Runner 规格以
[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
为准，指标留存遵循
[workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)。

Full 的正确性与依赖故障由 `pnpm test:full` 使用真实 PostgreSQL、JetStream、MinIO 和 Redis 验证；
其中 PostgreSQL 容量用例固定写入 100,000 个任务成员，并创建 100,000-run 批次验证
4,096 行调度窗口；该容量契约使用独立 CI 分片，避免延长真实 Agent 生命周期场景。Full 测试
容器使用 1 GiB 临时数据盘，避免测试设施自身制造伪故障。
水平副本演练按容量故障手册执行。长时间稳定性使用队列租约过期/恢复循环覆盖控制状态泄漏，发布
候选环境仍应运行至少 24 小时的组织级 soak，并记录队列深度、数据库连接、对象增长和 Agent spool。

## Full 与 Lite 控制面基准

2026-08-27 在同一台 4 vCPU / 7 GiB 单机上使用 500 用例、8 个虚拟 Runner、500 个槽位完成
Full/Lite 对照。修复前 Full 暴露了两个正确性问题：并发最后完成可能遗漏批次终态迁移；并发调度
会为未实际预留的 attempt 写事件并触发外键冲突。当前实现通过提交后在途探针、批次终态锁内
复核、只为已接受预留写事件，以及相应 PostgreSQL 并发回归测试修复这两个问题。

优化还包括 Runner 高频协议快路径、任务摘要读取、批量 Runner/attempt 上下文读取、条件式批量
预留、日志 SQLite 预编译语句、JetStream 阻塞领取标记、Full 调度线程预热及可配置 PostgreSQL
连接池。18 轮 Full 复验没有出现卡死批次或孤儿调度事件。最终构建的中位数如下；数字仅用于同机
回归比较，不是生产吞吐承诺：

| 阶段 | Full | Lite | Full / Lite |
| --- | ---: | ---: | ---: |
| 500 用例导入 | 2,241 ms | 1,728 ms（波动较大） | 约 1.0–1.3x |
| 批次创建与调度 | 417 ms | 292 ms | 1.43x |
| 500 槽位领取 | 374 ms | 392 ms | 0.95x |
| 500 次日志上传与完成 | 4,720 ms | 3,831 ms | 1.23x |
| 读探针 P95 | 298 ms | 189 ms | 1.58x |

单机上 PostgreSQL、NATS、MinIO、Redis、Web、worker 与压测客户端共享 CPU，Full 不保证全面快于
Lite；它的主要收益仍是多 Web/worker 副本、基础设施故障隔离和横向扩展。选择模式时应同时考虑
运维成本与目标拓扑，而不能只比较单机阶段耗时。
