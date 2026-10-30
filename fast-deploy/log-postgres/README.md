# 独立日志 PostgreSQL：amd64 快速部署

本目录可独立复制到任意日志主机，也可放在三机 Full 方案的 C 主机。使用独立容器、独立密码及本地 `data/postgres/` 目录，与业务主库分开；默认端口 `5433`。不需要运行生成脚本或架构检测，不使用 Docker named volume。

## 启动

要求 Linux amd64、Docker Engine 和 Compose v2。复用[基础设施离线包](https://github.com/iskycc/auto-forge/releases/tag/v1.20.22-infra.20261027.1)中的 `autoforge-infra-postgres-15-alpine-amd64.docker.tar`；不需要另一种日志数据库镜像。校验离线包后，尚未导入此镜像的主机执行：

```bash
docker load -i autoforge-infra-postgres-15-alpine-amd64.docker.tar
```

把本目录放在日志数据盘，例如 `/srv/autoforge/log-postgres`，以 root 执行：

```bash
cd /srv/autoforge/log-postgres
cp .env.example .env
vi .env
mkdir -p data/postgres
chmod 600 .env
docker compose up -d
docker compose ps
```

`.env` 只需填写以下内容：

| 配置                    | 示例／要求                                                     |
| ----------------------- | -------------------------------------------------------------- |
| `SERVICE_BIND`          | 本机实际内网 IP，例如 `10.20.0.13`                             |
| `LOG_POSTGRES_PORT`     | 默认 `5433`；同主机多个实例使用不同端口                        |
| `LOG_POSTGRES_PASSWORD` | 独立的非空密码，建议至少 32 位；与业务 PostgreSQL 使用不同密码 |

密码显式传入容器的 `POSTGRES_PASSWORD`。未填写时 Compose 直接报出缺失字段，不会启动后反复重启，也不启用 `trust`。镜像使用 `pull_policy: never`，不会自动联网下载。若数据盘挂在 `/opt`，可直接将整个目录放到 `/opt/autoforge/log-postgres`，相对挂载随目录落在该盘。

## 平台填写

首次 Full 初始化可直接在“PostgreSQL 日志库”分区填写；已经运行的平台进入 **平台设置 → 日志数据库 → 添加日志服务器**：

| 字段         | 填写内容                                                |
| ------------ | ------------------------------------------------------- |
| 名称         | 日志服务器 01（平台设置登记时填写）                     |
| IP／主机名   | 本机 `SERVICE_BIND`，例如 `10.20.0.13`                  |
| 端口         | `LOG_POSTGRES_PORT`，默认 `5433`                        |
| 管理员用户名 | `autoforge_logs`                                        |
| 管理员密码   | `.env` 中的 `LOG_POSTGRES_PASSWORD` 原文，无需 URL 编码 |
| 维护数据库   | `postgres`                                              |
| 每日库名前缀 | `autoforge_logs`                                        |
| SSL 模式     | 不启用 SSL（本模板为内网直连）                          |

镜像首次初始化的 `autoforge_logs` 账号具备建库权限。`postgres` 仅用于维护连接，日志正文由平台自动写入按北京时间日期创建的独立数据库。不要将业务主库地址和库名填到日志库中。

首次引导中点击“检查连接”，保存后重启平台即可首次启用。已经运行的平台登记后点击“检查连接”和“设为写入库”，切换即时生效，无需重启；在途批次和历史日志保持原有路由，不自动搬迁或清空。

仅平台 Web／worker 主机需要访问日志端口，浏览器与 Runner 不直连此库。多节点 Full 要保证所有平台节点都能访问。

## 多实例、密码与备份

增加另一套日志服务时复制本目录到另一数据目录，修改端口和密码，并始终使用不同 Compose 项目名，例如 `docker compose -p autoforge-log-02 up -d`；查看、停止等后续命令使用同一项目名。不要让两个实例共享 `data/postgres/`。

已有数据库的密码不会因修改 `.env` 而改变。修改账号密码时先在数据库中完成轮换，再在平台原日志服务器卡片更新连接；不要删除数据目录来重置密码。备份需覆盖业务库、所有日志日期库、平台配置与主密钥、MinIO 以及旧本地日志；原始日志数据目录冷备前先停止本 PostgreSQL 容器。
