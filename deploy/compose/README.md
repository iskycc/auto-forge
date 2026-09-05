# Docker Compose 部署

本目录包含共享同一 AutoForge 后端镜像的以下部署方式：

- `lite/docker-compose.yml`：只启动 AutoForge，使用 SQLite、本地对象目录和进程内能力；
- `full/docker-compose.yml`：启动 AutoForge Web、独立 dispatcher worker、PostgreSQL、NATS JetStream、MinIO、Redis，以及一次性创建 MinIO bucket 的初始化任务。

- `distributed/`：多机器 Full，分离基础设施、平台节点和 Nginx；节点本地日志通过已认证的内部接口互访，详见[分布式部署说明](./distributed/README.md)。

## 准备离线镜像

从 GitHub Release 下载与宿主机架构匹配的 AutoForge 归档并校验 `SHA256SUMS`。示例中的 `VERSION` 替换为实际版本：

```bash
docker load --input autoforge-backend-VERSION-amd64.docker.tar
```

当前正式发布直接提供标准 Docker tar，不要求宿主机安装 `zstd`。仅升级早期仍使用
`.docker.tar.zst` 的历史版本时才需要先用 `zstd` 解压。

Full 模式还必须在联网环境按 `full/docker-compose.yml` 中的精确 tag 和 digest 拉取五个基础设施镜像，再用 `docker save` 导出并带入离线区。不要只保存可变 tag，也不要在离线区运行 `docker compose pull`。Compose 已设置 `pull_policy: never`，缺少镜像时会明确失败。

## 生成编排配置

选择模式后进入对应目录，并从示例生成 `.env`：

```bash
cp .env.example .env
```

将 `AUTOFORGE_BACKEND_IMAGE` 设置为导入 tar 后的同 variant 版本 tag，并使用签名
`SHA256SUMS` 与 `release-manifest.json#backendImages` 核对归档身份。不要把
`immutableImageId` 直接写入 Compose：
Docker classic 与 Docker 29 containerd image store 对本地 `.Id` 分别采用 OCI config digest 和
manifest digest，版本 tag 在已校验的离线归档中具有一致行为。`.env` 只保存镜像、宿主机端口、
卷和网络等 Compose 编排参数；AutoForge 不从环境变量读取应用配置。

Full 还需要为第三方 PostgreSQL/MinIO 创建 Docker secret 文件。以下命令使用已导入的 AutoForge 镜像内 Node.js 生成 URL-safe 随机值，不访问公网：

```bash
umask 077
mkdir -p secrets
printf '%s\n' autoforge >secrets/minio-root-user
docker run --rm --pull never "$AUTOFORGE_BACKEND_IMAGE" \
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" \
  >secrets/postgres-password
docker run --rm --pull never "$AUTOFORGE_BACKEND_IMAGE" \
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" \
  >secrets/minio-root-password
```

这些文件不得提交、复制到工单或写入日志。Full 平台配置中的 PostgreSQL URL 与 MinIO 凭据必须与 secret 文件内容一致，敏感字段由首次启动页面写入权限为 `0600` 的平台配置且不回显。

## 启动与检查

先做不启动容器的配置检查，再启动：

```bash
docker compose config --quiet
docker compose up --detach
docker compose ps
curl --fail http://127.0.0.1:3000/api/v1/health/ready
```

首次启动默认使用可独立运行的 Lite 配置，并在数据卷的 `config/initial-admin-token` 创建一次性令牌。访问 `/setup`：Lite 可直接创建管理员；Full 先在左侧“运行模式初始化”中填写 PostgreSQL、NATS、Redis 的内部地址（`postgres:5432`、`nats:4222`、`redis:6379`）、MinIO 地址和 secret 文件对应的凭据，保存后执行：

```bash
docker compose restart autoforge
docker compose --profile worker up --detach
```

重启后使用同一个一次性令牌创建 Full 数据库中的首位管理员。后续配置均在 `/settings/platform` 管理，Web 与 worker 共读 `autoforge-data` 卷中的 `platform.json`。

Full 的 `worker` 位于显式 `worker` profile，不暴露宿主机端口。Compose 通过容器内的 `/health/live` 与 `/health/ready` 检查其生命周期（readiness 覆盖 PostgreSQL、JetStream 和 MinIO bucket）。创建批次时 Web 在 PostgreSQL 同一事务写 outbox；worker 发布 JetStream 消息、持久化 assignment 后立即确认，不会在 Runner 执行期间持有队列确认。worker 同时消费 `object-cleanup` 消息，并从共享平台配置读取 MinIO 信息。

MinIO 地址还会用于生成 Runner 和浏览器直接上传产物的预签名 URL，因此必须同时能被
Web、worker、外部 Runner 和用户浏览器访问。不要把只在 `core` 网络内可解析的
`http://minio:9000` 当作最终生产地址；当前 Compose 不直接发布 MinIO 端口，应先通过企业
内网 TLS 代理暴露 S3 API，再把该共同可达地址写入平台配置。

成功创建管理员后，初始 token 文件会被消费。自动安装 Runner 时平台为每次安装签发短期一次性 bootstrap token，不需要管理员管理全局 Runner token。

升级时先校验和导入新镜像，修改 `.env` 中的 `AUTOFORGE_BACKEND_IMAGE`，再执行 `docker compose up --detach`。不要在未备份时运行 `docker compose down --volumes`；该命令会删除数据库、JAR、日志和基础设施持久卷。

上述 `lite/` 与 `full/` Compose 面向单机部署；多机器使用 `distributed/`。Full 模式不会把 PostgreSQL、NATS、Redis 或 MinIO 端口暴露给宿主机；只有 AutoForge HTTP 端口通过 edge 网络发布。生产环境仍应在其前方配置企业内网 TLS 反向代理。
