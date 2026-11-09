# Release 与离线交付

AutoForge 使用 `.github/workflows/release.yml` 从不可变 Git tag 构建 GitHub Release，Release 成功后，由 `.github/workflows/release-checks.yml` 复用实际镜像中的产物检查标签源码，并由 `.github/workflows/release-acceptance.yml` 检查已发布资产。Release 交付 Lite/Full 共用的后端镜像和版本化 Compose 部署包；每个后端镜像内置 Linux `amd64`、`arm64` Runner Agent，不再生成独立 Agent Release 资产。PostgreSQL、NATS、MinIO 与 Redis 属于外部基础设施，不混入 AutoForge 自身镜像；离线部署必须另行导出镜像、锁定版本并遵守各项目许可。

## 构建复用与运行成本

普通分支 CI 通过 `acceptance-build.yml` 先生成一份生产构建。Lite 浏览器、500 槽位、真实 Agent、SSH 安装、LDAP、Full 与断网分组下载同一份 `acceptance-runtime`，各自使用独立数据库和临时目录。Full 分布式验收改为 CI 调用的可复用工作流，删除与原系统矩阵完全重复的 `browser-distributed` 调用；四个 Full 分区和所有既有场景保留，500 槽位和 Full 分布式结果均纳入 CI gate。手动启动 Full 分布式验收也只构建一次。

正式发布先完成双架构镜像，amd64 作业从刚验证过的镜像提取 Web、Worker、Agent、Jenkins 插件和离线查看器，供后续 `Release checks` 复用；没有再次执行 Next、Worker 或内置资源构建。`Published Release acceptance` 继续下载并核对签名后的正式离线包，验证实际容器、升级、回滚和断网路径。两个 CPU 架构仍使用原生 runner 独立构建，不把 amd64 代码直接放入 arm64 镜像。

还原时显式保留归档中的文件权限，避免普通用户的 umask 改变校验结果；从镜像提取时先复制完整 `/app`，让 Next 的相对模块链接始终位于同一应用目录内，再筛选所需构建文件。

共享产物有逐文件 SHA-256、可执行位、符号链接、源码摘要、Git 提交、Node 精确版本、ABI 和架构清单；消费者校验后才启动。校验失败直接失败，不偷偷重建或使用别的提交。发布事件还核对 tag 与构建提交，并通过原始 Release run ID 下载产物。手动从新分支复验历史版本时不套用旧产物，保留源码独立构建路径。

产物不包含 `.next/cache`、开发输出、平台配置、凭据或测试数据库。编译缓存通过独立的 Next 缓存保存；pnpm 使用操作系统、CPU、Node 主版本和 lockfile 区分内容存储，安装仍使用 `--frozen-lockfile`。Full 的固定 NATS／MinIO 工具仅准备一次，按内容摘要缓存和分发，使用前仍核对原始固定 SHA-256；缓存损坏不会被当作可执行文件使用。

CI gate 的作业摘要汇总累计 runner 运行分钟和最慢作业，不将排队时间计作运行成本。2026-11-08 的优化前基线为 CI 265.8 分钟、独立 Full 46.2 分钟，共约 312 runner 分钟；优化后的实际节省应以相同范围的完整流水线报告为准。长时间的混合负载和故障恢复检查仍完整执行，不以延长超时、跳过断言或整场景重试降低失败率。

失败定位后优先使用 `gh run rerun RUN_ID --failed` 只重跑失败作业，已通过的构建和其他检查继续复用，不重新触发整套 CI。诊断附件带 `run_attempt`，保留各次证据；同一运行中的内部构建附件允许更新，正式 Release 资产及 tag 的不可变规则不变。

本地默认命令继续按源码构建。排查 CI 产物复用时，可在还原归档后运行：

```bash
node scripts/quality/acceptance-build.mjs verify
AUTOFORGE_ACCEPTANCE_PREBUILT=1 node scripts/quality/prepare-acceptance-build.mjs web
```

手动标记预构建不会绕过校验；缺失、损坏或源码不匹配均拒绝启动。

## 发布条件

当前正式发布线从 `v1.22.0` 开始，后续默认小版本按 `v1.22.1`、`v1.22.2` 递增，不再新增 `v1.21.x` 版本；切换下一发布线时另行明确版本号。既有版本和不可变 tag 保留。

