# Full 分主机部署：本地目录绑定

PostgreSQL、Redis、NATS、MinIO、平台和 Nginx 分别提供独立 Compose，复制到各自的主机启动。
所有持久数据使用 `type: bind`，不声明 Docker named volume；不存在的源目录会直接报错，
避免 Docker 自动创建 root 属主目录或把路径拼错后写入其他位置。

本套默认是一台平台主机和四台基础设施主机，另有一台可选的 Nginx 入口主机。
Web 与 dispatcher worker 是两个独立容器，同属一个平台节点，共享该主机的本地数据目录。
每个组件都可独立启停。此处的“分主机”不代表 PostgreSQL、MinIO 等组件已配置多副本或自动高可用。

只有三台主机且不使用 Nginx 时，采用[三主机直连方案](./three-hosts/README.md)：
A 运行 Web／worker，B 运行 PostgreSQL／Redis，C 运行 MinIO／NATS，复用本套独立组件模板。

Full 还可使用[独立 PostgreSQL 日志库](./log-postgres/README.md)，通过平台设置登记多个库、实时切换新批次写入库；
每个批次的存储位置持久化，旧日志仍从原库／原节点读取。

## 主机与目录规划

以下 IP 均需替换为实际地址；可以调整端口，各主机的数据目录也可单独改到 `/data` 等实际数据盘。

| 主机 | 示例 IP | 模板目录 | 宿主机持久目录 | 允许访问的端口 |
| --- | --- | --- | --- | --- |
| 平台 Web / worker | `10.20.0.11` | `platform/` | `/srv/autoforge/platform` | `3000`，供 Nginx／运维访问 |
| PostgreSQL | `10.20.0.21` | `postgres/` | `/srv/autoforge/postgres` | `5432`，供平台访问 |
| Redis | `10.20.0.22` | `redis/` | `/srv/autoforge/redis` | `6379`，供平台访问 |
| NATS JetStream | `10.20.0.23` | `nats/` | `/srv/autoforge/nats` | `4222`，供平台访问 |
| MinIO | `10.20.0.24` | `minio/` | `/srv/autoforge/minio` | `9000`，供平台、Runner 和浏览器访问 |
| Nginx（可选） | `10.20.0.10` | `nginx/` | 本目录的 `nginx.conf` 只读绑定 | `80`，浏览器／Runner 入口 |

容器端口与宿主机端口可以不同。`.env` 中的 bind 地址必须是**当前主机实际拥有的 IP**，
不能填写其他主机地址。不同主机通过上述 IP／DNS 互访，不依赖 Docker 跨主机服务名解析或共享网络。

## 1. 准备离线镜像

校验 Release 签名和 `SHA256SUMS` 后，在平台主机导入与 CPU 架构匹配的镜像，例如：

```bash
docker load --input autoforge-backend-1.20.24-amd64.docker.tar
```

将 `platform/.env.example` 复制为 `.env`，把镜像中的 `VERSION` 改为实际版本；arm64 主机改用
同一 Release 的 `-arm64` 镜像。Release 部署包会自动填入其对应版本，源码模板仍使用 `VERSION`。

基础设施和 Nginx 镜像沿用仓库已锁定的 tag／SHA-256。先在联网准备机按各 Compose 中的
完整镜像引用获取，再用 `docker save`／`docker load` 带入对应主机。
所有服务设置 `pull_policy: never`，启动时缺少镜像会失败，不会临时联网拉取。
支持这些固定 digest 的同架构离线镜像需在部署前准备齐全。

