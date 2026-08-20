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

## Full

停止 `autoforge` 与 `worker`，保持 PostgreSQL/MinIO 可用：

```bash
operations/full-backup.sh --compose-file full/docker-compose.yml \
  --output /secure/autoforge-full-2026-08-11.tar.gz --platform-stopped
operations/full-restore.sh --compose-file full/docker-compose.yml \
  --input /secure/autoforge-full-2026-08-11.tar.gz --platform-stopped --replace-existing
```

Full 集合包含 PostgreSQL custom dump、MinIO 全量对象和共享平台配置。NATS 的调度投递与 Redis
缓存/限速状态可由 PostgreSQL outbox/权威表重建，不作为业务备份。恢复会清空目标 PostgreSQL
public schema、平台数据卷和 MinIO bucket，因此必须显式传 `--replace-existing`，且只能针对核对
过的 Compose 文件执行。

## 升级、失败与回滚

1. 下载同一 Release 的 manifest、SHA256SUMS、镜像/SBOM/部署包并离线验证。
2. 完成停止状态备份，运行 `operations/upgrade-preflight.sh` 检查摘要、配置 schema 与空间。
3. 导入新镜像，保持旧镜像和备份可用；运行 `operations/migrate.sh --compose-file …`。
4. 启动 Web，再启动 worker/Agent，检查 liveness/readiness、迁移记录、队列和对象健康。
5. 迁移失败时不要修改 SQL 或使用 schema push；保存错误诊断，恢复完整备份并启动旧镜像。

数据库迁移一经提交不支持原地降级。回滚必须同时恢复数据库、对象/平台数据和旧镜像，不能只
切换镜像 tag。建议每个候选版本在隔离环境使用真实规模脱敏夹具完成一次恢复演练。