正式版本必须使用 `vX.Y.Z` 形式的语义版本 tag。推送 tag 先触发 `Release`；成功完成后再触发 `Release checks` 与 `Published Release acceptance`，不在测试 Job 内轮询未完成的发布。手动发布时，GitHub 的 “Use workflow from” 和 `Release` workflow 的 `tag` 输入必须指向同一个 tag，保证源码提交、构建来源证明和 Release 一致；源码检查和发布资产验收都可以从默认分支手动启动，并通过 `tag` 输入选择要复验的版本。手动发布资产复验使用所选默认分支 revision 的验收工具检查不可变 Release，允许在不改写历史 tag 的前提下修复验收工具。

只有用户明确要求“最快路径”时，才采用仅 Release 的快速发布：复用已完成的定向验证，在变更说明中列出未运行的完整验收，发布提交使用 `[skip ci]`，再从对应不可变语义 tag 手动启动 Release。为避免标签源码检查与发布完成事件展开标准矩阵，可临时停用 `Release checks`、`Published Release acceptance`，先记录原状态，发布成功、失败或中断后都恢复原状态。不得永久停用检查或修改工作流断言；双架构构建、镜像启动、内置资源、SBOM、签名和资产完整性仍由 Release 保留。

发布资产验收通过 `node scripts/release/download-assets.mjs TAG DIRECTORY [ASSET_PATTERN ...]` 下载文件：先按 tag 解析已公开 Release 的 ID，再分页读取独立的资产列表接口，避免刚发布时 tag 响应内嵌资产列表为空导致误报“无资产”。下载使用资产 ID，检查文件名及字节数，失败清理临时文件；后续签名、SHA-256、清单和离线闭环校验保持必需。多个文件模式取并集，全部不匹配时明确失败。

```bash
git tag -s v0.2.2 -m "AutoForge v0.2.2"
git push origin v0.2.2
```

`Release` 只保留发布所需的关键路径：校验 tag 后构建一次 CoTest Adapter，两个 CPU 架构复用该内部制品并行构建，随后组装部署包、生成 SBOM/清单、签名、生成来源证明并公开 GitHub Release。两个原生后端构建机在组装镜像前使用固定 Node 24 和 frozen-lockfile 安装依赖，以编译内置 Go 查看器的离线前端；构建期获取依赖不引入产品运行期网络要求。后端构建使用按 variant 隔离的 GitHub Actions BuildKit 缓存，离线 Docker 归档直接发布 Docker 原生 tar，目标机不需要额外安装 zstd；不再构建耗时的 `toolchain-amd64/arm64` Release 资产。任一架构、SBOM、签名或清单失败仍会阻止发布，因而不会公开缺少必需资产的部分 Release。

Release 附件逐个上传，每次最多等待 180 秒，超时后最多再留 10 秒结束进程；失败最多尝试三次，
重试前分别等待 5 秒和 10 秒。任一附件持续失败会明确输出文件名并终止发布步骤，新 Release 保留为
草稿。只有全部附件上传成功后才公开，避免 GitHub 资产接口故障时长时间卡在批量上传中。

`Release checks` 将格式/lint/类型、单元/集成、性能、构建、Full 场景和断网 Lite 场景拆成独立矩阵并行执行。`Published Release acceptance` 只在发布完成后启动，将资产签名、业务、真实 Agent、真实离线 LDAP、备份恢复、上一正式版本升级和注入迁移失败回滚拆成隔离分区；一般测试 Job 以五分钟内完成为目标，八分钟超时为托管 Runner 抖动保留诊断空间。资产生命周期分区覆盖完整任务生命周期、JAR 导入和项目隔离，使用十二分钟的有界预算，包含新增任务删除检查及关闭服务、收集诊断所需的时间；断网 Lite 的操作与部署分区包含 31 个浏览器场景、生产构建、备份恢复和部署检查，同样使用十二分钟作业预算；单项测试时限保持不变。其余分区沿用各自预算，不跳过测试或增加浏览器重试。两类检查都不属于 `Release` 的依赖，不会阻塞、取消或撤回发布；产品缺陷应通过问题修复和新版本 hotfix 处理。普通 CI 与依赖安全 workflow 不在 tag push 上重复运行，以免与发布矩阵争抢并发资源。

