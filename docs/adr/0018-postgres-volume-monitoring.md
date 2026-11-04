# ADR 0018：使用 Node Exporter 采集 PostgreSQL 数据卷余量

状态：采用。日期：2026-11-02。

PostgreSQL 原生 SQL 提供数据库大小，不提供文件系统余量。此前把 df／awk 采样嵌入 Compose 健康检查并通过 pg_read_file 取样，增加了维护成本和数据库文件读取权限需求，现退役该方式。

采用 Apache-2.0 的 Prometheus Node Exporter v1.12.1，固定官方镜像摘要并允许离线导入。平台直接抓取该组件的 filesystem 指标，无需 Prometheus／Grafana 服务。采集容器只读挂载同一 PostgreSQL 数据目录为 /pgdata；只启用 filesystem，不读取数据文件内容，不挂载整个宿主机根目录，不使用 host PID 或 privileged。

平台按配置的挂载点严格匹配同一 device／fstype 的容量、非 root 可用空间和错误状态；无法唯一匹配时不显示其他盘的数据。网络期限、响应大小、并发与快照均有上限，错误仅影响观察结果。指标端口限制到可信管理网络。

监控源配置通过应用端口读写，Full PostgreSQL 适配器持久化到独立 storage_monitoring_settings 表，按主库或日志服务器区分并使用版本条件更新，多个 Web 节点共享。新增 Full 主库迁移 0091；新建、从 0090 升级和事务失败回滚均验证。SQLite 不创建该表：此功能是 Full 远端基础设施的配置，Lite 已通过本地磁盘端口读取容量，不连接 Exporter，也不需要额外组件。

离线镜像是独立的第三方基础设施，单独提供导入方式，不塞入主平台后端镜像，模板不在运行时拉取镜像。2026-11-04 起，含采集器的数据库模板默认同时启动 PostgreSQL 与 Node Exporter，移除原 `monitoring` profile，避免普通启动漏掉监控。离线部署前须同时导入两种镜像；数据库本身不依赖采集器健康，显式只选择 `postgres` 服务时仍可独立启动。回滚应先停止新 Web／worker 再部署旧版；新增表可保留，不影响旧版业务 schema。旧版的 JSON 采样方案不会被新版自动恢复；若回退后需要旧显示，需自行恢复旧健康检查。无执行数据转换、Runner 协议或日志数据库位置变化。
