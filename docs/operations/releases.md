# Release 与离线交付

AutoForge 使用 `.github/workflows/release.yml` 从不可变 Git tag 构建 GitHub Release，由 `.github/workflows/release-checks.yml` 并行检查标签源码，并在 Release 成功后由 `.github/workflows/release-acceptance.yml` 检查已发布资产。Release 交付 Lite/Full 共用的后端镜像和版本化 Compose 部署包；每个后端镜像内置 Linux `amd64`、`arm64` Runner Agent，不再生成独立 Agent Release 资产。PostgreSQL、NATS、MinIO 与 Redis 属于外部基础设施，不混入 AutoForge 自身镜像；离线部署必须另行导出镜像、锁定版本并遵守各项目许可。

## 发布条件

正式版本必须使用 `vX.Y.Z` 形式的语义版本 tag。推送 tag 会同时触发相互独立的 `Release` 与 `Release checks` workflow；`Release` 成功完成后再触发 `Published Release acceptance`，不在测试 Job 内轮询未完成的发布。手动发布时，GitHub 的 “Use workflow from” 和 `Release` workflow 的 `tag` 输入必须指向同一个 tag，保证源码提交、构建来源证明和 Release 一致；源码检查和发布资产验收都可以从默认分支手动启动，并通过 `tag` 输入选择要复验的版本。手动发布资产复验使用所选默认分支 revision 的验收工具检查不可变 Release，允许在不改写历史 tag 的前提下修复验收工具。

```bash
git tag -s v0.2.2 -m "AutoForge v0.2.2"
git push origin v0.2.2
```

`Release` 只保留发布所需的关键路径：校验 tag 后构建一次 CoTest Adapter，四个平台复用该内部制品并行构建，随后组装部署包、生成 SBOM/清单、签名、生成来源证明并公开 GitHub Release。后端构建使用按 variant 隔离的 GitHub Actions BuildKit 缓存，离线 Docker 归档直接发布 Docker 原生 tar，目标机不需要额外安装 zstd；不再构建耗时的 `toolchain-amd64/arm64` Release 资产。任一平台、SBOM、签名或清单失败仍会阻止发布，因而不会公开缺少必需资产的部分 Release。

`Release checks` 将格式/lint/类型、单元/集成、性能、构建、Full 场景和断网 Lite 场景拆成独立矩阵并行执行。`Published Release acceptance` 只在发布完成后启动，将资产签名、业务、真实 Agent、真实离线 LDAP、备份恢复、上一正式版本升级和注入迁移失败回滚拆成隔离分区；各测试 Job 以五分钟内完成为目标，八分钟超时仅为托管 Runner 抖动保留诊断空间。两类检查都不属于 `Release` 的依赖，不会阻塞、取消或撤回发布；失败版本应通过问题修复和新版本 hotfix 处理。普通 CI 与依赖安全 workflow 不在 tag push 上重复运行，以免与发布矩阵争抢并发资源。

`amd64` 目标运行在 `ubuntu-24.04`，`arm64` 目标运行在 GitHub-hosted 原生 `ubuntu-24.04-arm`。后端不使用 QEMU 做跨架构模拟；内置 Agent 由 Go 原生交叉编译为两个静态架构，并在每个镜像中校验资源清单。

Web 进程为同源终端 WebSocket 使用 Next.js 自定义 Server。发布构建先将自定义 Server 与迁移入口打成生产 bundle，再合并 Next.js 生成的依赖追踪清单；运行时镜像只复制追踪到的生产模块、数据库迁移、静态资源和双架构 Agent。`.next/cache`、源码映射、本地数据、测试产物与开发依赖不会进入镜像。该方案保留常规 Next.js 生产运行时而不启用不兼容自定义 Server 的 `standalone` 模式；镜像验证会实际启动 Web、执行 SQLite 迁移并检查 Agent，防止瘦身遗漏运行时依赖。

## 资产矩阵

每个版本包含以下四个 variant：

| Variant      | CPU     | 后端用户空间   | 内置 Agent                          |
| ------------ | ------- | -------------- | ----------------------------------- |
| `amd64`      | x86-64  | Debian / glibc | Linux amd64 + arm64，均为静态       |
| `arm64`      | AArch64 | Debian / glibc | Linux amd64 + arm64，均为静态       |
| `amd64-musl` | x86-64  | Alpine / musl  | Linux amd64 + arm64，均无 libc 依赖 |
| `arm64-musl` | AArch64 | Alpine / musl  | Linux amd64 + arm64，均无 libc 依赖 |

每个 variant 只发布一个用户需要下载的运行资产：

- `autoforge-backend-VERSION-VARIANT.docker.tar`：可由 Docker 直接导入的离线镜像归档；
- Docker config 内容摘要形式的不可变 image ID、平台和 OCI 标签统一记录在
  `release-manifest.json#backendImages`，不再为每个平台发布零散的 `image.json`。

每个版本还生成一份 `autoforge-deploy-VERSION.tar.gz`，其中只包含 Lite/Full
`docker-compose.yml`、环境模板、运维脚本、许可证和部署所需手册，不携带设计图、归档审计、
roadmap 或内部实现资料。`autoforge-release-metadata-VERSION.tar.gz` 集中保存四个平台镜像、
部署包与两个 Jenkins HPI 的 SPDX JSON SBOM，以及 `LICENSE`、`NOTICE`、第三方许可证清单、
兼容矩阵和变更记录。SBOM 内容没有删除，只是不再平铺为多个顶层 Release 资产。

