# Runner Agent 自动安装与运维

Runner Agent 是主平台的内部资源，不再从 GitHub Release 单独下载。每个后端镜像包含 Linux `amd64`、`arm64` 两个 `CGO_ENABLED=0` 静态二进制、CoTest Adapter JAR、受控安装脚本和带 SHA-256 的版本化资源清单。

安装后的身份由 Agent 私有保存。管理员可在执行机页面请求无明文回传的凭据轮换；Agent 在下一次
心跳完成交换并原子写盘，旧凭据保留 15 分钟宽限。轮换未完成会在页面显示“等待轮换”，应先检查
Agent 诊断日志和数据盘空间，不要直接删除身份文件。

## 支持范围

自动安装支持：

- Ubuntu、openSUSE Leap、openSUSE Tumbleweed；
- Linux `amd64` 或 `arm64`；
- systemd 与 Bash；cgroup v2 可选，可用时自动启用更强的资源隔离；
- root SSH 用户，或能用同一密码执行 sudo 的普通用户。

目标机必须已有 SSH Server、Bash、`install`/`cp`/`mv`/`id` 等基础系统命令、systemd；普通用户场景必须已有 sudo。安装脚本不会调用系统包管理器，不会下载或安装任何依赖。JDK 与测试依赖可通过项目上传/链接随任务提供；浏览器和驱动等其他资源仍需纳入同一受控依赖包或由管理员预置。

## 安装

1. 在“平台配置”设置执行机能够访问的 HTTP 或 HTTPS 地址；可信内网可直接填写 `http://内网IP:端口`，跨不可信网络应使用 HTTPS。私有 PKI 场景准备 PEM CA 链。保存后重启 Web/worker。
2. 进入“执行机”，填写 IP/主机名、SSH 端口、用户名和密码，点击“探测并核验主机”。
3. 平台通过 SSH 读取 `/etc/os-release`、架构、Bash、systemd、cgroup v2 可用性和提权能力，并显示 SSH 主机密钥 SHA-256 指纹。缺少 cgroup v2 时探测仍成功，但页面会标记“降级隔离”。openSUSE 被错误报告为 SLES 时会结合系统名称识别；仍不能自动确认时，可在核验主机后手动强制选择安装模式。通过独立可信渠道核对后勾选确认。
4. 设置 Runner 名称、标签、并发和终端策略；默认以专用非特权账号运行，也可显式选择 root 模式。私有 CA 场景粘贴 PEM，然后执行安装。默认数据盘空间不足时，可在“工作目录”填写自定义绝对路径（如 `/data/autoforge-agent`）；留空使用默认 `/var/lib/autoforge-agent`。

安装请求会再次强制匹配已确认指纹。平台读取内置资源时校验清单，SFTP 上传后读回并复核大小/SHA-256，再以固定参数执行脚本。首次安装或手动更新成功后，主机、端口、用户名、密码和可选私有 CA 会使用平台主密钥及 AES-256-GCM 保存为版本化连接档案；API 只返回不含密码和 CA 的摘要，审计与日志也不记录这些明文。已保存档案可用于后续重新安装、单机更新和最多 50 台执行机的有界批量更新，SSH 主机指纹校验不会因此降级。

默认模式会创建专用 `autoforge-agent` 系统账号；root 模式直接使用已有 root 账号。两种模式都安装：

```text
/opt/autoforge/bin/autoforge-agent
/opt/autoforge/lib/cotest-testng-adapter.jar
/etc/autoforge-agent/config.json
/etc/autoforge-agent/control-plane-ca.pem  # 仅私有 CA
/etc/systemd/system/autoforge-agent.service
<工作目录>/  # 默认 /var/lib/autoforge-agent/
```

systemd 的 `WorkingDirectory` 与 Agent 配置的 `dataDirectory` 一致，默认 `/var/lib/autoforge-agent`；自定义目录由安装脚本创建并授权给服务账号，且 systemd unit 不再依赖 `StateDirectory`。终端默认 Shell 为探测到的 Bash。

更换工作目录只影响新安装或更新时写入的配置：原目录中的本地身份、凭据与 spool 不会自动迁移。更换后执行机会作为新节点重新注册，旧身份应先撤销或注销。

在“更新执行机 Agent”对话框中留空“工作目录”表示保持执行机当前目录；平台会先通过 SSH 读回远端 `/etc/autoforge-agent/config.json` 中已有的 `dataDirectory` 并沿用，升级不会把自定义目录重置回默认值。

systemd 服务启用 `NoNewPrivileges`、只读系统目录、私有临时目录、任务数上限和 cgroup 委派。非 root 是默认且推荐模式；root 模式会扩大测试进程可读取或修改的主机资源范围，只应在专用、受控的内网执行机上使用。安装失败会恢复上一版二进制、配置和 unit。短期 bootstrap token 只用于一次注册；长期 Runner 身份持久化后，Agent 原子清空配置中的 bootstrap token。

## 检查与日常操作

```bash
systemctl status autoforge-agent
journalctl -u autoforge-agent --since today
# 默认非特权模式
sudo -u autoforge-agent /opt/autoforge/bin/autoforge-agent doctor \
  --config /etc/autoforge-agent/config.json
# root 模式
/opt/autoforge/bin/autoforge-agent doctor --config /etc/autoforge-agent/config.json
systemctl restart autoforge-agent
```

停止时 Agent 先停止领取，在配置的 grace period 内排空在途 attempt；下次启动先读取身份、attempt 与 spool 并执行 reconcile。不要通过删除 `/var/lib/autoforge-agent` 处理未完成任务。

cgroup v2 可用时，每个 attempt 使用委派的 cgroup 与 rlimit 控制 CPU、内存、进程数和文件大小。没有 cgroup v2 时仍应用文件大小/打开文件数/core dump rlimit、进程组清理、执行超时和工作目录字节/条目监督，但 CPU、内存和整个后代进程数量不具备同等级硬限制。扫描仍有一个采样周期的瞬时超写窗口；严格防止共享磁盘耗尽时，应为 `/var/lib/autoforge-agent/work` 使用独立限额文件系统或项目配额。

## 升级、回滚与注销

平台版本升级后，在执行机页面重新执行探测、指纹确认和安装即可使用同镜像内的 Agent。脚本保留当前文件直到新服务成功启动；启动失败自动回滚。控制面不兼容的旧版本不会获得 assignment。

注销前先在平台排空 Runner，确认没有在途 attempt 和待确认 spool，再执行：

```bash
systemctl disable --now autoforge-agent
rm -f /etc/systemd/system/autoforge-agent.service
systemctl daemon-reload
```

随后在平台撤销/注销 Runner 身份。默认保留 `/var/lib/autoforge-agent` 供审计和恢复；只有确认无保留要求后才删除状态、配置、工具链和专用账号。
