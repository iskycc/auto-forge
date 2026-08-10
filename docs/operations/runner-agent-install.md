# Runner Agent 离线服务安装

本文适用于 systemd Linux 主机。Runner Agent 必须使用专用低权限账号；不要使用 root 运行。安装介质中的二进制、JDK、TestNG JAR、校验和和 SBOM 应先在联网中转区准备，再带入离线区。

## 1. 校验并安装文件

根据主机选择 `amd64`、`arm64`、`amd64-musl` 或 `arm64-musl` 资产，先验证发布目录中的 `SHA256SUMS`。以下命令由管理员执行：

```bash
getent group autoforge-agent >/dev/null || groupadd --system autoforge-agent
id autoforge-agent >/dev/null 2>&1 || useradd --system --gid autoforge-agent \
  --home-dir /var/lib/autoforge-agent --shell /usr/sbin/nologin autoforge-agent
install -d -o root -g root -m 0755 /opt/autoforge-agent/bin /opt/autoforge-toolchain
install -d -o root -g autoforge-agent -m 0750 /etc/autoforge-agent
install -o root -g root -m 0755 autoforge-agent /opt/autoforge-agent/bin/autoforge-agent
install -o root -g root -m 0644 autoforge-agent.service /etc/systemd/system/autoforge-agent.service
install -o root -g autoforge-agent -m 0640 agent.env /etc/autoforge-agent/agent.env
```

JDK 与 TestNG 依赖放在 `/opt/autoforge-toolchain`，由 root 拥有并只对 Agent 可读。运行时不得使用 Maven、Gradle、浏览器安装器或其他联网下载器补齐依赖。

随发布物提供的 service 模板通过 `Delegate=cpu memory pids` 将该服务自己的 cgroup v2 子树交给低权限 Agent，并把 `AUTOFORGE_AGENT_CGROUP_ROOT=auto` 解析到当前 service cgroup。为此模板不能启用 `ProtectControlGroups=true`；内核仍只允许服务账号管理被委派的子树，`CapabilityBoundingSet` 和 `AmbientCapabilities` 保持为空。安装后先执行：

```bash
systemd-run --wait --pipe --collect --unit=autoforge-agent-doctor \
  --uid=autoforge-agent --property='Delegate=cpu memory pids' \
  --property=EnvironmentFile=/etc/autoforge-agent/agent.env \
  /opt/autoforge-agent/bin/autoforge-agent doctor
```

doctor 必须显示 `resourceControl` 为 service cgroup 路径，并包含 `isolation:cgroup-v2` capability。缺少 controller、只读挂载或委派权限时 Agent 会拒绝启动，而不会无界执行任务。

## 2. 配置私有 CA 与注册

将企业 CA 链以 PEM 格式安装为 `/etc/autoforge-agent/ca.pem`，权限 `0644 root:root`。`AUTOFORGE_SERVER_URL` 必须使用 HTTPS，证书主机名必须匹配；禁止用跳过 TLS 校验代替安装 CA。

首次注册时，在权限为 `0640 root:autoforge-agent` 的 `agent.env` 中临时增加下列一行并启动服务：

```bash
AUTOFORGE_AGENT_BOOTSTRAP_TOKEN=一次性令牌
systemctl enable --now autoforge-agent
journalctl -u autoforge-agent --follow
```

看到 `runner registered` 后，身份已经以 `0600` 权限保存在 `/var/lib/autoforge-agent`。立即从 `agent.env` 删除 token 行并执行 `systemctl restart autoforge-agent`；同时清理编辑器备份和临时介质。后续启动只读取 Runner 身份，不再需要 bootstrap token。

## 3. 启动、检查与停止

```bash
systemctl daemon-reload
systemctl enable --now autoforge-agent
systemctl status autoforge-agent
journalctl -u autoforge-agent --since today
systemctl stop autoforge-agent
```

停止时 Agent 先停止领取新任务，在 `AUTOFORGE_AGENT_SHUTDOWN_GRACE` 内等待在途 attempt；超过期限后取消进程组。身份、spool 和 attempt 状态保留在 `/var/lib/autoforge-agent`，下次启动先 reconcile，不能直接删除以“解决”未完成任务。

Agent 诊断写入 journald，用例 stdout/stderr 写有界 spool 并上传控制面，两者不能混作同一日志。可将 `journald-autoforge.conf` 安装到 `/etc/systemd/journald.conf.d/` 后重启 journald，以限制整机 journal 用量和保留时间；这些值影响同机所有 journal，安装前应由主机管理员评审。

每个 attempt 使用独立子 cgroup：`cpu.max`、`memory.max`/`memory.swap.max` 和 `pids.max` 是内核硬限制；启动包装进程在执行 Java 前设置单文件大小、打开文件数和 core dump rlimit。Agent 每 100ms 监督工作目录总字节数和条目数并在超限后杀死整个 cgroup。该扫描存在最多一个采样周期的瞬时超写窗口；需要严格阻止工作目录占满共享文件系统时，应把 `/var/lib/autoforge-agent/work` 放在具有固定容量或项目配额的专用文件系统上。

## 4. 升级与回滚

控制面 Runner 页面会同时显示 Agent/协议版本、Linux 架构、Java/TestNG 工具链和资源隔离兼容性。不兼容节点不会获得新 assignment。停止服务，从当前离线 Release 介质选择与页面架构匹配的 `amd64`、`arm64`、`amd64-musl` 或 `arm64-musl` 资产，验证校验和，将旧二进制保留为只读回滚副本，再原子替换。先运行 `autoforge-agent doctor` 检查协议、CA、目录、cgroup 委派和离线工具链，确认控制面兼容后启动。回滚不得降到控制面已拒绝的协议版本。

## 5. 卸载

```bash
systemctl disable --now autoforge-agent
rm -f /etc/systemd/system/autoforge-agent.service
systemctl daemon-reload
```

默认保留 `/var/lib/autoforge-agent` 供审计和恢复。确认没有在途 attempt、待确认日志或合规保留要求后，才可由管理员删除状态目录、配置、CA、工具链和专用账号。控制面还应撤销对应 Runner 身份；只删除本机文件不会使服务端凭据自动失效。
