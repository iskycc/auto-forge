# 三机 Full 快速部署：amd64，直接使用 Docker Compose

**复制对应主机目录，改 `.env`，创建本地数据目录，`docker compose up -d`。** 镜像全部固定为 amd64，不需要运行配置生成器、部署程序或架构检测。

| 主机            | 复制目录  | 组件              |
| --------------- | --------- | ----------------- |
| A：`10.20.0.11` | `node-a/` | Web、worker       |
| B：`10.20.0.12` | `node-b/` | PostgreSQL、Redis |
| C：`10.20.0.13` | `node-c/` | MinIO、NATS       |

独立日志库另提供 [`log-postgres/`](./log-postgres/README.md)，复制到 C 或专用日志主机即可单独启动；默认端口 `5433`，无需脚本或额外镜像类型。

示例 IP 替换成实际内网 IP；Runner 使用已有独立执行机。不使用 Nginx，也不使用 Docker named volume。持久数据就在各自目录的 `data/` 下，可以把整个目录放到实际数据盘。

## 镜像先导入对应主机

要求 Linux amd64、Docker Engine 和 Docker Compose v2。校验离线包签名／SHA-256 后，用 `docker load -i 文件名` 导入：

| 主机 | Docker tar 文件                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `autoforge-backend-1.21.9-amd64.docker.tar`                                                                                                                                                                    |
| B    | `autoforge-infra-postgres-15-alpine-amd64.docker.tar`、`autoforge-infra-redis-7-alpine-amd64.docker.tar`                                                                                                       |
| C    | `autoforge-infra-minio-RELEASE.2025-04-22T22-12-26Z-amd64.docker.tar`、`autoforge-infra-minio-client-RELEASE.2025-04-16T18-13-26Z-amd64.docker.tar`、`autoforge-infra-nats-2.14.3-alpine3.22-amd64.docker.tar` |

主平台来自[正式 v1.21.9](https://github.com/iskycc/auto-forge/releases/tag/v1.21.9)，基础设施来自[amd64 离线包](https://github.com/iskycc/auto-forge/releases/tag/v1.20.22-infra.20261027.1)。Compose 已填写这些包导入后的镜像名，不需要覆盖文件；不会自动联网拉取。

## B：数据库与缓存

把 `node-b/` 放到 B 的数据盘，例如 `/srv/autoforge/node-b`，以 root 执行：

```bash
cd /srv/autoforge/node-b
cp .env.example .env
vi .env
mkdir -p data/postgres data/redis
chmod 600 .env
docker compose up -d
```

`.env` 只需修改 `SERVICE_BIND` 为 B 的 IP，填写 `POSTGRES_PASSWORD`、`REDIS_PASSWORD`。密码必须非空，建议各用不同的至少 32 位密码；平台引导页使用独立密码字段，不需要手工拼接连接 URL。

**PostgreSQL 的密码已由 `environment.POSTGRES_PASSWORD` 显式传入容器。** 未填写时 Compose 会立即指出缺失字段，不会等到数据库反复重启，也不会使用 `trust` 绕过认证。

## C：对象存储与消息

把 `node-c/` 放到 C，例如 `/srv/autoforge/node-c`：

```bash
cd /srv/autoforge/node-c
cp .env.example .env
vi .env
mkdir -p data/minio data/nats
chmod 600 .env
docker compose up -d
```

修改 `SERVICE_BIND` 为 C 的 IP，填写 `NATS_TOKEN`、`MINIO_ROOT_PASSWORD`；`MINIO_ROOT_USER` 默认保留 `autoforge`。同样建议使用不同的至少 32 位字母、数字与连字符组合。

`minio-init` 随 Compose 自动创建 `autoforge-objects` bucket，成功后退出 `0`，不是常驻服务；重复启动不会清空 bucket。保留 MinIO Client 镜像即可，无需单独运行初始化命令。

## A：平台

把 `node-a/` 放到 A，例如 `/srv/autoforge/node-a`：

```bash
cd /srv/autoforge/node-a
cp .env.example .env
vi .env
install -d -o 1000 -g 1000 -m 0700 data/platform
docker compose up -d
cat data/platform/config/initial-admin-token
```

`.env` 只修改 `SERVICE_BIND` 为 A 的 IP；默认端口 `3000`。平台以 UID `1000` 运行，创建目录时的属主不能省略。

首次打开 `http://10.20.0.11:3000/setup`，使用刚读取的令牌，在“运行模式初始化”选择 **Full**，填写：

| 页面配置                  | 填入内容                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 主库           | IP `10.20.0.12`、端口 `5432`、数据库 `autoforge`、用户名 `autoforge`、密码填 B 的 `POSTGRES_PASSWORD`                                                            |
| PostgreSQL 日志库         | 独立部署后，按 [`log-postgres` 说明](./log-postgres/README.md#平台填写)填写；Full 必须先部署并填写此服务                                                         |
| Redis 缓存                | IP `10.20.0.12`、端口 `6379`、逻辑库 `0`、用户名留空、密码填 B 的 `REDIS_PASSWORD`                                                                               |
| NATS 消息队列             | IP `10.20.0.13`、端口 `4222`、Token 填 C 的 `NATS_TOKEN`                                                                                                         |
| MinIO 对象存储            | IP `10.20.0.13`、API 端口 `9000`、Access Key 填 C 的 `MINIO_ROOT_USER`、Secret Key 填 C 的 `MINIO_ROOT_PASSWORD`、Bucket `autoforge-objects`、Region `us-east-1` |
| 平台外部地址、Runner 地址 | 均为 `http://10.20.0.11:3000`                                                                                                                                    |

v1.21.7 起各组件分区填 IP、端口与凭据，密码按原文填写，无需 URL 编码。此部署未配置 TLS，各组件保留不启用 SSL／TLS；逐区点击“检查连接”确认配置。保留 Web 监听 `0.0.0.0:3000`、worker 健康端口 `3001`。

保存后在 A 执行：

```bash
docker compose restart web
docker compose --profile worker up -d
```

回到 `/setup`，使用同一初始令牌创建 Full 的首位管理员。**先配置 Full、再启动 worker、创建管理员。** 这一步是平台首次安装配置，以后无需重复。

## 状态与后续启停

```bash
docker compose ps -a
docker compose logs --tail 100
docker compose stop
```

再次启动 B、C 用 `docker compose up -d`；A 用 `docker compose --profile worker up -d`。平台就绪地址为 `http://A的IP:3000/api/v1/health/ready`，返回的 `mode` 应为 `full`。

网络放通：用户／Jenkins／Runner 到 A:3000；A 到 B:5432/6379、C:4222/9000；浏览器／Runner 到 C:9000。基础设施端口限制来源，三台主机保持校时。部署后执行一个小任务，检查日志和产物上传下载。

`.env` 包含基础设施密码，应私有保存；不要提交 Git，也不要把包含密码的 `docker compose config` 输出发到公共渠道。数据库已经初始化后，修改 `.env` 不会重置数据库里的密码；不能通过删除数据目录修复密码问题。已有脚本版生成的部署继续保留其凭据和数据，不直接用新的空模板覆盖。

需要独立 PostgreSQL 日志库时，直接复制 [`log-postgres/`](./log-postgres/README.md) 到 C 或日志主机，仍是改 `.env`、建数据目录后 `docker compose up -d`，无需运行脚本。平台 Web／worker 到日志主机的默认 `5433` 端口也需放通；已有 Full 未配置时仍可启动并登录，但必须选择 PostgreSQL 日志服务器后才能执行用例。升级时同步切换 A 的 Web／worker 镜像，先备份业务库、所有日志库、MinIO 和平台完整数据目录。
