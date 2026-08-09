# Docker Compose 部署

本目录包含共享同一 AutoForge 后端镜像的两种部署方式：

- `lite/docker-compose.yml`：只启动 AutoForge，使用 SQLite、本地对象目录和进程内能力；
- `full/docker-compose.yml`：启动 AutoForge、PostgreSQL、NATS JetStream、MinIO、Redis，以及一次性创建 MinIO bucket 的初始化任务。

## 准备离线镜像

从 GitHub Release 下载与宿主机架构匹配的 AutoForge 归档并校验 `SHA256SUMS`。示例中的 `VERSION` 替换为实际版本：

```bash
zstd --decompress --stdout autoforge-backend-VERSION-amd64.docker.tar.zst | docker load
```

Full 模式还必须在联网环境按 `full/docker-compose.yml` 中的精确 tag 和 digest 拉取五个基础设施镜像，再用 `docker save` 导出并带入离线区。不要只保存可变 tag，也不要在离线区运行 `docker compose pull`。Compose 已设置 `pull_policy: never`，缺少镜像时会明确失败。

## 生成部署配置

选择模式后进入对应目录，并从示例生成 `.env`：

```bash
cp .env.example .env
```

将 `AUTOFORGE_BACKEND_IMAGE` 中的 `VERSION` 和 variant 改为已导入镜像的标签。所有 `replace-with-*` 必须替换为独立随机值，不能沿用示例值。可以在离线主机生成：

```bash
openssl rand -hex 32
openssl rand -base64 32
```

前三类 token 和 PostgreSQL/MinIO 密码可使用独立的 `openssl rand -hex 32` 结果；`AUTOFORGE_MASTER_KEY` 必须使用 `openssl rand -base64 32` 的结果。`.env` 含有凭据，不应提交、复制到工单或写入日志。

## 启动与检查

先做不启动容器的配置检查，再启动：

```bash
docker compose config --quiet
docker compose up --detach
docker compose ps
curl --fail http://127.0.0.1:3000/api/v1/health/ready
```

首次管理员引导入口是 `/setup`。成功创建管理员后，引导 token 会被消费；Runner bootstrap token 同样只允许成功注册一台执行机。

升级时先校验和导入新镜像，修改 `.env` 中的 `AUTOFORGE_BACKEND_IMAGE`，再执行 `docker compose up --detach`。不要在未备份时运行 `docker compose down --volumes`；该命令会删除数据库、JAR、日志和基础设施持久卷。

当前 Compose 面向单机部署。Full 模式不会把 PostgreSQL、NATS、Redis 或 MinIO 端口暴露给宿主机；只有 AutoForge HTTP 端口通过 edge 网络发布。生产环境仍应在其前方配置企业内网 TLS 反向代理。
