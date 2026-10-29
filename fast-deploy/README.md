# 三台主机快速部署 Full（无 Nginx）

只修改一份 `.env` 的三个 IP 和平台版本，生成三份可直接分发的目录。密码自动生成且三机配置一致；不需要拼接多个 Compose 文件，也不需要逐项在页面填写数据库连接。

| 主机 | 组件                                           | 对外端口                      |
| ---- | ---------------------------------------------- | ----------------------------- |
| A    | Web、独立 dispatcher worker                    | `3000`                        |
| B    | 业务 PostgreSQL、Redis                         | `5432`、`6379`，仅允许 A 访问 |
| C    | MinIO、NATS JetStream；可选独立日志 PostgreSQL | `9000`、`4222`；日志库 `5433` |

执行机 Runner 单独部署。所有持久数据位于各主机目录下的 `data/`，使用本地 bind mount，没有 Docker named volume。Web 与 worker 共用 A 的 `data/platform/`；三台主机使用独立容器网络，通过实际 IP 通信。本方案没有主机故障自动切换。

## 1. 准备镜像

要求 Linux、Bash、Docker Engine 和支持 `up --wait` 的 Docker Compose v2.20+。准备机 A 不需要安装 Node、Go 或 pnpm。以下以 **x86_64、v1.21.4** 为例；先校验下载包的签名／SHA-256，再 `docker load --input 文件名`。启动设置 `pull_policy: never`，不会自动联网拉取。

| 导入位置 | 所需离线包                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A        | `autoforge-backend-1.21.4-amd64.docker.tar`                                                                                                                                                                    |
| B        | `autoforge-infra-postgres-15-alpine-amd64.docker.tar`、`autoforge-infra-redis-7-alpine-amd64.docker.tar`                                                                                                       |
| C        | `autoforge-infra-nats-2.14.3-alpine3.22-amd64.docker.tar`、`autoforge-infra-minio-RELEASE.2025-04-22T22-12-26Z-amd64.docker.tar`、`autoforge-infra-minio-client-RELEASE.2025-04-16T18-13-26Z-amd64.docker.tar` |

