# 性能与稳定性基线

`pnpm test:performance` 是可重复、无公网依赖的单机基线。它使用真实 TestNG 发现器、调度领域逻辑、
SQLite 持久队列和执行日志仓储，固定验证以下支持规模：

| 路径 | 固定负载 | 通过阈值 |
| --- | ---: | ---: |
| JAR 静态发现 | 2,000 class / 10,000 method | 30 秒 |
| 调度 | 10,000 run / 50 Runner / 1,000 slot | 10 秒且零超卖、均衡分配 |
| Lite 队列 | 10,000 job / 8 worker connection | 60 秒且零重复、100 次租约恢复 |
| Lite 日志 | 20,000 chunk，约 9.7 MiB | 60 秒，500 条分页且完整水位 |

阈值是回归门禁，不是所有硬件的吞吐承诺。正式容量评估还需按实际 JAR、日志大小、磁盘延迟、
Runner 时长和保留期测量，并预留至少 30% 余量。测试会输出 JSON 计时证据；CI 使用 GitHub
`ubuntu-24.04` runner，开发机结果不能直接替代生产硬件压测。

Full 的正确性与依赖故障由 `pnpm test:full` 使用真实 PostgreSQL、JetStream、MinIO 和 Redis 验证；
水平副本演练按容量故障手册执行。长时间稳定性使用队列租约过期/恢复循环覆盖控制状态泄漏，发布
候选环境仍应运行至少 24 小时的组织级 soak，并记录队列深度、数据库连接、对象增长和 Agent spool。
