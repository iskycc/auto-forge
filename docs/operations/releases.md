# Release 与离线交付

AutoForge 使用 `.github/workflows/release.yml` 从不可变 Git tag 构建 GitHub Release。当前 Release 交付同时支持 Lite/Full 组合根的后端镜像、Go Runner Agent 和版本化 Compose 部署包。PostgreSQL、NATS、MinIO 与 Redis 属于外部基础设施，不混入 AutoForge 自身镜像；离线部署必须另行导出镜像、锁定版本并遵守各项目许可。直连终端所需的前端、WebSocket 和 PTY 依赖已经进入 AutoForge 自身 lockfile、二进制与镜像，不需要额外服务。

## 发布条件

正式版本必须使用 `vX.Y.Z` 形式的语义版本 tag。推送 tag 会自动触发；手动运行 workflow 时，GitHub 的 “Use workflow from” 和 `tag` 输入必须指向同一个 tag，否则流水线会拒绝发布，保证源码提交、构建来源证明和 Release 一致。

```bash
git tag -s v0.2.1 -m "AutoForge v0.2.1"
git push origin v0.2.1
```

流水线先执行格式、lint、类型、单元、Lite/Full 集成、浏览器流程和生产构建，然后并行构建四个平台。Full 集成使用校验和或镜像摘要锁定的 PostgreSQL、NATS JetStream、MinIO 与 Redis，并验证 Full readiness 和一次性 Runner 注册。任一质量检查或目标失败，`publish` job 都不会运行。Release 先作为 draft 创建，全部资产上传后才转为正式版本。

`amd64` 目标运行在 `ubuntu-24.04`，`arm64` 目标运行在 GitHub-hosted 原生 `ubuntu-24.04-arm`。后端和 Agent 都不使用 QEMU 做跨架构模拟；本地没有对应原生硬件时可以只验证当前架构，正式四平台结果以 Release matrix 为准。

## 资产矩阵

每个版本包含以下四个 variant：

| Variant | CPU | 后端用户空间 | Agent 链接方式 |
| --- | --- | --- | --- |
| `amd64` | x86-64 | Debian / glibc | 静态，无 libc 依赖 |
| `arm64` | AArch64 | Debian / glibc | 静态，无 libc 依赖 |
| `amd64-musl` | x86-64 | Alpine / musl | 静态，无 libc 依赖 |
| `arm64-musl` | AArch64 | Alpine / musl | 静态，无 libc 依赖 |

每个 variant 生成：

- `autoforge-backend-VERSION-VARIANT.docker.tar.zst`：可由 Docker 直接导入的压缩离线镜像归档；
- `autoforge-backend-VERSION-VARIANT.spdx.json`：后端镜像 SBOM；
- `autoforge-agent-VERSION-VARIANT`：Linux Go 静态二进制；
- `autoforge-agent-VERSION-VARIANT.spdx.json`：Agent SBOM。

每个版本还生成一份 `autoforge-deploy-VERSION.tar.gz`，其中包含 Lite/Full `docker-compose.yml`、环境模板、固定的基础设施镜像摘要和离线启动说明。Release 根目录同时包含 `release-manifest.json` 和 `SHA256SUMS`。GitHub 的构建来源证明绑定 `SHA256SUMS` 中记录的全部资产摘要。

## 离线校验与启动

先在联网环境下载同一 Release 的全部所需资产、`SHA256SUMS` 和来源证明，再通过受控介质带入离线区。在包含校验和文件的目录中执行：

```bash
sha256sum --check SHA256SUMS
zstd --decompress --stdout autoforge-backend-0.2.1-amd64.docker.tar.zst | docker load
docker run --detach \
  --name autoforge \
  --publish 3000:3000 \
  --volume autoforge-data:/var/lib/autoforge \
  autoforge/backend:0.2.1-amd64
```

也可以解压同版本 Compose 部署包，从对应模式的环境模板开始配置：

```bash
tar -xzf autoforge-deploy-0.2.1.tar.gz
cd autoforge-deploy-0.2.1/lite
cp .env.example .env
# 替换所有示例凭据后：
docker compose config --quiet
docker compose up --detach
```

Full 部署还需提前导入部署包说明中列出的 PostgreSQL、NATS、MinIO、MinIO Client 和 Redis 固定摘要镜像。Compose 设置了 `pull_policy: never`，因此缺少镜像时直接失败，不会在隔离区尝试联网。

musl 归档的镜像标签相应为 `autoforge/backend:0.2.1-amd64-musl`。必须持久化 `/var/lib/autoforge`；删除该卷会删除 Lite 数据库和本地对象。

Agent 下载后先校验并恢复可执行位：

```bash
chmod 0755 autoforge-agent-0.2.1-amd64
./autoforge-agent-0.2.1-amd64 version
```

`doctor` 会检查控制面 URL、私有 CA 和本地目录。新 Agent 使用 bootstrap token 执行一次注册，身份保存后再次启动无需继续提供 bootstrap token：

```bash
AUTOFORGE_SERVER_URL=https://autoforge.internal \
AUTOFORGE_AGENT_DATA_DIR=/var/lib/autoforge-agent \
./autoforge-agent-0.2.1-amd64 doctor

AUTOFORGE_SERVER_URL=https://autoforge.internal \
AUTOFORGE_AGENT_DATA_DIR=/var/lib/autoforge-agent \
AUTOFORGE_AGENT_BOOTSTRAP_TOKEN='replace-with-bootstrap-secret' \
AUTOFORGE_AGENT_JAVA_EXECUTABLE=/opt/autoforge-toolchain/jdk/bin/java \
AUTOFORGE_AGENT_TESTNG_CLASSPATH=/opt/autoforge-toolchain/testng/testng.jar:/opt/autoforge-toolchain/testng/jcommander.jar \
AUTOFORGE_AGENT_JAVA_VERSION=21.0.8 \
AUTOFORGE_AGENT_TESTNG_VERSION=7.11.0 \
./autoforge-agent-0.2.1-amd64 start
```

当前 `start` 已实现注册、资源心跳、assignment claim、lease 续租、启动 reconcile、JAR 下载校验、离线 TestNG 类级执行、取消/进程组清理和完成上报。Java/TestNG 及其依赖必须预置，Agent 不会联网下载；未配置四项工具链变量时不会声明 TestNG capability，也不会进入 TestNG 调度候选。日志确认重传、产物上传、方法级精确选择和 Linux 资源硬限制仍未实现。

## 本地构建与验证

单个平台可使用与 CI 相同的脚本构建。后端需要 Docker Buildx 与 zstd，Agent 需要 Go 1.26.x 和 `file`：

```bash
SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
  bash scripts/release/build-agent.sh 0.2.1 amd64 dist/release

SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
  bash scripts/release/build-backend-image.sh 0.2.1 amd64 dist/release

SOURCE_DATE_EPOCH=0 \
  bash scripts/release/build-deployment-bundle.sh 0.2.1 dist/release
```

正式构建由 GitHub Actions 固定 Node、Go、pnpm、基础镜像 digest、Action commit 和 Syft 版本。构建阶段可以获取锁定依赖；生成的运行时镜像与 Agent 二进制在离线运行时不会下载依赖或发送遥测。