Release 根目录同时包含 `release-manifest.json`、`SHA256SUMS`、Ed25519 签名
`SHA256SUMS.sig` 和 `release-signing-public-key.pem`。GitHub 的构建来源证明绑定
`SHA256SUMS` 中记录的全部资产摘要，metadata 包内的文件由该归档摘要传递保护。

后端镜像内同时包含可校验的 CoTest Adapter JAR。正式 Release 不提供 JDK/TestNG 工具链资产；管理员在项目设置中上传 JDK 与完整依赖 JAR 压缩包，或登记 Runner 可访问的内网 HTTP(S) 链接、精确大小和 SHA-256。部署包仍生成对应的 SPDX JSON SBOM。

## 离线校验与启动

先从可信渠道固定当前版本的签名公钥，再在联网环境下载同一 Release 的全部所需资产、`SHA256SUMS`、`SHA256SUMS.sig` 和来源证明，通过受控介质带入离线区。在包含校验和文件的目录中先验证发布签名，再校验各资产：

```bash
openssl pkeyutl -verify -rawin -pubin \
  -inkey release-signing-public-key.pem \
  -sigfile SHA256SUMS.sig \
  -in SHA256SUMS
sha256sum --check SHA256SUMS
docker load --input autoforge-backend-0.2.2-amd64.docker.tar
node -e "const m=require('./release-manifest.json'); console.log(m.backendImages.find(i=>i.variant==='amd64').immutableImageId)"
docker run --detach \
  --name autoforge \
  --publish 3000:3000 \
  --volume autoforge-data:/var/lib/autoforge \
  sha256:IMAGE_ID_FROM_METADATA
```

公钥必须通过独立可信渠道核对，不能仅依赖与待验证资产一起下载的副本。轮换签名密钥时会在变更日志中公布新公钥指纹；旧版本继续使用该版本随附且已固定的公钥验证。

也可以解压同版本 Compose 部署包，从对应模式的环境模板开始配置：

```bash
tar -xzf autoforge-deploy-0.2.2.tar.gz
cd autoforge-deploy-0.2.2/lite
cp .env.example .env
# 设置离线镜像标签后：
docker compose config --quiet
docker compose up --detach
```

Full 部署还需提前导入部署包说明中列出的 PostgreSQL、NATS、MinIO、MinIO Client 和 Redis 固定摘要镜像。Compose 设置了 `pull_policy: never`，因此缺少镜像时直接失败，不会在隔离区尝试联网。

musl 归档的镜像标签相应为 `autoforge/backend:0.2.2-amd64-musl`。必须持久化 `/var/lib/autoforge`；删除该卷会删除 Lite 数据库和本地对象。

首次启动从容器日志或数据卷的 `/var/lib/autoforge/config/initial-admin-token` 获取管理员令牌。登录后先在“平台配置”设置执行机可访问的 HTTP 或 HTTPS 地址；可信内网可填写 `http://内网IP:端口`，其他网络应使用 HTTPS。再在“执行机”页面填写 IP/主机名、SSH 用户和密码。平台会探测系统与架构并显示 SSH 主机指纹；管理员通过可信渠道核对后才能安装。首次安装或手动更新成功后，平台以主密钥 AES-256-GCM 加密保存连接档案，供后续单机或批量更新复用；API 不返回密码或私有 CA 明文。Agent 注册仍使用短期一次性令牌。

自动安装要求目标机为 Ubuntu 或 openSUSE、使用 systemd，并预置 SSH、Bash、coreutils；非 root SSH 用户还需已有 sudo。cgroup v2 可用时自动启用，缺失时 Agent 以降级隔离运行。服务默认使用专用账号，也可由管理员显式选择 root 模式。openSUSE 被 `/etc/os-release` 报告成 SLES 等无法自动判断时，可在核验主机后手动强制选择 openSUSE 安装模式。安装脚本不会调用系统包管理器或下载依赖。Agent 安装包内含 Adapter；任务提供 JDK 与 JAR 资源时无需预置本机 Java/TestNG。

## 本地构建与验证

单个平台可使用与 CI 相同的脚本构建。后端需要 Docker Buildx、Go 1.26.x 和 `file`；构建脚本会先生成两个内置 Agent 资源：

```bash
SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
  bash scripts/release/build-backend-image.sh 0.2.2 amd64 dist/release

SOURCE_DATE_EPOCH=0 \
  bash scripts/release/build-deployment-bundle.sh 0.2.2 dist/release
```

正式构建由 GitHub Actions 固定 Node、Go、pnpm、基础镜像 digest、Action commit 和 Syft 版本。构建阶段可以获取锁定依赖；生成的运行时镜像和其中的 Agent 在离线运行时不会下载依赖或发送遥测。

构建脚本默认限制单个 Docker 原生归档不超过 180 MiB，避免构建缓存或开发依赖再次进入正式镜像。特殊诊断构建可通过 `AUTOFORGE_BACKEND_IMAGE_MAX_BYTES` 临时调整预算；正式发布不得仅为绕过体积回归而提高该值。
