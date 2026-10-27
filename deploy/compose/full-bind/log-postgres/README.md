# Full 独立 PostgreSQL 日志库

本组件是可选的独立日志 PostgreSQL 实例，使用 `autoforge_logs` 数据库与专用账号。
业务 PostgreSQL 仍按 `postgres/` 模板部署，两个实例各自持久化、使用不同凭据。
主库只记录日志库位置、确认水位及配置；日志正文写入此实例。

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
**平台设置 → 日志数据库 → 添加日志数据库**，例如填写：

```text
名称：日志库 01
连接：postgres://autoforge_logs:<独立密码>@10.20.0.13:5433/autoforge_logs
```

连接串中的密码如包含特殊字符需 URL 编码。登记会执行版本化日志迁移并写入库身份，
之后点击“检查连接”“设为写入库”。选择立即生效，无需重启 Web 或 worker。
批次在首次写入时固定库；已执行批次和在途批次不会因切换而改变写入位置。
之前本地 SQLite 日志继续按原位置读取，仍需保留对应平台本地数据目录。

## 增加数据库与修改连接

容量接近预算时，在另一台日志主机按本组件部署，或在同机复制本组件目录并使用独立配置：

- 改用另一个端口，例如 `5434`。
- 使用另一个数据目录和凭据目录。
- 每次命令加入独立项目名，例如 `docker compose -p autoforge-log-02 -f docker-compose.yml -f compose.offline.yml up --detach`，
  配置检查、查看和后续启停均使用同一项目名，避免与第一个实例互相覆盖。

在平台登记为“日志库 02”并切换，之后的新批次进入新库。旧库继续提供历史查询，
禁止删除、清空、替换旧库或删除其身份记录。数据库目录按页展示，登记数量不受运行时四个连接池缓存限制。

地址变更或密码轮换后，在原卡片“修改连接”填写新的完整连接串；服务器校验新地址仍是同一库，
保留原库 ID 和批次绑定，各节点后续操作读取新连接配置。不能通过修改连接把历史指向新空库。
当前提供手动选择一个新批次写入库，不自动跨库分片或自动搬迁历史正文。

## 故障与备份

日志库故障会返回具体库 ID 和可操作错误，Agent 按已有 spool／重传协议保留未确认日志。
不会把已有批次写入其他库。应恢复原库及身份、网络和凭据；仍可把之后的新批次切到另一个健康库。
如果历史批次位于本地，则继续依赖原日志节点的可用性。

备份必须在停止全部平台 Web／worker 的一致窗口覆盖业务库、全部日志库、MinIO、平台配置和旧本地日志。
每个日志库可使用 `pg_dump`／`pg_restore`，保留全部表和迁移／身份记录；
原始目录冷备还需停止相应 PostgreSQL。记录日志库 ID 与备份对应关系，妥善保管平台主密钥。
现有单机 Full 备份脚本不自动包含这些独立日志库，不能把它单独作为本方案的完整备份。

管理页大小是已登记的逻辑正文大小，PostgreSQL 的索引、TOAST、WAL 与物理磁盘占用由部署侧监控。
仅配置新库不会自动释放旧库磁盘；历史清理仍按原批次保留策略执行。
