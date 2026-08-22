# 用例来源生命周期

本文描述 JAR 用例来源（CaseSource）的目录对比、权威同步、归档与删除。导入与静态扫描见 [TestNG 发现](./testng-discovery.md)。

## 概念

- 每个项目（project）最多一个**权威来源**；`CaseVersion.sourceId` 固化该版本实际使用的 JAR，新批次创建时再把版本号写入 `ExecutionRun`。
- JAR 对象按项目和内容摘要寻址。不同版本/阶段的来源可以引用同一个对象；SHA-256 导入幂等键和后台队列去重键都包含完整项目层级。
- 来源生命周期：`active` → `archived`（可恢复）或 `active` → `deleting`（终态）。
- 对比结果（CaseSourceComparison）持久化在 `case_source_comparisons`，确认同步依赖它做一致性校验。

## 目录对比

`POST /api/v1/case-sources/{sourceId}/comparisons` 以候选来源与当前权威来源做对比：

- 两侧取各用例当前版本的快照，应用层对快照做规范化 JSON（递归排序键）后计算 SHA-256 签名。
- 按 `className` 对齐：候选独有计入 `added`，签名不同计入 `changed`，权威独有计入 `removed`；任一侧内部出现重复 `className` 时整组计入 `conflicts`，不参与一一对应。
- 四类名单分别截断到 5000 条，截断时 `truncated=true`，完整数量不可知。
- 对比要求来源状态为 `ready` 且不是权威来源；没有权威来源时所有候选用例计入 `added`。

## 权威同步（保留语义）

`POST /api/v1/case-sources/{sourceId}/sync` 携带 `comparisonId` 与 `expectedRevision` 确认切换：

- 对比结果不存在、与候选不匹配时返回 404/400。
- 对比之后权威来源发生变化（他人已切换）返回 `CASE_SOURCE_SYNC_STALE`（409），必须重新对比。
- 修订号冲突返回 `CASE_SOURCE_REVISION_CONFLICT`（409）。

导入阶段先采用**稳定 ID 覆盖语义**：同一项目版本/测试阶段内按完整 `className` 对齐；匹配项保留原 `CaseDefinition` ID、人工展示名、描述、标签、归档状态和任务关系，替换包路径、参数、分组、启停及方法并追加 `source.reimport` 版本。候选来源确认同步采用**保留语义**：

- 当前与候选中按 `className` 唯一匹配且仍是不同定义的旧数据会合并到原 `CaseDefinition` ID；正常重导已经在导入事务中追加版本，确认同步只切换权威来源，不会重复生成版本。
- 候选独有用例保留导入时创建的 `CaseDefinition` 与 v1；候选中消失的旧用例不会被自动禁用或归档，由用户按对比结果自行处理。
- 冲突类不自动合并。若候选导入产生的临时定义已被任务或执行引用，确认同步返回 409，避免静默改写引用。
- 每个版本记录实际 `sourceId`。批次创建时固化 `caseVersion`，分配时按 `(caseDefinitionId, caseVersion)` 解析 JAR，因此排队期间再次同步或手动恢复不会改变已创建批次的输入。
- 原来源只要仍被历史版本引用就不能删除；可归档保留，以继续支持历史执行、重试和审计。
- 跨版本继承会在目标阶段创建独立 `CaseDefinition` 与 v1，但 `sourceId` 仍指向来源 JAR；因此继承
  不复制对象，来源删除守卫也会把这些目标版本引用计入，避免误删仍可执行的共享 JAR。

## 归档与恢复

`PATCH /api/v1/case-sources/{sourceId}` 携带 `archived` 与 `expectedRevision` 在 `active`/`archived` 之间切换。归档来源仍在来源列表中可见并标记状态，其用例与历史执行保持可读。当前归档是纯生命周期标记：只有 `active` 来源允许删除，归档是来源退役前的推荐状态。

## 删除

`DELETE /api/v1/case-sources/{sourceId}` 的守卫按顺序执行：

1. 权威来源返回 `CASE_SOURCE_AUTHORITATIVE`（409），先切换权威。
2. 非 `active` 状态返回 `CASE_SOURCE_NOT_DELETABLE`（409）。
3. 仍被用例定义或执行记录引用返回 `CASE_SOURCE_IN_USE`（409，`details` 带计数），应先归档。

通过守卫后，仓储在同一事务内把来源置为 `deleting` 并写入 `cleanup_jobs` 行（`category=case-source`，携带 JAR `objectKey`），随后以去重键 `object-cleanup:{cleanupJobId}` 发布 `object-cleanup` 队列消息。Lite 由嵌入式工作器消费，Full 由独立 worker 进程消费；两种模式使用同一个 `CaseSourceService.objectCleanupHandler()`：

- 处理器先检查是否还有其他版本/阶段的来源引用同一对象；仅最后一个引用删除时回收 JAR，并把清理任务标记为 `succeeded`（attemptCount+1）。
- 重复投递时任务已 `succeeded`，直接返回，保持幂等。
- 删除对象失败由队列重试；达到最大尝试后进入死信，清理任务保留诊断信息。

清理成功后删除处于 `deleting` 的来源行，对比历史按数据库引用策略保留；共享 JAR 对象只在没有其他来源引用时删除。
