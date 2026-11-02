# PostgreSQL 数据卷监控

采用标准 [Prometheus Node Exporter](https://github.com/prometheus/node_exporter)，固定 v1.12.1，Apache-2.0。它提供文件系统指标；PostgreSQL Exporter 负责数据库内部指标，不能代替文件系统余量采集。平台直接读取 Node Exporter，无需部署 Prometheus／Grafana。

## 启动

`fast-deploy/node-b`、`fast-deploy/log-postgres` 和 `deploy/compose/full-bind/log-postgres` 已有 `monitoring` profile。导入下述镜像、填写 `.env` 后，在数据库所在目录执行：

```bash
docker compose --profile monitoring up -d
```

采集容器与 PostgreSQL 使用同一个 bind 源目录，只读挂载为 `/pgdata`。只启用 filesystem collector，禁用 exporter 自身额外指标；没有宿主机根目录挂载、host PID 或特权权限。主库默认映射 19100，日志库默认 19101，可通过 `.env` 修改。只把端口绑定可信内网 IP，并通过防火墙限制主平台访问。

已有其他部署方式无需更换 PostgreSQL：使用 [独立 monitoring Compose](../../deploy/compose/monitoring/README.md)，把数据目录配置为 PostgreSQL 实际使用的宿主机目录。多个数据库实例位于同一文件系统时显示相同余量是正确结果；不要把它们的容量相加。

## 离线镜像

amd64 可直接下载 [Node Exporter 1.12.1 临时离线包](https://github.com/iskycc/auto-forge/releases/tag/infra-node-exporter-1.12.1-20261102)：镜像文件为 `autoforge-infra-node-exporter-1.12.1-amd64.docker.tar`，同页提供独立 Compose、校验清单、SPDX SBOM 和原始许可文本。下载后先使用 `sha256sum --check --ignore-missing SHA256SUMS` 校验，再导入镜像。该临时版本只交付监控组件；平台配置入口需要使用包含本功能的主平台版本。

官方固定源：`quay.io/prometheus/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0`。该摘要是多架构镜像索引；准备包时必须选择部署架构。联网准备机以 amd64 为例：

```bash
docker pull --platform linux/amd64 quay.io/prometheus/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0
docker tag quay.io/prometheus/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0 autoforge/offline-node-exporter:1.12.1-amd64
docker save --output node-exporter-1.12.1-amd64.docker.tar autoforge/offline-node-exporter:1.12.1-amd64
sha256sum node-exporter-1.12.1-amd64.docker.tar > node-exporter-1.12.1-amd64.docker.tar.sha256
```

离线目标机核对随包校验值后执行 `docker load --input node-exporter-1.12.1-amd64.docker.tar`。Compose 使用精确本地标签且 `pull_policy: never`，启动不会联网下载。arm64 准备机对应改为 linux/arm64 与 `1.12.1-arm64`，独立模板设置 `AUTOFORGE_ARCH=arm64`。fast-deploy 固定 amd64。

## 平台配置

- 主库：“系统信息 → 数据库使用详情 → 配置磁盘监控”。
- 日志库：“日志管理 → 日志配置 → 查看容量 → 配置磁盘监控”，每台服务器分别填写。

填写监控 IP／主机名、映射端口和 `/pgdata`，默认 HTTP；HTTPS 必须使用可信证书。点击“检查连接”确认采集到容量，再保存。已有宿主机 Node Exporter 可填写其地址与实际挂载点，例如 `/opt`；平台不会通过 PostgreSQL 的容器内路径猜测宿主机挂载点。

配置按版本条件保存到 Full 主库，多 Web 共享，保存后下一次检查生效，无需重启平台。查看需 settings.read，修改及连接检查需 settings.manage。原 pg_read_file 权限和 JSON 文件均不再需要，旧健康检查中的采样逻辑应移除。

## 边界

请求只采集 filesystem，拒绝 HTTP 重定向，整个请求最多 3 秒、正文最多 1 MiB；每 Web 最多 4 个检查，保留 15 秒快照。容量必须匹配同一挂载点、device、fstype，collector 成功且 device_error 为零；缺失、歧义、错误或超时均显示不可用，执行和日志写入继续按原规则运行。

采用 `node_filesystem_avail_bytes`，即普通 PostgreSQL 用户可使用的空间，不把 root 保留块计入可用空间。外置 tablespace／WAL、备份盘需要另行配置监控。采集端以只读方式挂载目录，不代表 PostgreSQL 的数据目录变为只读。