浏览器验收保持 `retries: 0`，失败不会自动重跑整个场景。管理员初始化的公开只读探针仅对
`ECONNRESET` 允许一次连接恢复，整个请求最多等待 10 秒；HTTP 错误、无效响应和持续断连仍使测试
失败，登录、引导写入和业务修改不随之重试。Playwright 的 HTTP 连接池跨请求上下文复用，前一场景
留下的空闲连接可能恰在下一场景借用时关闭；此行为由本地真实 HTTP 故障注入测试覆盖。

Full 适配器及分布式基础设施契约按测试文件串行执行：各文件虽使用独立 PostgreSQL schema，
建库迁移仍共用数据库级 advisory lock，并行启动夹具只会增加锁等待，可能耗尽单项测试原有的
5 秒预算。测试内部的并发、事务、竞争和恢复场景继续运行，不增加测试超时或自动重试。
此调整仅属于验收工具，可从默认分支复验既有不可变版本，不需要重建已发布镜像或改写 tag。

Full 浏览器验收通过 `AUTOFORGE_E2E_PLATFORM_CONFIG_DIR` 传递平台配置目录，日志数据库场景据此读取测试部署连接信息；`AUTOFORGE_E2E_DATA_DIR` 仍只用于 Lite 的 SQLite 历史夹具，两者不能混用。公开进展断言只定位可见卡片，避免 Next.js 流式渲染的隐藏副本造成严格匹配冲突；分页导航的 URL 等待显式限制为 30 秒，失败时保留诊断，不能无限等到作业总时限耗尽。

普通 CI 的 Full 容量/性能与适配器契约使用独立矩阵分区，各保留默认 8 分钟作业预算；
避免同一作业串行累加容量、性能及全部契约后，在测试已通过时因总预算耗尽被取消。
`test-full.sh contracts` 继续聚合两组检查，`capacity-contracts` 与 `adapter-contracts`
分别运行原有函数，既有完整验收命令及所有用例、断言和单项超时保持不变。

版本初始化验收在服务端返回 `503 PLATFORM_BUSY` 时，通过页面原有“继续继承”恢复暂停进度；
仅重试这一种写入前的优先级让步，其他 HTTP 错误立即使验收失败。等待采用 15 秒有界预算，
覆盖平台五秒退让窗口与下一次 UI 请求；注入连续限流响应验证恢复及任务不重复创建，不增加 Playwright 整场景重试或放宽产品保护。

异步目录验收在 30 秒内等待目录实际可见，不能把“任务配置保存成功”当作后台快照已完成。
批次对比在浏览器实际提交表单、React 处理之前记录滚动基准，再等待刷新响应、结果绘制以及连续
动画帧后比较。测试会注入短暂按钮位移，覆盖 Playwright 因元素不稳定而重试点击并自动滚动的情况；
测试驱动在点击前的定位不属于页面提交后的滚动变化。此修复不改变产品的滚动或布局逻辑。

普通 CI 的 Full／断网 Lite 资产及治理分区使用有界的 15 分钟预算，包含依赖安装、三个平台的查看器首次编译、生产构建与完整浏览器场景。两个资产分区在原 12 分钟时已通过前十五个场景，整作业期限不足时会中断尚在执行的剩余场景；单项测试期限和断言保持不变，不增加浏览器重试。

大 JAR 的 UI 选择使用测试输出目录中的真实文件路径，避免将同一份 48 MiB 内容反复通过浏览器协议编码传输；真实 HTTP 上传、体积边界、扫描与导入仍使用完整原始内容。

已发布离线包验收失败时，清理容器前将各平台容器最近 400 行日志、退出状态、OOM 标志和健康状态
保存到 `test-results/release-services/<分区>/`，由既有失败诊断附件上传。日志包含 stdout/stderr，
会脱敏夹具配置中的秘密；配置不可读取时省略原始日志，仅保留状态，不导出完整 Docker inspect、
环境变量或数据库。每次诊断命令最多 5 秒，采集失败不覆盖原验收退出码。启动就绪探测在 90 秒后
停止发起新请求，每次连接最多 1 秒、请求最多 2 秒，避免服务失联时无限等待。

`amd64` 目标运行在 `ubuntu-24.04`，`arm64` 目标运行在 GitHub-hosted 原生 `ubuntu-24.04-arm`。后端不使用 QEMU 做跨架构模拟；内置 Agent 由 Go 原生交叉编译为两个静态架构，并在每个镜像中校验资源清单。