主平台来自[正式 Release](https://github.com/iskycc/auto-forge/releases/tag/v1.21.4)，基础设施包来自[amd64 临时离线包](https://github.com/iskycc/auto-forge/releases/tag/v1.20.22-infra.20261027.1)。C 启用日志库时还需导入同一 PostgreSQL 包。MinIO Client 只运行一次完成 bucket 初始化，随后退出。

这里直接使用临时包导入后的 `autoforge/offline-*` tag，不再要求另找 `compose.offline.yml`。采用自行准备的镜像时，在顶层 `.env` 中覆盖 `POSTGRES_IMAGE`、`REDIS_IMAGE`、`NATS_IMAGE`、`MINIO_IMAGE`、`MINIO_CLIENT_IMAGE`；必须使用经过校验的固定版本或 digest，不用 `latest`。`ARCH=arm64` 只选择镜像架构，不会下载镜像；上述临时包只有 amd64，arm64 基础设施镜像须另行准备。

## 2. 在 A 一次生成三机配置

从仓库取得整个 `fast-deploy/`，或解压新部署包中的同名目录。在 A 以 root 执行：

```bash
cd /opt/auto-forge/fast-deploy
cp .env.example .env
vi .env
```

主要填写这几项，IP 必须是对应主机实际拥有、可互访的内网 IPv4 地址：

```dotenv
NODE_A_IP=10.20.0.11
NODE_B_IP=10.20.0.12
NODE_C_IP=10.20.0.13
AUTOFORGE_VERSION=1.21.4
ARCH=amd64
```

其余端口默认无需修改。然后生成：

```bash
bash prepare.sh
```

准备过程复用已加载的后端镜像内置 Node，禁用容器网络，只生成本地文件：

```text
generated/
├── node-a/   # .env、Compose、部署脚本、setup-values.json
├── node-b/   # .env、Compose、部署脚本、PostgreSQL/Redis 私有凭据
└── node-c/   # .env、Compose、部署脚本、MinIO/NATS/日志库私有凭据
```

生成器拒绝覆盖已存在的 `generated/`，避免重新生成密码后与已初始化的数据库不一致。不要在 B、C 分别生成密码。生成目录包含私有凭据，文件权限 `0600`；通过受控方式传输并备份，不提交 Git。准备机目录不会进入发布包。

请保留准备时的 `.env` 和 `generated/`。需要调整 CPU／内存限制时，在生成的 A `.env` 中设置 `WEB_CPUS`、`WEB_MEMORY_LIMIT`、`WORKER_CPUS`、`WORKER_MEMORY_LIMIT`；默认 `0` 表示不额外限制，仍需为基础设施与系统预留资源。

## 3. 分发目录

例如将三份目录分别放到各主机的数据盘 `/srv/autoforge/`：

```bash
# 在 A 执行；先确认目标目录没有已有部署文件
install -d -m 0700 /srv/autoforge
cp -a generated/node-a /srv/autoforge/
ssh root@10.20.0.12 'install -d -m 0700 /srv/autoforge'
ssh root@10.20.0.13 'install -d -m 0700 /srv/autoforge'
scp -pr generated/node-b root@10.20.0.12:/srv/autoforge/
scp -pr generated/node-c root@10.20.0.13:/srv/autoforge/
```

不使用 root SSH 时，通过已有的运维账号传输，再在目标机 `sudo` 放到该目录。数据实际保存在 `/srv/autoforge/node-*/data/`。如使用 `/data` 等独立数据盘，直接把对应的整个 `node-*` 目录放到该盘即可，Compose 路径无需改动。SELinux 主机需按本地策略允许容器访问绑定目录。

## 4. 先启动 B、C，再启动 A

**B：**

```bash
cd /srv/autoforge/node-b
sudo bash deploy.sh up
```

**C：**

```bash
cd /srv/autoforge/node-c
sudo bash deploy.sh up
```

脚本先检查密码非空、Compose 和本地镜像，再创建目录并等待健康。C 自动运行 MinIO Client 创建 `autoforge-objects` bucket，重复执行不会清空现有对象。

**A：**

```bash
cd /srv/autoforge/node-a
sudo bash deploy.sh full
```

此命令先启动 Web 生成平台自身密钥，然后携带初始令牌调用平台现有的首次配置 API，写入生成的 Full 连接信息；随后重启 Web，确认健康后启动独立 worker。配置通过原有权限和 schema 校验，不直接改写 `platform.json`。不需要逐项手工填写密码。

最后在 A 的安全终端读取初始令牌：

```bash
sudo cat data/platform/config/initial-admin-token
```

浏览器访问 `http://10.20.0.11:3000/setup`，用此令牌创建 **Full 的首位管理员**。不要在自动配置前先创建 Lite 管理员；已有业务的 Lite／Full 部署应使用迁移流程，本脚本不迁移数据库。自动配置中断后可再次执行 `deploy.sh full`；已经配置同一 Full 数据库时不会更换密码或平台主密钥。

### 手工配置备用入口

需要手工初始化时，在 A 执行 `sudo bash deploy.sh up`，在安全终端查看 `setup-values.json`，将 `full` 内各项和两个平台地址填入 `/setup` 的“运行模式初始化”。该文件包含密码，不要粘贴到聊天、工单或公开日志。保存后：

```bash
sudo docker compose restart web
sudo docker compose up --detach --wait --wait-timeout 180 web
sudo bash deploy.sh worker
```

## 5. 可选：在 C 启动独立日志 PostgreSQL

```bash
cd /srv/autoforge/node-c
sudo bash deploy.sh log-database
```

在“平台设置 → 日志数据库 → 添加日志服务器”中，使用 A 的 `setup-values.json` 内 `optionalLogDatabase`：C 的 IP、`5433`、管理员 `autoforge_logs`、独立密码、维护库 `postgres`、前缀 `autoforge_logs`。检查连接后设为写入服务器。日志库按北京时间日期自动建库，与 B 的业务数据库分开；此步骤不会搬迁原有日志。只允许 A 访问该端口。

## 6. 检查、启停与升级

在相应主机目录执行：

```bash
sudo bash deploy.sh check    # 配置、密码和镜像检查，不启动容器
sudo bash deploy.sh status   # 查看所有容器
sudo bash deploy.sh logs     # 查看最近日志
sudo bash deploy.sh stop     # 停止本机组件，保留数据
```

各组件仍可独立操作，例如 B 的 `sudo docker compose restart postgres`，A 的 `sudo docker compose --profile worker stop worker`。正常重启已配置的 A 时依次执行 `sudo bash deploy.sh up`、`sudo bash deploy.sh worker`。

平台健康检查：`curl --fail http://10.20.0.11:3000/api/v1/health/ready`；MinIO：`curl --fail http://10.20.0.13:9000/minio/health/live`。用户浏览器、Jenkins 和 Runner 需要能访问 A:3000；A 访问 B:5432/6379、C:4222/9000；Runner／浏览器还需访问 C:9000 进行预签名对象上传下载。NATS 8222、MinIO 9001 和 worker 3001 不对宿主机开放。

部署后注册一个 Runner，执行普通与 DDT 小任务，检查日志、产物、公开链接与实时刷新。三机可靠校时。本方案用于受控内网 HTTP；已有企业 HTTPS 入口时配置 `PUBLIC_BASE_URL`、`RUNNER_BASE_URL`，并确保 MinIO endpoint 也使用浏览器和执行机可达的 HTTPS 地址。

升级先备份并停止 A 的 Web／worker，加载同一新版本镜像，只修改 A `.env` 的 `BACKEND_IMAGE`，启动 Web 完成迁移后再启动 worker；不重新生成凭据。备份覆盖 B 业务库、C 的 MinIO／可选日志库、A 的完整 `data/platform/` 以及三机私有凭据。在一致停写窗口生成备份，冷拷贝数据库目录前停止对应容器。

## PostgreSQL 报“superuser password is not specified”怎么办

这是**初始化进程没有读到非空超级用户密码**。仅在宿主机 `.env` 写 `POSTGRES_PASSWORD` 并不会自动传给容器，必须有 `environment` 或 `_FILE` 映射。

本套通过 `POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password` 和 Compose secret 显式挂载 `node-b/secrets/postgres-password`。部署脚本和容器入口都会提前检查，文件缺失／空白时直接指出路径；不会使用 `trust` 绕过认证。

```bash
cd /srv/autoforge/node-b
sudo bash deploy.sh check
sudo test -s secrets/postgres-password
sudo docker compose up --detach --force-recreate --wait postgres
```

`test -s` 只检查文件，不打印密码。丢失凭据时从最初生成的目录或备份恢复；**已初始化数据库不能通过修改文件重置密码**，需要由数据库管理员执行密码轮换。也不要为修复初始化报错删除已有数据目录。

若以前用了别的 Compose，应先在其原目录停止旧容器，确认端口未占用，再启动本方案。旧数据／用户／密码不能直接当作本套新安装使用；先备份，再按迁移或恢复方案操作。

## 本地验证范围

2026-10-29 使用正式 v1.21.4 amd64 后端及上述离线基础设施镜像，在同一测试主机的三组独立 Docker 网络／端口中完成启动：PostgreSQL、Redis、NATS、MinIO、可选日志库、Web 和 worker 全部健康。通过真实初始化 API 写入 Full 配置、创建管理员和项目，并核对业务 PostgreSQL 落库；重建数据库／缓存容器、重启平台后，原项目和会话仍有效。空密码同时由脚本和实际容器入口拒绝。

`node --test scripts/operations/fast-deploy.test.mjs scripts/release/build-deployment-bundle.test.mjs scripts/release/release-workflow.test.mjs` 的 18 项测试、三份 Compose 解析、Shell 语法、ESLint、格式和许可证检查通过。实际解压本地部署包，用其脚本在断网容器内生成配置，三机预检通过。没有重新构建产品镜像，也没有以单机测试替代三台物理主机的网络、防火墙及真实 Runner 容量验收；目标环境仍需完成前述小任务闭环。
