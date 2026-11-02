# PostgreSQL 数据卷监控

独立部署固定版本 Node Exporter，不修改 PostgreSQL 镜像、数据目录或健康检查。导入 `autoforge/offline-node-exporter:1.12.1-amd64`，复制 `.env.example` 为 `.env` 并填写宿主机数据目录、可信内网 IP 和端口后执行 `docker compose up -d`。

数据目录必须与 PostgreSQL 的 bind 源相同；如数据库使用 named volume，需把本模板的 bind 改为同一外部 volume，不能监控另一个目录。模板只读映射到 `/pgdata`，平台配置也填写 `/pgdata`。组件不依赖 cgroup v2，不采集 CPU／内存或容器根文件系统。

离线镜像来源、SHA-256 校验、平台入口和权限见 [数据卷监控指南](../../../docs/operations/postgres-monitoring.md)。官方组件为 Apache-2.0，精确版本 v1.12.1；本模板不运行采样脚本、不写入 JSON、不调用数据库文件函数。
