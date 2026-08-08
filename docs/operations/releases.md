# Release 与离线交付

AutoForge 使用 `.github/workflows/release.yml` 从不可变 Git tag 构建 GitHub Release。当前 Release 交付 Lite 后端镜像和 Go Runner Agent；Full 服务镜像要等 Full 适配器实际可用后再加入，不能以占位镜像冒充。

## 发布条件

正式版本必须使用 `vX.Y.Z` 形式的语义版本 tag。推送 tag 会自动触发；手动运行 workflow 时，GitHub 的 “Use workflow from” 和 `tag` 输入必须指向同一个 tag，否则流水线会拒绝发布，保证源码提交、构建来源证明和 Release 一致。

```bash
git tag -s v0.2.0 -m "AutoForge v0.2.0"
git push origin v0.2.0
```

流水线先执行格式、lint、类型、单元、集成、浏览器流程和生产构建，然后并行构建四个平台。任一质量检查或目标失败，`publish` job 都不会运行。Release 先作为 draft 创建，全部资产上传后才转为正式版本。

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

Release 根目录还包含 `release-manifest.json` 和 `SHA256SUMS`。GitHub 的构建来源证明绑定 `SHA256SUMS` 中记录的资产摘要。

## 离线校验与启动

先在联网环境下载同一 Release 的全部所需资产、`SHA256SUMS` 和来源证明，再通过受控介质带入离线区。在包含校验和文件的目录中执行：

```bash
sha256sum --check SHA256SUMS
zstd --decompress --stdout autoforge-backend-0.2.0-amd64.docker.tar.zst | docker load
docker run --detach \
  --name autoforge \
  --publish 3000:3000 \
  --volume autoforge-data:/var/lib/autoforge \
  autoforge/backend:0.2.0-amd64
```

musl 归档的镜像标签相应为 `autoforge/backend:0.2.0-amd64-musl`。必须持久化 `/var/lib/autoforge`；删除该卷会删除 Lite 数据库和本地对象。

Agent 下载后先校验并恢复可执行位：

```bash
chmod 0755 autoforge-agent-0.2.0-amd64
./autoforge-agent-0.2.0-amd64 version
```

`doctor` 会检查控制面 URL、私有 CA 和本地目录，但当前控制面协议尚未实现，因此不能注册或领取任务：

```bash
AUTOFORGE_SERVER_URL=https://autoforge.internal \
AUTOFORGE_AGENT_DATA_DIR=/var/lib/autoforge-agent \
./autoforge-agent-0.2.0-amd64 doctor
```

## 本地构建与验证

单个平台可使用与 CI 相同的脚本构建。后端需要 Docker Buildx 与 zstd，Agent 需要 Go 1.26.x 和 `file`：

```bash
SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
  bash scripts/release/build-agent.sh 0.2.0 amd64 dist/release

SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
  bash scripts/release/build-backend-image.sh 0.2.0 amd64 dist/release
```

正式构建由 GitHub Actions 固定 Node、Go、pnpm、基础镜像 digest、Action commit 和 Syft 版本。构建阶段可以获取锁定依赖；生成的运行时镜像与 Agent 二进制在离线运行时不会下载依赖或发送遥测。