Web 进程为同源终端 WebSocket 使用 Next.js 自定义 Server。发布构建先将自定义 Server 与迁移入口打成生产 bundle，再合并 Next.js 生成的依赖追踪清单；运行时镜像只复制追踪到的生产模块、数据库迁移、静态资源和双架构 Agent。`.next/cache`、源码映射、本地数据、测试产物与开发依赖不会进入镜像。该方案保留常规 Next.js 生产运行时而不启用不兼容自定义 Server 的 `standalone` 模式；镜像验证会实际启动 Web、执行 SQLite 迁移并检查 Agent，防止瘦身遗漏运行时依赖。

系统诊断的 AutoForge 版本来自镜像构建参数 `VERSION`，并同时记录 `REVISION` 和 `CREATED`；构建器
在编译 Next.js 之前生成版本元数据，浏览器、离线镜像和镜像标签使用同一份发布标识，不再使用工作区
`package.json` 的包版本。未经过发布构建的源码运行显示“开发构建”。版本读取不依赖运行时联网、Git
目录或 Runner 安装资源；本地镜像构建默认使用当前 Git 提交，显式提供提交号时需使用完整 40 位 SHA。

## 资产矩阵

每个版本包含以下两个 CPU variant：

| Variant | CPU     | 后端用户空间   | 内置 Agent                                      |
| ------- | ------- | -------------- | ----------------------------------------------- |
| `amd64` | x86-64  | Debian / glibc | Linux amd64 + arm64，静态且兼容 glibc/musl 主机 |
| `arm64` | AArch64 | Debian / glibc | Linux amd64 + arm64，静态且兼容 glibc/musl 主机 |

Docker/OCI 镜像携带自身用户空间，宿主机使用 glibc 还是 musl 不改变镜像选择；Alpine 宿主也只需按
CPU 架构导入上述归档。Agent 直接在执行机宿主运行，因此构建时额外验证 `CGO_ENABLED=0`、静态链接、
ELF 无程序解释器和动态库依赖，不需要复制一份仅有 `musl` 后缀的相同二进制。

每个 variant 只发布一个用户需要下载的运行资产：

- `autoforge-backend-VERSION-VARIANT.docker.tar`：可由 Docker 直接导入的离线镜像归档；
- Docker config 内容摘要形式的不可变 image ID、平台和 OCI 标签统一记录在
  `release-manifest.json#backendImages`，不再为每个平台发布零散的 `image.json`。

每个版本还生成一份 `autoforge-deploy-VERSION.tar.gz`，其中包含 Lite、单机 Full、通用分布式及
`full-five-hosts/` 五主机方案的 `docker-compose.yml`、环境模板、Nginx IP 配置、凭据生成器、
运维脚本、许可证和部署所需手册。五主机目录提供三个主平台、一台 Nginx 和一台集中基础设施
的完整文件；打包时检查文件齐全并替换后端镜像版本，排除实际配置、密码和数据。不携带设计图、归档审计、
roadmap 或内部实现资料。`autoforge-release-metadata-VERSION.tar.gz` 集中保存两个架构镜像、
部署包的 SPDX JSON SBOM（镜像 SBOM 同时覆盖内置的两个 Jenkins HPI），以及 `LICENSE`、`NOTICE`、第三方许可证清单、
兼容矩阵和变更记录。SBOM 内容没有删除，只是不再平铺为多个顶层 Release 资产。

Release 根目录同时包含 `release-manifest.json`、`SHA256SUMS`、Ed25519 签名
`SHA256SUMS.sig` 和 `release-signing-public-key.pem`。GitHub 的构建来源证明绑定
`SHA256SUMS` 中记录的全部资产摘要，metadata 包内的文件由该归档摘要传递保护。

部署包另提供 `fast-deploy/` 三机 Full 快速部署目录，固定 amd64，直接提供三份 Compose 和
环境模板，不要求运行生成或部署脚本；首次通过平台 `/setup` 配置 Full。打包只复制明确列出的
模板并填入当前版本，不收录私有 `.env`、密码或本地数据。源码使用说明见仓库根目录
`fast-deploy/README.md`，解压部署包后可直接使用同名目录。

