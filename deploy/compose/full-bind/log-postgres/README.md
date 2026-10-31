# Full 独立 PostgreSQL 日志库

本组件提供独立日志 PostgreSQL 实例与专用管理员账号，平台按日期自动创建日志数据库。
业务 PostgreSQL 仍按 `postgres/` 模板部署，两个实例各自持久化、使用不同凭据。
主库只记录日志库位置、确认水位及配置；日志正文写入此实例。

Full 禁止新增和追加本地 SQLite 日志，执行前必须登记并选择按日 PostgreSQL 日志服务器。已有本地日志仅保留读取和归档。需要更直接的 amd64 部署时可使用 [fast-deploy 日志库](../../../../fast-deploy/log-postgres/README.md)。

此功能从 AutoForge **v1.20.23** 起提供，平台 Web 与 worker 均需使用该版或更新的同一版本。

## 部署

三主机方案中，可在 C（MinIO／NATS 主机）增加此组件，示例地址 `10.20.0.13:5433`。
需要为日志 PostgreSQL 预留内存和数据盘，优先与 MinIO／JetStream 分盘；容量不足时另选专用日志主机。
多台 Full 平台节点都需能访问每一个已登记日志库；浏览器与 Runner 不直连这些数据库。

导入已校验的 PostgreSQL 离线镜像。使用此前基础设施临时包时，将覆盖归档中的
`postgres/compose.offline.yml` 复制到本目录；两套 Compose 都使用 `postgres` 服务名，可复用此镜像覆盖。
此处的日志库不会新建另一种镜像发布物。

复制 `.env.example` 为 `.env`，修改本机 IP、端口和本地目录，使用 root 创建目录：

```bash
install -d -m 0700 /srv/autoforge/log-postgres /srv/autoforge/log-secrets
```

在可信准备机生成新的独立密码，保存为本机 `/srv/autoforge/log-secrets/postgres-password`，权限 `0600`。
可复用[父说明的凭据生成器](../README.md#2-生成并分发凭据)，但需使用新的准备目录生成，
只分发其中的 `postgres-password`；不要覆盖业务 PostgreSQL 凭据。
数据目录和密码文件均需事先存在，不使用 named volume。

启动时始终保留离线镜像覆盖参数：

```bash
docker compose -f docker-compose.yml -f compose.offline.yml config --quiet
docker compose -f docker-compose.yml -f compose.offline.yml up --detach
docker compose -f docker-compose.yml -f compose.offline.yml ps --all
```

只允许平台 Web／worker 主机访问日志端口。健康后在 Full 平台打开
**平台设置 → 日志数据库 → 添加日志服务器**，例如填写：

```text
名称：日志服务器 01
主机：10.20.0.13
端口：5433
管理员用户名：autoforge_logs
管理员密码：该实例的独立密码
维护数据库：postgres
每日库名前缀：autoforge_logs
```

本模板的 `POSTGRES_USER=autoforge_logs` 是官方镜像初始化的管理员，具备建库权限；手工部署也可使用 `postgres`、已配置的 `root` 或其他具备 `CREATEDB` 权限的账号。密码在独立字段填写，不需要手工 URL 编码，平台加密保存。

点击“检查连接”“设为写入库”后，新批次绑定此服务器，按日志记录时间的北京时间日期自动创建 `前缀_配置标识_YYYYMMDD` 数据库。跨日执行自动分库并合并读取。切换即时生效，无需重启 Web／worker；在途批次保持原服务器。

旧版单库及节点本地 SQLite 日志继续按原位置读取，不自动搬迁或删除。升级后先登记并选择按日服务器再启动新任务，旧单库不能再选择为新批次的写入位置。月度压缩、离线查看及空间回收见[日志归档运维说明](../../../../docs/operations/log-archives.md)。

## 增加数据库与修改连接

容量接近预算时，在另一台日志主机按本组件部署，或在同机复制本组件目录并使用独立配置：

- 改用另一个端口，例如 `5434`。
- 使用另一个数据目录和凭据目录。
- 每次命令加入独立项目名，例如 `docker compose -p autoforge-log-02 -f docker-compose.yml -f compose.offline.yml up --detach`，
  配置检查、查看和后续启停均使用同一项目名，避免与第一个实例互相覆盖。

在平台登记为“日志服务器 02”并切换，之后的新批次按日期进入新服务器。旧库继续提供历史查询，
禁止删除、清空、替换旧库或删除其身份记录。数据库目录按页展示，登记数量不受运行时四个连接池缓存限制。

地址变更或密码轮换后，在原卡片“修改连接”填写新的管理员连接字段；服务器校验新地址仍保留原来的日期库，
保留原库 ID 和批次绑定，各节点后续操作读取新连接配置。不能通过修改连接把历史指向新空库。
每个批次绑定一个日志服务器，服务器内按日分库；不自动搬迁未归档的历史正文。

## 故障与备份

日志库故障会返回具体库 ID 和可操作错误，Agent 按已有 spool／重传协议保留未确认日志。
不会把已有批次写入其他库。应恢复原库及身份、网络和凭据；仍可把之后的新批次切到另一个健康库。
如果历史批次位于本地，则继续依赖原日志节点的可用性。

备份必须在停止全部平台 Web／worker 的一致窗口覆盖业务库、全部日志库、MinIO、平台配置和旧本地日志。
应覆盖所有已创建的日期库及旧单库；每个库可使用 `pg_dump`／`pg_restore`，保留全部表和迁移／身份记录；
原始目录冷备还需停止相应 PostgreSQL。记录日志库 ID 与备份对应关系，妥善保管平台主密钥。
现有单机 Full 备份脚本不自动包含这些独立日志库，不能把它单独作为本方案的完整备份。

管理页大小是已登记的逻辑正文大小，PostgreSQL 的索引、TOAST、WAL 与物理磁盘占用由部署侧监控。
仅配置新库不会自动释放旧库磁盘；历史清理仍按原批次保留策略执行。

## PostgreSQL 数据卷容量采样

新版 fast-deploy/node-b、fast-deploy/log-postgres 与 full-bind/log-postgres 模板的 PostgreSQL 健康检查内置 `df -Pk "$PGDATA"` 采样，无需另外运行脚本。平台设置的“日志数据库 → 查看容量”和主库诊断可显示该数据卷实际剩余空间；旧部署需更新对应健康检查并重建容器，保留原 bind 数据目录。缺失、权限不足或超过两分钟的采样不会显示成当前有效空间。外置 tablespace／WAL 文件系统需单独监控，详见[Full 三主机运行链路与容量诊断](../../../../docs/architecture/full-three-host-runtime-audit.md)。
