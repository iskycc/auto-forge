# ADR 0011：双架构容器发布与静态 Agent 兼容

- 状态：Accepted
- 日期：2026-09-01

## 背景

此前 GitHub Release 同时生成 `amd64`、`arm64`、`amd64-musl`、`arm64-musl` 四个后端镜像。
glibc/musl 是镜像内部用户空间的选择，不是宿主机 ABI：Docker/OCI 容器携带自己的用户空间，
Alpine/musl 宿主机可以运行 Debian/glibc 容器，只需宿主容器运行时支持镜像的 CPU 架构。
为同一 CPU 架构重复发布两份后端镜像增加了构建时间、存储、SBOM 和离线介质成本，却没有增加
宿主机兼容范围。

Runner Agent 与后端容器不同。Agent 安装后直接在 Runner 宿主机运行，因此必须同时兼容 glibc
和 musl 发行版。当前 Agent 是纯 Go 程序，使用 `CGO_ENABLED=0`、`netgo` 和 `osusergo` 构建，
不依赖 libc。

## 决策

1. 新 Release 只发布 `amd64`、`arm64` 两个 Debian/glibc 后端 Docker 归档。两者分别在同架构
   GitHub-hosted Runner 上构建，不使用 QEMU 伪造原生目标。
2. 每个后端镜像继续内置 `linux-amd64`、`linux-arm64` 两个 Agent 资源，不发布重复的
   `*-musl` Agent。CPU 架构相同的 glibc 与 musl 主机使用同一份 Agent。
3. Agent 构建必须同时验证 `CGO_ENABLED=0` 构建元数据、ELF 无 `PT_INTERP`、无动态库
   `DT_NEEDED`，并保留架构与静态链接检查。任何引入 CGO 或动态运行时的变更必须先修订本 ADR，
   再决定是否增加 libc 专用 Agent。
4. Release manifest 升级到 schema 3，并将必需后端镜像清单缩减为两个架构。已发布的 schema 1/2
   仍按历史四镜像合同验收，旧 Release 不重写、不删除。

## 影响

- 每个新版本少构建、上传和保存两个后端归档及其 SBOM，发布耗时和用户下载选择都更小。
- 宿主机为 Alpine/musl 不需要选择特殊后端镜像；Docker 只按 `amd64` 或 `arm64` 选择资产。
- Agent 的 musl 兼容性来自无 libc 依赖的静态 ELF，而不是文件名后缀或重复二进制。
- 本次变更没有数据库、平台配置、Runner Protocol 或已安装 Agent 迁移。