后端镜像内同时包含可校验的 CoTest Adapter JAR。该 JAR 由发布流水线固定使用 JDK 8 编译并验证
Java 8 字节码，同时在 CI 中复验 JDK 21 + TestNG 7.11.0；不为不同 JDK 重复发布 Adapter。
正式 Release 不提供 JDK/TestNG 工具链资产；管理员在项目设置中上传彼此兼容的 JDK 与完整依赖
JAR 压缩包，或登记主平台可访问的内网 HTTP(S) 链接、精确大小和 SHA-256。部署包仍生成对应的
SPDX JSON SBOM。

Jenkins 插件从任务页面的“执行接入”下载，不再单独发布 HPI。发布时先构建、验证插件并生成 `resources/jenkins/manifest.json`，两个后端镜像内置同一份受校验资源；本地构建镜像也必须先准备同版本插件资源。`release-manifest.json` 从此变更起使用 schema 4；历史 schema 1/2/3 验收继续按原资产集合处理。

从 v1.21.2 起，两个后端镜像还内置 Windows x86_64、Linux x86_64／arm64 三份静态 Go 日志归档查看器及离线 Ant Design 前端／许可清单；不新增独立 Release 资产。构建前生成资源并记录版本、源摘要和逐文件 SHA-256，打包前后验证完整性。归档生成时直接使用这些资源，不要求部署环境安装 Go 或联网获取前端文件。

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

必须持久化 `/var/lib/autoforge`；删除该卷会删除 Lite 数据库和本地对象。

首次启动从容器日志或数据卷的 `/var/lib/autoforge/config/initial-admin-token` 获取管理员令牌。登录后先在“平台配置”设置执行机可访问的 HTTP 或 HTTPS 地址；可信内网可填写 `http://内网IP:端口`，其他网络应使用 HTTPS。再在“执行机”页面填写 IP/主机名、SSH 用户和密码。平台会探测系统与架构并显示 SSH 主机指纹；管理员通过可信渠道核对后才能安装。首次安装或手动更新成功后，平台以主密钥 AES-256-GCM 加密保存连接档案，供后续单机或批量更新复用；API 不返回密码或私有 CA 明文。Agent 注册仍使用短期一次性令牌。

自动安装要求目标机为 Ubuntu 或 openSUSE、使用 systemd，并预置 SSH、Bash、coreutils；非 root SSH 用户还需已有 sudo。cgroup v2 可用时自动启用，缺失时 Agent 以降级隔离运行。服务默认使用专用账号，也可由管理员显式选择 root 模式。openSUSE 被 `/etc/os-release` 报告成 SLES 等无法自动判断时，可在核验主机后手动强制选择 openSUSE 安装模式。安装脚本不会调用系统包管理器或下载依赖。Agent 安装包内含 Adapter；任务提供 JDK 与 JAR 资源时无需预置本机 Java/TestNG。

## 标准验收与当前产品交互

CI 的运维浏览器矩阵按配置／归档与运行资源两组执行，原八个场景文件各保留一次，继续串行浏览器、零重试和原作业期限；避免构建、39 个场景与证据上传挤在同一个作业中。使用固定业务名或完成凭据的长链路复验应启动全新的测试数据库，保留失败现场；重复利用旧库会制造与产品修改无关的唯一约束或选择器多匹配错误。

三组 UI 分片各保留完整场景及 30 秒操作期限，作业期限设为 20 分钟，包含源码／Agent 构建和截图上传。一次验收已在 15 分钟期限前通过全部 21 个场景，仍被整体期限取消；增加的是构建与证据收尾余量，不延长单次交互等待，也不跳过失败断言。

Full 的 500 槽位混合后台验收包含 73 个浏览器场景，场景执行约 22 分钟，另需构建、基础设施启动和证据上传；该作业保留 40 分钟总期限，其他分布式验收仍为 25 分钟。测试用例、并发与失败检查保持原范围。

Full 验收的 NATS 2.14.3／MinIO RELEASE.2025-04-22T22-12-26Z 使用固定 GitHub Release 资产 ID 下载，继续校验原 SHA-256，避免版本下载页网关持续 504。临时网关故障最多重试 3 次，重试预算 120 秒；404 等永久错误和 SHA-256 不匹配直接失败。下载只写临时文件，校验通过后才替换目标，不把错误页或残缺文件作为后续验收输入。

