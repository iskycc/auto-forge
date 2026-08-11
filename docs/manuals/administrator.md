# 管理员手册

## 部署与首次初始化

AutoForge 只接受 `--data-dir` 启动参数。首次启动会创建权限为 `0600` 的
`config/platform.json` 与一次性 `config/initial-admin-token`；应用配置不从环境变量读取。
访问 `/setup` 选择 Lite 或填写 Full 内部基础设施地址，保存后重启，再用一次性令牌创建首位
系统管理员。Lite 只使用 SQLite、本地对象目录、SQLite 队列和进程内工作器；Full 使用
PostgreSQL、JetStream、MinIO 与 Redis，但领域/API/UI 语义相同。

## 身份、LDAP 与权限

在“系统设置 → 访问控制”创建本地用户、项目、成员和自定义角色。转移项目负责人、禁用用户、
撤销会话或修改高风险角色前，页面会显示影响范围并要求确认。服务账号与 API 令牌独立于用户
会话和 Runner 身份；令牌只在签发时显示一次，数据库只保存摘要、作用域和过期时间。

LDAP 在“系统设置 → LDAP”中配置。服务器、Base DN、过滤器、属性、分页上限、TLS/StartTLS
和私有 CA 都持久化；bind 密码加密且不回显。连接测试会区分 DNS、TLS、bind、过滤器、权限和
超时。目录失联时已有会话按期限继续，本地紧急管理员仍可登录；目录用户的新 LDAP 登录失败，
不会静默回退为同名本地账号。手动/计划同步的状态和摘要在页面可查。

## 密文、Runner 与终端

执行环境的普通变量固化为版本快照；密文只保存加密版本引用，Runner 持有效 lease 时才领取。
密文值不会出现在页面、导出、审计详情、日志或 spool 中。

在“执行机”填写目标 IP/主机名、SSH 用户和密码，先核对主机指纹，再安装内置 Agent。平台只
支持 Ubuntu/openSUSE；脚本不会执行 `apt`、`apt-get`、`zypper` 或联网下载。SSH 密码只在本次
请求内使用。Runner 支持排空、禁用、凭据轮换/撤销和注销。直连终端默认关闭，需独立权限、
短时票据和 Web 副本亲和；断开会清理远端进程组。

## 保留、诊断与指标

“系统设置 → 运维”分别配置执行、日志、产物、来源、分析、审计、会话和队列保留期，修改前
先查看记录数/字节影响预览。清理使用持久 lease、重试与死信；对象删除失败不会伪装成功。
诊断包只包含版本、脱敏配置摘要、依赖健康和有界近期错误。指标导出默认关闭，开启后
`/api/v1/metrics` 仍要求 `settings.read` 身份。

## 备份与恢复

Lite 与 Full 的一致备份、恢复、升级前检查和恢复后凭据轮换见
[备份恢复](../operations/backup-recovery.md)。不要执行 `docker compose down --volumes`。
恢复后必须轮换平台主密钥保护边界内的访问凭据、数据库/对象存储密码、LDAP bind 密码和所有
Runner/API 身份，并检查审计记录、对象摘要和 readiness。

故障处置与容量阈值见[容量与故障手册](../operations/capacity-incidents.md)。
