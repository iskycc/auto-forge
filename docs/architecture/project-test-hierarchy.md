# 项目测试层级与 Adapter 运行时

新用例资产使用固定层级：`Project → ProjectVersion → TestStage → 包目录 → CaseDefinition`。
版本和阶段在 SQLite/PostgreSQL 中分别持久化；导入入口同时校验项目、版本和阶段归属。迁移前没有
层级字段的旧用例保留历史引用，但不出现在新用例库/API 列表，也不能通过新详情页继续操作。

`directoryPath` 从静态发现的 Java 包名生成，只用于展示树和查询索引，不作为对象存储或本地文件
路径。用例库以目录节点展开包路径，叶节点链接到单用例详情；详情读取同一权威仓储中的执行历史
与分析事实，不在浏览器聚合跨项目数据。

每个项目保存一份带 revision 的 Adapter 配置：TestNG Suite Name、Test Name、环境地址、JDK
资源和完整 JAR 依赖包。运行时资源可以上传到 Lite 本地对象存储/Full MinIO，也可以登记 HTTP(S)
链接；两种方式都保存文件名、格式、精确大小和 SHA-256。批次创建时将配置和资源元数据序列化为
不可变快照，之后修改项目配置不会改变已排队批次。

Assignment 包含权威测试 JAR 及快照中的 JDK/JAR 压缩包。Agent 只在 attempt 工作目录内下载，
逐项校验大小和 SHA-256，并在磁盘/文件数预算内拒绝目录穿越、过深路径、符号链接和特殊文件。
解压后执行：

```text
runtime/jdk/bin/java -jar /opt/autoforge/lib/cotest-testng-adapter.jar \
  --jars test-jars --class <binary-class-name> \
  --suite-name <project-suite> --test-name <project-test> \
  --environment-address <project-address> --output reports/testng
```

未配置的可选参数不会传递。主用例 JAR 在 Adapter classpath 中优先，其余 JAR 确定性排序。每个
attempt 使用独立进程，Adapter 每次创建并关闭一个子优先 ClassLoader；JDK/XML/Adapter 自身类
父优先，因此既避免跨用例同名类污染，也不允许业务 JAR覆盖 Adapter 实现。

日志由 Agent 先脱敏并写有界 spool，再周期上传。控制面成功持久化后，Lite 直接向当前进程的
同源 WebSocket 订阅者发布，Full 先通过 NATS Core 在 Web 副本间广播，再向各自订阅者发布；浏览器
凭 `log.read` 权限换取 attempt 级短时 HMAC 票据。NATS 广播不保存业务事实，断线、背压或没有
订阅者不会影响执行、确认水位和最终结果，重新连接时从 PostgreSQL/SQLite 持久日志补齐。
