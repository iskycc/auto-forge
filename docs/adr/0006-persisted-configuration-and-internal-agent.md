# ADR 0006：持久化平台配置与内置 Agent 安装

- 状态：Accepted；cgroup/root 安装策略由 [ADR 0007](./0007-trusted-runner-deployment-options.md) 修订；连接档案持久化由 2026-08-21 产品决策修订
- 日期：2026-08-11

## 背景

早期实现通过 `AUTOFORGE_*` 环境变量配置 Web、worker 和 Full 基础设施，并把 Runner Agent 作为独立 GitHub Release 资产交付。这使离线部署需要同时管理多组秘密、四套 Agent 变体和人工服务安装步骤，也无法从管理后台审计配置变更。

产品现在要求主平台默认可独立启动，运行配置由首次启动生成并在后台管理；Runner Agent 作为 Forge 内部资源，由管理员填写执行机连接信息后自动安装。目标执行机为 Ubuntu 或 openSUSE，安装期不得通过系统包管理器获取依赖。

## 决策

1. 主平台只接受 `--data-dir` 进程参数作为安装级定位信息。应用配置保存于 `<data-dir>/config/platform.json`，目录权限为 `0700`、文件权限为 `0600`，使用 schema version、revision 和同文件系统原子替换。
2. 首次启动默认生成可单独运行的 Lite 配置、主密钥和不同用途的随机令牌。首位管理员令牌单独写入 `initial-admin-token`，创建管理员后删除。Web 与 Full worker 读取同一配置文件；后台修改配置后必须重启组合根。
3. Full 基础设施地址和凭据通过后台平台配置保存，敏感字段不回显；Docker Compose 不向 AutoForge 容器注入应用配置环境变量。第三方 PostgreSQL/MinIO 的启动凭据使用 Docker secret 文件。
4. 每个后端镜像内置 Linux `amd64`、`arm64` 两个 `CGO_ENABLED=0` Agent 和一个安装脚本。资源清单记录版本、revision、大小和 SHA-256；Web 读取和上传前校验，上传后经 SFTP 读回再次校验。
5. 自动安装分为探测和安装两步。探测使用 SSH 密码认证，返回操作系统、架构、systemd/cgroup v2 能力和 SSH 主机 SHA-256 指纹；管理员必须确认指纹，安装请求重连时强制匹配。首次安装或手动更新成功后，连接信息使用平台主密钥和 AES-256-GCM 持久化为带 AAD 的版本化档案，供重新安装和有界批量更新复用；密码与私有 CA 不通过 API 回显，也不写入审计或日志。
6. 安装器只支持 Ubuntu、openSUSE Leap/Tumbleweed 与 systemd/cgroup v2。目标机必须已有 POSIX shell、coreutils、systemd、SSH，以及非 root 用户场景下的 sudo；脚本不会安装依赖或访问公网。Agent 以专用非特权账户运行，systemd 提供保护与 cgroup 委派，失败时恢复上一版文件。
7. 安装使用 15 分钟签名 bootstrap token。服务端仓储以 token 摘要保证一次使用；Agent 保存长期身份后原子清除配置文件中的 bootstrap token。
8. GitHub Release 不再生成独立 Agent 二进制或 Agent SBOM。四个后端变体都携带两个 Agent 架构，后端镜像 SBOM覆盖这些文件，统一 Release 清单只列后端镜像和部署包。

## 影响

- 默认 Lite 不需要 PostgreSQL、NATS、MinIO、Redis 或应用环境变量，首次启动即可访问公开首页和初始化入口。
- 后端镜像增加约 15 MiB 的未压缩静态二进制，但安装资产与控制面协议版本天然一致，离线介质和升级路径更简单。
- 自动安装要求平台能连接目标机 SSH；Agent 正常运行仍只主动连接控制面，不依赖 SSH 保持在线。
- `platform.json` 包含加密主密钥与基础设施凭据，备份必须作为敏感数据保护。文件权限是本地静态保护边界，磁盘/备份加密仍由部署负责。
- 从旧环境变量部署升级时，必须先将值迁移到后台配置并验证重启；运行时不再读取旧变量。
