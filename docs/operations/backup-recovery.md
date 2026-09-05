# 备份、恢复与升级

## 共同安全边界

备份包含账号摘要、LDAP bind 密文、Runner 安装连接档案、平台主密钥和 Runner/API 身份，必须视为最高敏感
离线介质：使用组织批准的全盘/归档加密，限制读取者，记录介质流转并单独保管解密材料。脚本只
生成校验和，不声称提供加密。恢复后轮换平台可访问的数据库/MinIO/LDAP 凭据、所有 Runner 与
API 令牌，并按密文 ADR 评估主密钥轮换。

## Lite

停止 AutoForge 后执行：

```bash
operations/lite-backup.sh --data-dir /srv/autoforge-data \
  --output /secure/autoforge-lite-2026-08-11.tar.gz --platform-stopped
operations/lite-restore.sh --input /secure/autoforge-lite-2026-08-11.tar.gz \
  --data-dir /srv/autoforge-restored --platform-stopped
```

备份把 SQLite（含 WAL/SHM）、对象目录、平台配置和密钥作为同一个停止状态集合。恢复拒绝非空
目标，不会静默覆盖现有数据。启动前运行迁移，然后验证 readiness、登录、对象摘要和最近执行。

## Full 单机 Compose

停止 `autoforge` 与 `worker`，保持 PostgreSQL/MinIO 可用：

```bash
operations/full-backup.sh --compose-file full/docker-compose.yml \
  --output /secure/autoforge-full-2026-08-11.tar.gz --platform-stopped
operations/full-restore.sh --compose-file full/docker-compose.yml \
  --input /secure/autoforge-full-2026-08-11.tar.gz --platform-stopped --replace-existing
```

Full 集合包含 PostgreSQL custom dump、MinIO 全量对象以及平台配置和本地日志数据卷。NATS 的调度投递与 Redis
缓存/限速状态可由 PostgreSQL outbox/权威表重建，不作为业务备份。恢复会清空目标 PostgreSQL
public schema、平台数据卷和 MinIO bucket，因此必须显式传 `--replace-existing`，且只能针对核对
过的 Compose 文件执行。

## Full 多机器部署

上述 `full-backup.sh` / `full-restore.sh` 只适用于单机 Full Compose，不能自动收集分布在各机器上的日志。
分布式备份前暂停入口写入并停止全部 Web、worker；在同一停止窗口保存共享 PostgreSQL、MinIO，
以及每个节点的 `config/platform.json` 和完整日志卷（含 SQLite WAL/SHM）。同时保存节点 ID 与机器、
数据卷之间的对应关系。PostgreSQL 中的日志归属和水位不能还原日志正文，Redis 缓存也不能代替日志备份。

恢复时先还原共享基础设施，再将各日志卷和原节点 ID 配对还原，使用同一构建的镜像启动节点。
核对平台节点页面的地址、跨节点日志读取与 Runner 重连后再恢复入口流量。缺少任一节点的日志卷时，
应保留该节点归属记录并明确标记恢复不完整，不能通过修改节点 ID 或清空归属表伪装成空日志。
当前版本不提供分布式自动备份、节点日志迁移或日志多副本。

## 升级、失败与回滚

1. 下载同一 Release 的 manifest、SHA256SUMS、目标镜像、metadata 包与部署包并离线验证；
   metadata 包内包含对应 SBOM 和法律声明。
2. 完成停止状态备份，运行 `operations/upgrade-preflight.sh` 检查摘要、配置 schema 与空间。
3. 导入新镜像，保持旧镜像和备份可用；运行 `operations/migrate.sh --compose-file …`。
4. 启动 Web，再启动 worker/Agent，检查 liveness/readiness、迁移记录、队列和对象健康。
5. 迁移失败时不要修改 SQL 或使用 schema push；保存错误诊断，恢复完整备份并启动旧镜像。

数据库迁移一经提交不支持原地降级。回滚必须同时恢复数据库、对象/平台数据和旧镜像，不能只
切换镜像 tag。建议每个候选版本在隔离环境使用真实规模脱敏夹具完成一次恢复演练。
