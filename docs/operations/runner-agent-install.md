# Runner Agent 自动安装与运维

Runner Agent 是主平台的内部资源，不再从 GitHub Release 单独下载。每个后端镜像包含 Linux `amd64`、`arm64` 两个 `CGO_ENABLED=0` 静态二进制、受控安装脚本和带 SHA-256 的版本化资源清单。

安装后的身份由 Agent 私有保存。管理员可在执行机页面请求无明文回传的凭据轮换；Agent 在下一次
心跳完成交换并原子写盘，旧凭据保留 15 分钟宽限。轮换未完成会在页面显示“等待轮换”，应先检查
Agent 诊断日志和数据盘空间，不要直接删除身份文件。

## 支持范围

自动安装支持：

- Ubuntu、openSUSE Leap、openSUSE Tumbleweed；
- Linux `amd64` 或 `arm64`；
- systemd 与 cgroup v2；
- root SSH 用户，或能用同一密码执行 sudo 的普通用户。

目标机必须已有 SSH Server、POSIX shell、`install`/`cp`/`mv`/`id` 等基础系统命令、systemd；普通用户场景必须已有 sudo。安装脚本不会调用系统包管理器，不会下载或安装任何依赖。Java、TestNG、浏览器和驱动等执行工具链仍需由管理员在离线介质中预置。

## 安装

1. 在“平台配置”设置执行机能够访问的 HTTPS 地址；私有 PKI 场景准备 PEM CA 链。保存后重启 Web/worker。
2. 进入“执行机”，填写 IP/主机名、SSH 端口、用户名和密码，点击“探测并核验主机”。
3. 平台通过 SSH 读取 `/etc/os-release`、架构、systemd/cgroup v2 和提权能力，并显示 SSH 主机密钥 SHA-256 指纹。通过独立可信渠道核对后勾选确认。
4. 设置 Runner 名称、标签、并发和终端策略；私有 CA 场景粘贴 PEM，然后执行安装。

安装请求会再次强制匹配已确认指纹。平台读取内置资源时校验清单，SFTP 上传后读回并复核大小/SHA-256，再以固定参数执行脚本。SSH/sudo 密码只存在于请求内存，不写数据库、平台配置、审计或日志。

脚本创建专用 `autoforge-agent` 系统账号并安装：

```text
/opt/autoforge/bin/autoforge-agent
/etc/autoforge-agent/config.json
/etc/autoforge-agent/control-plane-ca.pem  # 仅私有 CA
/etc/systemd/system/autoforge-agent.service
/var/lib/autoforge-agent/
```

systemd 服务以非 root 账号运行，启用 `NoNewPrivileges`、只读系统目录、私有临时目录、任务数上限和 cgroup 委派。安装失败会恢复上一版二进制、配置和 unit。短期 bootstrap token 只用于一次注册；长期 Runner 身份持久化后，Agent 原子清空配置中的 bootstrap token。

## 检查与日常操作

```bash
systemctl status autoforge-agent
journalctl -u autoforge-agent --since today
sudo -u autoforge-agent /opt/autoforge/bin/autoforge-agent doctor \
  --config /etc/autoforge-agent/config.json
systemctl restart autoforge-agent
```

停止时 Agent 先停止领取，在配置的 grace period 内排空在途 attempt；下次启动先读取身份、attempt 与 spool 并执行 reconcile。不要通过删除 `/var/lib/autoforge-agent` 处理未完成任务。

每个 attempt 使用委派的 cgroup v2 与 rlimit 控制 CPU、内存、进程数和文件大小，并监督工作目录字节/条目上限。扫描仍有一个采样周期的瞬时超写窗口；严格防止共享磁盘耗尽时，应为 `/var/lib/autoforge-agent/work` 使用独立限额文件系统或项目配额。

## 升级、回滚与注销

平台版本升级后，在执行机页面重新执行探测、指纹确认和安装即可使用同镜像内的 Agent。脚本保留当前文件直到新服务成功启动；启动失败自动回滚。控制面不兼容的旧版本不会获得 assignment。

注销前先在平台排空 Runner，确认没有在途 attempt 和待确认 spool，再执行：

```bash
systemctl disable --now autoforge-agent
rm -f /etc/systemd/system/autoforge-agent.service
systemctl daemon-reload
```

随后在平台撤销/注销 Runner 身份。默认保留 `/var/lib/autoforge-agent` 供审计和恢复；只有确认无保留要求后才删除状态、配置、工具链和专用账号。
