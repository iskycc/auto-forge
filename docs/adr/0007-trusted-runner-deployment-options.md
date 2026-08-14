# ADR 0007：可信内网 Runner 的降级部署选项

- 状态：已接受
- 日期：2026-08-14

## 背景

部分离线内网执行机没有可委派的 cgroup v2，主平台也可能只通过内网 IP 提供 HTTP。
另有专用执行机需要直接以 root 运行 Agent。此前自动探测、调度兼容性、安装脚本和 Agent
运行时分别硬性要求 cgroup v2、HTTPS 和专用非特权账号，导致这些受控场景无法接入。

这些放宽会削弱资源隔离或传输保护，不能伪装成与默认安全部署等价。因此策略必须在界面和
文档中可见，并保留仍可执行的本地边界。

## 决策

1. JAR 发现不再限制 TestNG 测试类总数。上传大小、ZIP/JAR 条目数、解压总量、单 class
   大小和解析警告数量仍保持有界，避免取消数量限制后引入无界压缩包处理。
2. cgroup v2 从 Runner/assignment 的硬兼容要求改为可选 capability。探测会报告可用性；
   可用时安装器配置委派根并继续执行完整 cgroup 控制，不可用时允许安装和调度。
3. 无 cgroup 模式仍在启动用户命令前应用 `RLIMIT_FSIZE`、`RLIMIT_NOFILE` 和
   `RLIMIT_CORE=0`，并保留进程组清理、超时、日志/产物上限和工作区扫描。它不能硬性限制
   整个后代进程树的 CPU、内存和进程数量，只适合可信执行负载。
4. Runner Protocol 接受 HTTP 与 HTTPS 控制面 URL，包括内网 IP。HTTP 不提供传输加密，
   只能用于可信隔离网络；跨不可信网络继续要求 HTTPS。URL 仍拒绝凭据、查询、片段和其他协议。
5. 自动安装默认继续使用 `autoforge-agent` 专用账号。管理员可显式勾选 root 模式，安装器据此
   生成 `User=root` 的 systemd unit；其余 systemd hardening 保持不变。root 模式只用于专用、
   受控执行机，因为测试进程会继承更大的主机访问范围。
6. 解析升级前持久化的 Runner Protocol v1 `ExecutionSpec` 时移除已退役的
   `isolation:cgroup-v2` required capability，使排队 assignment 能按新兼容策略继续领取。

## 影响

- 无 cgroup 节点在 Runner 页面显示“降级隔离”并保持可调度，不再计入不兼容节点。
- HTTP 和 root 模式会显示风险提示；它们不改变默认推荐的 HTTPS、非特权账号和 cgroup v2 部署。
- 此变更不增加数据库迁移或 Runner Protocol schema 版本，但会改变 v1 执行快照的兼容归一化。
- 执行不可信 JAR 时仍应使用 cgroup v2、非特权账号，并优先使用已配置 seccomp、无网络和非 root
  用户的 container executor；无 cgroup/root 组合不能描述为安全沙箱。