系统验收各分组默认总期限为 15 分钟，覆盖冷环境 Node／Go 工具链下载回退、依赖安装、构建、测试及证据收尾。此前 8 分钟的期限会在测试持续通过时直接取消 Full 恢复和适配器组；单项测试的超时与性能断言不随作业期限放宽。

包含 35 个场景和 Compose 检查的离线运维组使用 20 分钟总期限；发布后治理验收为 15 分钟，资产组仍为 12 分钟，其他发布后分组仍为 8 分钟。此前发布后治理组已出现整体期限取消，因此需同时覆盖源码与发布资产两条验收入口。

验收应通过真实业务边界等待，不重试整个测试：批跑创建仅确认快照与调度消息已持久化，仓储集成测试显式推进调度后再检查 assignment；执行页默认总结，用例、执行机和日志操作先打开明细窗口，轮次切换和全局操作先关闭明细。手动日志终态等待页面自身的 `/manual-state` 响应或终态按钮就绪，再检查完整刷新结果（控制操作引起的服务端刷新可能先于轮询完成），避免将五秒状态轮询与五秒断言期限叠在同一边界。

跨账号夹具登录从明确的默认入口开始，退出操作等待真正的登录表单，避免把上个账号的项目返回地址带给新账号后与下一次导航竞争。保留来源地址的业务场景直接操作登录／注册表单并验证返回路径，不由夹具登录代替。

Full 分布式验收同时验证共享 PostgreSQL 新日志和旧节点本地日志：新日志在单个 Web 节点停机后仍可读取且不生成 SQLite 文件，历史本地日志只读并保留原归属节点的不可用及恢复检查；不通过恢复 Full 本地写入来满足旧夹具。Full 对象内容验证读取 MinIO，Lite 读取本地对象端口；归档分卷夹具使用明确超过目标的逻辑日志字节数，不以 SQLite 页分配大小代表 PostgreSQL 统计。匿名接口扫描区分公开只读、独立协议凭据及必须登录的修改接口，私有读取和公开修改均在查询资源前验证登录。页面截图与控件大小、溢出和碰撞检查仍保留。

## 本地构建与验证

单个平台可使用与 CI 相同的脚本构建。后端需要 Docker Buildx、Go 1.26.x、`file` 和提供
`readelf` 的 binutils；构建脚本会先生成两个内置 Agent 资源并验证其没有 libc 运行时依赖：

```bash
SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION="$(git rev-parse HEAD)" \
  bash scripts/release/build-backend-image.sh 0.2.2 amd64 dist/release

SOURCE_DATE_EPOCH=0 \
  bash scripts/release/build-deployment-bundle.sh 0.2.2 dist/release
```

正式构建由 GitHub Actions 固定 Node、Go、pnpm、基础镜像 digest、Action commit 和 Syft 版本。
每个架构构建还会在固定摘要的 Alpine/musl 用户空间中实际运行内置 Agent 的 `version` 命令；
该镜像仅是构建期兼容性夹具，不作为 Release 资产发布。构建阶段可以获取锁定依赖；生成的运行时
镜像和其中的 Agent 在离线运行时不会下载依赖或发送遥测。

构建脚本默认限制单个 Docker 原生归档不超过 180 MiB，避免构建缓存或开发依赖再次进入正式镜像。特殊诊断构建可通过 `AUTOFORGE_BACKEND_IMAGE_MAX_BYTES` 临时调整预算；正式发布不得仅为绕过体积回归而提高该值。

源码 E2E 构建在 WebServer 的启动计时前准备内置 Jenkins 资源；断网 Lite、真实 Agent 与容器执行器验收在进入网络命名空间前准备 HPI。UI 验收先用 Java 8 构建 Adapter，再切换 Java 21 准备 Jenkins 插件；断网后只消费已校验资源。发布资产的 metadata 解包复用清单版本常量，并保留 schema 1/2/3 兼容，避免新版资产在解包阶段被旧分支拒绝。

离线日志查看器也在上述构建准备阶段生成：首次跨平台 Go 编译不占用 Playwright 的 120 秒服务启动期限，进入断网命名空间后只校验和复用已有资源。缓存命中不重复编译，启动期限与浏览器重试规则保持不变。