已有 [amd64 基础设施临时离线包](https://github.com/iskycc/auto-forge/releases/tag/v1.20.22-infra.20261027.1)，
包含上述六个第三方镜像、SHA-256 清单、SBOM 和 `autoforge-infra-compose-overrides-amd64.tar.gz`。
按主机角色下载对应镜像，校验并 `docker load` 后，将覆盖归档中该组件的 `compose.offline.yml`
放到本机组件目录。离线包使用已核验的本地架构 tag，避免 Docker 导入后缺少原 registry index digest。
启动、配置检查和后续启停均应叠加该覆盖文件，例如：

```bash
docker compose --file docker-compose.yml --file compose.offline.yml config --quiet
docker compose --file docker-compose.yml --file compose.offline.yml up --detach
```

此覆盖只改变基础设施镜像引用，不改变本地目录、端口或认证。平台主机不使用这些覆盖文件，
继续导入正式主平台镜像。其余章节的简写 `docker compose` 命令在使用该离线包时也需补齐两个 `--file`。

## 2. 生成并分发凭据

在安全准备机的 `full-bind/` 目录执行一次已有的凭据生成器：

```bash
umask 077
mkdir -p /secure/autoforge-bootstrap
node ../distributed/infrastructure/prepare-secrets.mjs /secure/autoforge-bootstrap/secrets
```

准备机未安装 Node.js 时，可使用已经导入的后端镜像离线生成：

```bash
umask 077
mkdir -p /secure/autoforge-bootstrap
docker run --rm --pull never --network none --user 0:0 \
  --mount "type=bind,source=$PWD/../distributed/infrastructure,target=/templates,readonly" \
  --mount type=bind,source=/secure/autoforge-bootstrap,target=/output \
  autoforge/backend:1.20.24-amd64 \
  node /templates/prepare-secrets.mjs /output/secrets
```

按实际版本和架构修改上面的镜像 tag。生成器拒绝覆盖已有凭据，不打印密码；
不要在各机器分别重新生成同一服务的凭据。按下表将文件安全传入对应主机的
`/srv/autoforge/secrets`，目录 `0700`，文件 `0600`，由 root 保管：

| 主机 | 需要的文件 |
| --- | --- |
| PostgreSQL | `postgres-password` |
| Redis | `redis.conf`、`redis-password` |
| NATS | `nats.conf` |
| MinIO | `minio-root-user`、`minio-root-password` |

准备机保留 `nats-token`、`redis-password`、PostgreSQL 和 MinIO 凭据供平台初始化填写。
平台主机不需要挂载其他组件的 secret 文件。Redis 配置已启用密码和 AOF，NATS 配置已启用
token 与 JetStream 磁盘存储。`.env` 只保存路径、镜像和绑定端口，不保存应用秘密。

## 3. 启动四台基础设施主机

每台机器只复制自己对应的组件目录，先执行 `cp .env.example .env`，修改本机 IP、端口和数据目录。
创建**对应的空数据目录**；例如各自在对应主机上执行：

```bash
# PostgreSQL 主机
sudo install -d -m 0700 /srv/autoforge/postgres
# Redis 主机
sudo install -d -m 0700 /srv/autoforge/redis
# NATS 主机
sudo install -d -m 0700 /srv/autoforge/nats
# MinIO 主机
sudo install -d -m 0700 /srv/autoforge/minio
```

路径调整后相应修改命令。不要把整个磁盘挂载根目录直接作为 PostgreSQL 数据目录，
应使用其下面的空子目录。PostgreSQL／Redis 使用镜像自带 entrypoint 初始化目录属主，
不要对平台目录套用数据库 UID，也不要使用 `chmod 777`。

在各自组件目录启动：

```bash
docker compose config --quiet
docker compose up --detach
docker compose ps --all
```

MinIO 的 `minio-init` 会等待本机 MinIO 健康后创建 `autoforge-objects` bucket，
成功应显示 `Exited (0)`，它不是需长期保持运行的服务。重复运行初始化不会删除 bucket 或对象：

MinIO 主机需要同时导入服务端与 MinIO Client（`mc`）镜像：前者长期提供 S3 存储，
后者只供 `minio-init` 执行一次性 bucket 初始化。平台日常读写通过 S3 API，不依赖常驻 Client 容器；
模板再次启动时仍可能运行初始化，因此离线主机应保留 Client 镜像。

```bash
docker compose logs minio-init
```

其他组件的健康检查在容器内完成。NATS `8222` 监控端口、MinIO `9001` 控制台和 worker
`3001` 健康端口均不对宿主机发布。

## 4. 初始化平台主机

在平台主机创建目录。官方后端以 UID/GID `1000:1000` 运行，绑定目录不会像新建 named volume
一样复制镜像内属主，因此这一步不能省略：

```bash
sudo install -d -o 1000 -g 1000 -m 0700 /srv/autoforge/platform
```

进入 `platform/`，执行 `cp .env.example .env`，修改 IP、镜像及数据路径，先只启动 Web：

```bash
docker compose config --quiet
docker compose up --detach web
```

首次启动仍按平台现有流程生成 Lite 引导配置。通过安全终端读取本地
`/srv/autoforge/platform/config/initial-admin-token`，访问 `http://10.20.0.11:3000/setup`。
在“运行模式初始化”切换为 Full 并填写：

| 平台配置 | 示例值 |
| --- | --- |
| PostgreSQL URL | `postgres://autoforge:<postgres-password>@10.20.0.21:5432/autoforge` |
| NATS servers | `nats://10.20.0.23:4222` |
| NATS token | 准备机 `nats-token` 文件的值 |
| Redis URL | `redis://:<redis-password>@10.20.0.22:6379` |
| MinIO endpoint | `http://10.20.0.24:9000` |
| MinIO access key / secret key | 对应 `minio-root-user`／`minio-root-password` 的值 |
| MinIO bucket / region | `autoforge-objects`／`us-east-1` |
| Web 监听 | `0.0.0.0:3000` |
| worker 健康端口 | `3001` |
| 平台外部地址／Runner 地址 | 使用 Nginx 时均填 `http://10.20.0.10`；直连时填平台可达地址 |

生成器输出 URL-safe 密码；使用自有密码时，PostgreSQL／Redis URL 中的特殊字符需要 URL 编码。
Full 连接信息仍保存在 `/srv/autoforge/platform/config/platform.json`，不通过 Compose 环境变量注入。

保存后重启 Web，使其连接 Full 数据库，再用同一初始令牌完成 Full 首位管理员创建：

```bash
docker compose restart web
curl --fail http://10.20.0.11:3000/api/v1/health/ready
```

确认 Full 初始化成功后再单独启动 worker：

```bash
docker compose --profile worker up --detach worker
docker compose --profile worker ps --all
```

Web 和 worker 各有自己的容器、健康检查、CPU／内存参数和停止窗口，共用**同一平台主机**的
`AUTOFORGE_PLATFORM_DATA_DIR`。两者可独立重启：`docker compose restart web` 或
`docker compose --profile worker restart worker`。不要把同一平台节点的 Web 与 worker
放到两台机器再各用一个不同的本地日志目录，也不要用 NFS 共享 SQLite 文件。
如需多个平台节点，按[已有分布式节点说明](../distributed/README.md)准备不同 nodeId、节点日志目录和共享密钥，
另行配置节点直连地址、配置同步和终端网关；本套默认没有负载均衡到多个平台节点。

## 5. 启动 Nginx 入口

在 Nginx 主机进入 `nginx/`，复制 `.env.example` 为 `.env`，修改本机绑定地址，
并将 `nginx.conf` 的 `upstream platform` 改为实际平台 IP／端口。不能填写 `localhost` 或 Docker 服务名。

```bash
docker compose config --quiet
docker compose run --rm --no-deps nginx nginx -t
docker compose up --detach
curl --fail http://10.20.0.10/api/v1/health/ready
```

配置支持 WebSocket、长日志读取、较大文件上传并关闭代理缓冲；不重放非幂等执行请求，
入口屏蔽 `/api/v1/internal/`。示例适用于受控内网 HTTP；跨不可信网络应使用企业 TLS 入口，
并同步设置平台外部／Runner 地址和可信代理的协议头。

MinIO 的 endpoint **必须同时能被 Web、worker、Runner 和浏览器访问**，
不能填写仅在 MinIO 容器网络中可解析的 `http://minio:9000`。更改 endpoint 或端口后要同步平台配置。

## 6. 升级、迁移已有卷与备份

- 升级平台前备份；校验并导入同一 Release 镜像，更新平台 `.env`，先停止 worker，更新 Web
  并完成迁移与 readiness 检查，再更新 worker。修改第三方凭据文件不会自动修改已有 PostgreSQL 用户密码。
- `docker compose down` 不删除宿主机绑定目录；仍需防止人为删目录、重装磁盘或改错 `.env`。
  容器标准输出由 Docker 轮转保存（每容器最多约 `20m × 5`），业务日志在平台本地目录中。
- 从 named volume 迁移时，先停止全部 Web／worker 和相应存储服务；通过 `docker volume inspect`
  确认原目录，再以 root 使用 `cp -a 原目录/. 新目录/` 或等效工具完整保留权限和文件。
  PostgreSQL、Redis、NATS、MinIO 分别原样迁移；平台必须复制完整目录，包含 `config/platform.json`、
  密钥、日志 SQLite 和 WAL／SHM。核验后再切换 bind 路径，保留原卷直至恢复演练完成。
- PostgreSQL 只可在相同主版本、兼容镜像与相同架构下复用其停止状态数据目录；跨架构／主版本使用
  `pg_dump`／`pg_restore`。不要边运行边复制数据库、JetStream 或 MinIO 数据目录。
- 备份必须在一致停止窗口覆盖 PostgreSQL、MinIO 和每个平台的完整本地目录及凭据。
  Redis 缓存和 NATS 投递可从权威记录重建，但不能用它们代替业务／对象／日志备份。
  现有 `full-backup.sh` 面向单机 Compose，不能直接收集本套分主机数据；遵循
  [Full 多机备份说明](../../../docs/operations/backup-recovery.md#full-多机器部署)。
- SELinux 开启的主机应由管理员对数据目录设置允许容器读写的标签；不要因此全局关闭 SELinux。
  Web 与 worker 共享目录需允许两个容器访问，不能使用仅供单容器的私有标记策略。

## 验证范围

2026-10-27 使用本机 Docker Compose v5.5.0 完成以下检查，过程未联网拉取镜像：

- 六套 Compose（包括 worker profile）解析通过，持久挂载均为 bind，源路径为绝对路径，
  配置没有声明 named volume，所有服务禁止自动拉取镜像。
- 使用模板固定摘要的 PostgreSQL、Redis、NATS 和 MinIO，在隔离临时目录分别启动、写入、
  停止并重建容器，原记录／键／JetStream 消息／对象仍可读取；MinIO bucket 初始化可重复运行。
  容器检查未发现 named／anonymous volume，缺失数据源目录会拒绝创建容器。
- Nginx 在无网络容器中执行 `nginx -t` 通过。部署包检查覆盖六套模板、版本填入、
  辅助凭据生成器和备份文档链接；构建排除真实配置、`.env` 和 secrets。

验证使用同一 Linux 主机上的隔离 Compose 项目、临时目录和端口，各基础设施组件串行测试，
每个测试容器限制 CPU 和内存。没有启动本套平台 Web／worker，未做跨物理主机、TLS、
生产规模或基础设施 HA 验收；此处不能视作这些场景已通过。
