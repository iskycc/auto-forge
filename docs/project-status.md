# AutoForge 实现进展

> 审计日期：2026-08-11。任务定义和勾选状态以 [`Todo.md`](../Todo.md) 为权威来源；本文记录可复核的阶段汇总和验收证据。

## 总体进度

路线图共 180 项，已完成 179 项；所有 175 个编号功能/工程事项及 Gate A–D 均已完成。唯一未勾选项是 Gate E：它必须在本次变更提交后，由指向该提交的新语义版本标签构建不可变四平台 Release 资产，再记录断网实机验收证据，不能用工作树测试提前代替。

| 范围 | 状态 | 主要证据 |
| --- | --- | --- |
| M0–M5 核心平台 | 完成 | 双数据库、双对象存储、双队列、Runner Protocol 与 Go Agent 测试 |
| M6 PC 端 UI | 完成 | 1024/1920 视口、200% 缩放、键盘、减少动效与深色日志 E2E |
| M7 分析与洞察 | 完成 | 可重建事实、筛选/对比/flaky、异步导出及 Lite/Full 仓储测试 |
| M8 安全与运维 | 完成 | 结构化日志、指标/诊断、保留、备份/迁移、故障恢复与安全工作流 |
| M9 离线交付实现 | 完成 | 内置双架构 Agent、四镜像变体、工具链、签名、SBOM/摘要和断网门禁 |
| M10 自动化与文档 | 完成 | 完整质量命令、管理员/用户/Runner/API 手册、兼容矩阵和变更日志 |
| Gate E 正式 Release 验收 | 待版本标签 | 需不可变 Release 资产与实机验收记录 |

## 本次完成的产品能力

- 主平台只以 `--data-dir` 接受安装位置；业务配置、随机秘密、Lite/Full 组合、监听、基础设施、容量和调度参数均由首次初始化和后台页面持久化管理，不使用应用配置环境变量。
- 主平台内置 Linux `amd64`/`arm64` 静态 Agent。管理员在 Runner 页面输入 IP、SSH 用户和一次性密码、确认主机指纹后，可自动安装到 Ubuntu/openSUSE；安装脚本不调用 `apt`、`zypper` 或联网下载依赖。
- 未登录首页展示有界、脱敏且自动同步的真实统计大盘与系统介绍；业务页面按 PC 使用场景覆盖常见分辨率、缩放、键盘和状态展示，明确不把移动端纳入当前验收范围。
- 项目作用域贯穿来源、用例、任务、环境、密文、批次、日志、产物、搜索、分析、对象键与缓存键；服务账号/API 令牌、LDAP 计划同步、公平调度、单用例执行、通知、保留和审计均共享 Lite/Full 核心。
- Full 验收启动两套 Web 与两套 worker，完成真实 PostgreSQL、JetStream、MinIO、Redis 业务闭环，并逐项注入依赖中断，验证 readiness 降级、客户端有界重连、worker 有界恢复和数据不丢失。
- Release 不再生成独立 Agent 包；四种后端镜像均内置双架构 Agent，并输出 SBOM、统一清单、SHA-256、Ed25519 离线签名和来源证明。

## 当前验收证据

本工作树已实际通过：

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`：43 个 Vitest 文件、187 项 TypeScript 测试，全部 Go 包和 8 项发布/运维脚本测试。
- `pnpm test:integration`：11 个 Lite/共享文件、37 项测试；4 个外部依赖文件由 `test:full` 执行。
- `pnpm test:full`：4 个真实适配器/迁移文件、15 项测试，双 Web/worker E2E，以及 PostgreSQL/NATS/MinIO/Redis 故障恢复。
- `pnpm test:offline`：阻断全部出站网络后运行 LDAP 矩阵、Lite 生产构建 E2E和备份恢复对象摘要核对。
- `pnpm test:performance`：2,000 类/10,000 方法 JAR、10,000 次调度、10,000 条 SQLite 队列和约 10 MB 分页日志基线。
- `pnpm test:deployment`：Lite/Full Compose 校验和确定性部署包。
- `pnpm build`：双架构静态 Agent 资源、Next.js 生产服务和 Full worker 构建。
- `pnpm audit --prod --audit-level high`：未发现已知漏洞。
- Release 签名、Runner 工具链架构与 Lite 备份内层完整性专项测试。

远程结果以提交后的 GitHub Actions 为最终证据。

## Gate E 的完成条件

合并后的提交尚未拥有新的语义版本标签，因此不能声称已经从“本提交的不可变 Release 资产”完成生产验收。创建标签后按[断网发布验收](./operations/offline-acceptance.md)记录四平台资产摘要、签名/SBOM、安装、升级、备份恢复和 Agent 工具链实机结果，方可勾选 Gate E。
