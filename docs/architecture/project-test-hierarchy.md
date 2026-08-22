# 项目测试层级与 Adapter 运行时

新用例资产使用固定层级：`Project → ProjectVersion → TestStage → 包目录 → CaseDefinition`。
版本和阶段在 SQLite/PostgreSQL 中分别持久化；导入入口同时校验项目、版本和阶段归属。迁移前没有
层级字段的旧用例保留历史引用，但不出现在新用例库/API 列表，也不能通过新详情页继续操作。

`directoryPath` 从静态发现的 Java 包名生成，只用于展示树和查询索引，不作为对象存储或本地文件
路径。用例库以默认折叠的目录节点展开包路径，并在同一页面的右侧工作区读取所选用例的执行历史、
分析事实和操作，不在浏览器聚合跨项目数据，也不要求跳转详情页。

每个用例任务保存 Adapter 启用状态、TestNG Suite Name、Test Name 和环境地址列表；每个项目版本
独立保存 JDK 资源与完整 JAR 依赖包。新版本不会隐式读取项目或其他版本的资源；管理员可以上传、
登记 HTTP(S) 链接，或显式从同项目另一个版本继承。继承只复制受外键保护的资源引用，相当于
对象存储上的软链接，不复制大文件；删除当前版本引用时，其他继承版本继续可用，最后一个引用
消失且没有活动批次快照后才回收上传对象。环境地址在批次创建时按任务中稳定的用例顺序轮询分配，
并连同任务参数和资源元数据写入不可变快照。上传不设置固定业务大小上限，但始终受对象存储、磁盘
和执行协议配额保护。

用例可在同项目的两个版本阶段之间显式继承。系统按 100 条窗口读取来源阶段，为目标阶段创建新的
`CaseDefinition`、v1 `CaseVersion` 和方法 ID，同时共享来源 JAR；完整类名已存在时跳过。目标版本
随后导入包含同类名的新 JAR 时继续使用目标定义 ID，并追加 `source.reimport` 不可变版本。

Assignment 包含权威测试 JAR 及快照中的 JDK/JAR 压缩包。Agent 只在 attempt 工作目录内下载，
逐项校验大小和 SHA-256，并在磁盘/展开字节/文件数预算内拒绝目录穿越、符号链接和特殊文件。
依赖包可保留任意内部布局；Adapter 自动发现 `test-jars` 下最多三层子目录内的全部 JAR，不另设
JAR 文件数量上限，扫描仍受总目录条目预算保护。
解压后执行：

```text
runtime/jdk/bin/java -jar /opt/autoforge/lib/cotest-testng-adapter.jar \
  --jars test-jars --class <binary-class-name> \
  --suite-name <task-suite> --test-name <task-test> \
  --environment-address <round-robin-task-address> --output reports/testng
```

未配置的可选参数不会传递。主用例 JAR 在 Adapter classpath 中优先，其余 JAR 确定性排序。每个
attempt 使用独立进程，Adapter 每次创建并关闭一个子优先 ClassLoader；JDK/XML/Adapter 自身类
父优先，因此既避免跨用例同名类污染，也不允许业务 JAR覆盖 Adapter 实现。

日志由 Agent 先脱敏并写有界 spool，再周期上传。控制面成功持久化后，Lite 直接向当前进程的
同源 WebSocket 订阅者发布，Full 先通过 NATS Core 在 Web 副本间广播，再向各自订阅者发布；浏览器
凭 `log.read` 权限换取 attempt 级短时 HMAC 票据。NATS 广播不保存业务事实，断线、背压或没有
订阅者不会影响执行、确认水位和最终结果，重新连接时从 PostgreSQL/SQLite 持久日志补齐。
