# Runner Agent 架构设计

状态：Go Runner Protocol v1 的注册、资源心跳、任务领取、lease 续期、reconcile、权威测试/依赖 JAR 获取、TestNG 类/方法执行与参数注入、cgroup v2/rlimit 资源限制、日志 spool/确认重传、安全产物上传、完成上报和可选直连终端已实现；新版本不可变 Release 资产的 Gate E 实机记录仍须在打标签后完成。

本文中的 **Runner Agent** 指安装在执行机上的 AutoForge 守护进程，不是参与仓库开发的编码代理。Runner Agent 从控制面领取执行任务，以受控子进程运行命令，采集日志和产物，并上报执行结果。

当前 `apps/runner-agent` 使用 Go 1.26.x，实现了构建信息、集中配置诊断、版本化本地执行规格、可执行文件白名单、独立工作目录、三路有序日志、有界 spool、超时和 Linux 进程组清理。`start` 支持 bootstrap 注册、受限权限身份存储、认证资源心跳、assignment claim、lease 续期、启动 reconcile、日志/产物上传、完成上报和可选的出站终端 WebSocket。`run-once` 是执行核心的诊断入口，不会领取平台任务。

## 目标

- 同一 Runner Agent 同时兼容 Lite 和 Full，Agent 不感知服务端使用 SQLite 还是 PostgreSQL/NATS/MinIO/Redis。
- 只需从执行机主动访问 AutoForge 控制面，不要求服务端反向连接执行机。
- 正确处理重复交付、网络中断、Agent 崩溃、控制面重启、取消和超时。
- 命令、环境变量、工作目录、日志和产物具有明确安全边界。
- 安装包可离线分发、升级和回滚，不在运行时下载依赖或自动更新。

## 非目标

- 首版不宣称能够安全运行任意不可信代码。
- Runner Agent 不直接访问业务数据库、NATS、Redis 或 MinIO 长期凭据。
- Runner Agent 不承担全局调度和结果分析。
- 本地 spool 不是权威数据源，不能替代控制面记录。

## 拓扑

```mermaid
flowchart LR
    UI[Web UI] --> API[Control API]
    API --> APP[Application Services]
    DISPATCH[Dispatcher Worker] --> APP
    DISPATCH --> QUEUE[JobQueuePort]
    APP --> DB[DatabasePort]
    APP --> OBJ[ObjectStorePort]

    AGENT[Runner Agent] -->|HTTP(S): register / claim / renew / report| API
    AGENT -->|WSS: optional terminal channel| API
    UI -->|WSS: short-lived terminal session| API
    AGENT --> PROC[Child Process]
    PROC --> LOG[stdout / stderr]
    PROC --> FILES[Artifacts]
    LOG --> AGENT
    FILES --> AGENT
    AGENT -->|chunked logs / result| API
    AGENT -->|controlled upload target| OBJ
```

Agent 与控制面使用稳定的 Runner Protocol。Full 的 JetStream 和 Lite 的 SQLite 队列只位于控制面内部：

1. 调度消息驱动 Dispatcher 选择 Runner，并持久化可领取的 assignment。
2. assignment 持久化成功后，Dispatcher 才确认调度消息。
3. Runner Agent 通过控制协议原子领取 assignment 并获得有期限的 lease。
4. Agent 续租、上报日志和结果；控制面决定唯一终态。

这样不会让一个 JetStream 消息在长时间用例执行期间保持未确认，也不会把 NATS 凭据分发到所有执行机。

## 组件边界

### 控制面

- **Scheduler**：根据优先级、项目策略、Runner 标签、能力和剩余容量产生调度意图。
- **Dispatcher**：消费调度任务，选择候选 Runner，创建可领取 assignment。
- **Runner Gateway**：处理注册、心跳、领取、续租、取消、日志和完成上报。
- **Artifact Service**：校验产物声明并生成受控上传目标。
- **Reconciler**：回收过期租约，处理失联 Agent、孤儿任务和清理任务。

### Runner Agent

- **Identity Manager**：注册、保存 Runner 身份、轮换访问凭据。
- **Capability Probe**：上报 OS、架构、Agent/协议版本、执行器和自定义标签。
- **Claim Loop**：有界长轮询领取任务，空闲时退避。
- **Lease Manager**：独立于心跳续租，并接收取消/排空指令。
- **Workspace Manager**：准备隔离工作目录、输入文件和清理策略。
- **Process Supervisor**：启动命令、限制资源、处理超时和终止进程树。
- **Log Pipeline**：读取、脱敏、编号、缓冲和重传 stdout/stderr。
- **Artifact Collector**：按声明收集文件，校验路径、数量、大小和校验值。
- **Local Spool**：网络中断时有界保存尚未确认的日志、结果和上传状态。

## Runner 生命周期

```text
unregistered -> registering -> online -> draining -> offline
                      |           |
                      |           -> disabled
                      -> incompatible
```

- 首次安装使用一次性 bootstrap token 注册，成功后换取绑定 Runner 的可轮换凭据。
- `online` 表示控制通道健康，不表示某个执行租约仍有效。
- `draining` 停止领取新任务，已有任务在时限内完成。
- 服务端禁用后，Agent 不得继续领取或执行任务。
- Agent/协议版本不兼容时进入 `incompatible`，界面提供明确升级提示。
- Agent 通过 `POST /api/v1/runner-agents/{runnerId}/credentials/rotate` 轮换凭据（CLI `autoforge-agent rotate-credential`）：控制面签发新凭据并递增 `credentialVersion`，旧凭据保留 15 分钟宽限期，Agent 保存新身份失败时可用旧凭据安全重试；宽限期内新旧凭据均可通过认证。
- 管理员可在执行机列表撤销凭据（`credential_revoked_at`）或注销执行机（`deregistered_at`）：两者都会立即使全部 Runner Protocol 认证失败，注销还会禁用执行机并把活跃租约立即到期，由统一的过期回收重新排队。

## 一次执行的流程

```text
claim -> prepare -> start -> stream logs -> collect artifacts -> report result -> cleanup
                 |                    |
                 -> cancel/timeout ---+
```

1. Agent 长轮询领取 assignment；控制面原子创建 `RunAttempt` 和 lease。
2. Agent 校验 `ExecutionSpec`、协议版本、执行器、资源上限和本机能力；含密文引用时使用有效 lease 按需领取。
3. Workspace Manager 创建本次 attempt 的独立目录并准备输入，密文只合并到本次内存执行规格。
4. Process Supervisor 使用参数数组启动子进程。
5. Lease Manager 定时续租；Log Pipeline 并行采集 stdout/stderr。
6. 取消、租约失效或超时触发进程树终止。
7. Artifact Collector 只收集白名单路径下与声明匹配的文件。
8. Agent 上报退出信息、结构化结果和产物清单。
9. 控制面以带版本的条件写确定终态；重复完成上报返回相同确认。
10. 得到服务端确认后清理本地 spool 和工作目录。

## Runner Protocol

任务协议基于 HTTP(S) JSON，任务领取使用有界长轮询；可信内网允许 HTTP/IP 直连，跨不可信网络应使用 HTTPS，因为 HTTP 不保护 Runner 凭据、任务、日志和密文注入流量。WebSocket 不参与任务执行正确性。当前 WebSocket 只承载管理员显式打开的交互终端，断开即终止对应 PTY，会话不能转化为 assignment 或 lease。

协议端点：

| 方法与路径                                                      | 用途                                             |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `POST /api/v1/runner-agents/register`                           | 使用 bootstrap token 注册                        |
| `POST /api/v1/runner-agents/{runnerId}/heartbeat`               | 上报在线、容量和能力摘要                         |
| `POST /api/v1/terminal-sessions`                                | 登录用户按独立 RBAC 权限换取 30 秒一次性终端票据 |
| `WS /api/v1/terminal-stream`                                    | Agent 出站通道与同源浏览器浮窗的有界终端中继     |
| `POST /api/v1/runner-agents/{runnerId}/claims`                  | 长轮询并原子领取 assignment                      |
| `POST /api/v1/runner-agents/{runnerId}/leases/{leaseId}/renew`  | 续租并获取取消/排空指令                          |
| `POST /api/v1/run-attempts/{attemptId}/logs`                    | 批量上报日志块                                   |
| `POST /api/v1/run-attempts/{attemptId}/secrets`                 | 使用有效 lease 按需领取本次执行密文              |
| `POST /api/v1/run-attempts/{attemptId}/artifacts`               | 声明产物并获取上传目标                           |
| `POST /api/v1/run-attempts/{attemptId}/artifacts/{id}/finalize` | 复核 Full 直传对象并确认产物元数据               |
| `POST /api/v1/run-attempts/{attemptId}/complete`                | 幂等上报最终结果                                 |
| `GET /api/v1/run-attempts/{attemptId}/events`                   | 登录用户按执行读取权限分页查询状态时间线         |

Runner 端点使用版本化契约和 Runner 身份；浏览器查询端点使用登录会话与服务端 RBAC。协议 v1 允许补丁版本只新增可选字段，旧 Agent 与旧 Server 会忽略未知字段；删除字段、改变既有字段语义或类型属于破坏性变更，必须提升 `schemaVersion`。服务端协商和 Agent 响应解析都会明确拒绝非 v1 版本。兼容测试同时覆盖新 Agent 请求到旧 Server、旧 Agent 接收新 Server 响应，以及同一 Agent HTTP 客户端分别连接 Lite 与 Full 控制面。

### ExecutionSpec

任务契约至少包含：

```ts
type ExecutionSpec = {
  schemaVersion: 1;
  executionRunId: string;
  batchId: string;
  attemptId: string;
  executor: "testng";
  runtimeRequirements: {
    os: "linux";
    architectures: Array<"amd64" | "arm64">;
    minimumJavaMajorVersion: number;
    testNgVersion: string;
  };
  inputs: Array<{ inputId: string; kind: "test-jar" | "dependency-jar"; sha256: string }>;
  requiredLabels: string[];
  requiredCapabilities: string[];
  secretReferences: Array<{ name: string; secretId: string; secretVersionId: string }>;
  resourceLimits: ResourceLimits;
};
```

当前执行快照固定要求 Linux `amd64/arm64`、Java 11+、TestNG 7.11.0 和 `executor:testng-v1`；含密文引用时额外要求 `secrets:on-demand-v1`。`isolation:cgroup-v2` 不再是 assignment 硬要求，服务端解析旧 v1 快照时会移除该已退役要求，避免升级前排队任务永久无法领取。控制面只在 Runner 身份和 attempt lease 同时有效、密文项目/版本/状态匹配时返回值，成功解密后记录不含值的访问审计。Agent 校验响应名称与大小，只保留在内存和子进程环境中；`ExecutionSpec`、持久 claim、日志和 spool 不保存明文秘密。Go 字符串不能保证主动清零，因此这里不声明硬件级或可验证的内存擦除。

## 命令执行

默认执行器为 `process`，仅用于受信任执行机上的受信任用例：

- 使用 `spawn(executable, args, { shell: false })`，不得拼接 Shell 字符串。
- `cwdRelative` 必须解析在当前 attempt 工作目录内，拒绝绝对路径和路径穿越。
- 服务端与 Agent 双重校验可执行文件策略、参数数量、环境变量名和资源上限。
- 复杂脚本作为带 SHA-256 的输入产物下发，再通过明确解释器执行，例如 `bash script.sh` 或 `powershell -File script.ps1`。
- Shell 执行器默认禁用；如未来提供，必须由 Runner 本地策略显式允许，不能由任务自行开启。
- 超时或取消先发送温和终止信号，经过短 grace period 后强制清理整个进程树。
- Agent 默认以专用非特权账号运行；管理员可为专用、受控内网执行机显式选择 root 模式，部署文档必须说明扩大后的主机访问边界。

TestNG 方法选择器使用 `methodName+JVM descriptor` 的规范形式，例如 `checkout(Ljava/lang/String;)V`。非空方法选择或参数快照会启用随 Agent 二进制内嵌的 Java source-file launcher；launcher 通过 reflection 计算真实 descriptor，并以 TestNG `IMethodSelector` 保留配置方法、精确选择测试方法。launcher 与用户 JAR 均通过固定 Java executable 和参数数组启动，不调用 Shell、`javac` 或网络下载。

TestNG 输入固定为一个 `test-jar` 和最多 127 个 `dependency-jar`。每项输入都引用服务端管理的权威对象，并在 assignment 快照中固化 ID、相对 `.jar` 目标路径、大小和 SHA-256；控制面先验证 Runner 身份与有效 lease，再确认输入确实位于快照且权威元数据未漂移。Agent 在发起下载前校验输入总大小、attempt 磁盘上限和工作目录可用空间，逐项通过同一控制面端点下载并原子发布。classpath 顺序固定为测试 JAR、按目标路径排序的依赖 JAR、Runner 预置 TestNG 工具链，不向 Agent 下发数据库或对象存储长期凭据。

CoTest Adapter assignment 另外允许一个 `jar-bundle` 和一个可选 `jdk-archive`。项目保存这些
资源，任务保存 Adapter 开关、Suite/Test 与环境地址列表；批次按用例顺序轮询环境地址并固化每个
run 的值。Runner 在 attempt 配额内安全解压依赖包到 `test-jars`，主测试 JAR 发布为
`test-jars/autoforge-case.jar`，Adapter 自动扫描根目录及三层子目录中的全部 JAR。上传端采用流式
暂存和对象写入，不设固定业务大小上限；Runner Protocol 的磁盘上限、按输入动态计算的展开预算、
文件数预算和底层存储配额仍是不可绕过的安全边界。

资源隔离只在 cgroup v2 委派经过 doctor 验证后上报 `isolation:cgroup-v2` capability。Agent 为每个 attempt 创建子 cgroup，先写 `cpu.max`、`memory.max`、`memory.swap.max=0`、`memory.oom.group=1` 和 `pids.max`；内部包装进程再设置 `RLIMIT_FSIZE`、`RLIMIT_NOFILE`、`RLIMIT_CORE=0` 并加入 cgroup，完成父子握手后才 `execve` 用户 Java。超时、取消、资源超限和正常完成后的残留后代均通过 `cgroup.kill` 清理，旧内核回退为枚举 cgroup PID 后发送 `SIGKILL`。没有 cgroup v2 时，包装进程仍设置上述 rlimit，并使用进程组、超时和有界工作区扫描清理；CPU、内存和整个后代进程数量不具备 cgroup 等级的硬限制，因此仅适合可信执行负载。

工作目录总字节数和条目数使用 100ms 有界扫描监督，超限映射为独立稳定结果码。`RLIMIT_FSIZE` 可硬限制单个文件，但普通目录无法仅靠 cgroup/rlimit 获得严格的总容量配额，因此最多存在一个采样周期的瞬时超写窗口；严格磁盘隔离需要部署方提供专用文件系统或项目配额。进程模式仍不是完整沙箱：它不隔离网络，也不能阻止测试读取 Agent 服务账号本来可读的主机路径。

`container` 执行器是后续隔离选项。仅仅使用容器不能被描述为完整安全沙箱；网络、挂载、capability、用户、seccomp 和资源限制都必须显式配置。

## 日志协议

stdout 和 stderr 分开采集，每个日志块至少包含：

```ts
type LogChunk = {
  attemptId: string;
  stream: "stdout" | "stderr" | "agent";
  sequence: number;
  recordedAt: string;
  content: string;
  truncated?: boolean;
};
```

- `(attemptId, stream, sequence)` 是去重键；上传和服务端写入都按至少一次处理。
- 按字节而不是按行读取，使用流式 UTF-8 解码处理跨块字符。
- 建议在 `64 KiB` 或 `250ms` 任一条件达到时批量发送，最终值通过压测确定。
- Agent 在写本地 spool 前完成秘密脱敏；控制面再做第二层防护。
- 日志、完成结果和待上传产物共享 `AUTOFORGE_AGENT_SPOOL_MAX_BYTES` 硬预算；按最大并发预留最多一半预算给原子完成元数据，负载达到上限时以 `LOG_SPOOL_QUOTA_EXCEEDED` 或 `ARTIFACT_SPOOL_QUOTA_EXCEEDED` 明确终止，禁止静默丢弃。
- 服务端只确认连续序号；Agent 根据确认水位删除 spool 并重传缺口。
- 保留期只清理没有本地未决 attempt 的孤立日志；仍待 reconcile/确认的日志不会仅因时间到期而删除。
- ANSI 仅保存受控语义或原文，Web 展示必须白名单解析，禁止注入 HTML。

## 产物收集

- 产物规则相对 attempt 工作目录解析，拒绝绝对路径、`..`、设备文件和越界符号链接。
- 收集前检查数量和单项/总大小限制；计算 SHA-256 后再声明上传。
- Lite 返回单 attempt、单 artifact、受 lease 约束的控制面上传地址并流式写入本地 ObjectStore。Full 返回 15 分钟的单对象 MinIO 预签名 PUT；Agent 直传时不携带 Runner 或 lease 凭据，随后回到同源控制面 finalize。服务端重新读取对象并核对大小与 SHA-256 后才确认元数据，失败对象会被删除。
- Agent 只接收短期、单对象、限大小的上传权限，不持有 MinIO 长期凭据。
- 上传完成后由控制面校验大小和摘要，再把 Artifact 与 RunAttempt 关联。
- 即使没有匹配产物，Agent 也发送一次空产物声明；控制面用首次声明的服务端 UTC 时间标记上传收尾阶段，使进程重启后仍可独立裁决上传超时。
- 产物在首次上传前按服务端生成的 artifact ID 写入 `0600` 原子 spool 文件，attempt 状态记录逐项确认状态。Agent 重启后按 reconcile 决定续传；控制面确认完成结果后才统一删除日志、结果和上传文件。
- 必需产物缺失和可选产物缺失必须使用不同结果码。

## 租约、重复与恢复

- heartbeat 表示 Agent 活性；lease 表示某个 attempt 的执行权，二者不能互相替代。
- lease 续期使用 token 和版本条件，过期 Agent 不得继续提交普通进度。
- 网络分区期间 Agent 可在有限 grace window 内继续进程，但控制面一旦拒绝续租，Agent 必须停止执行并进入 reconcile。
- Agent 重启后先读取本地 attempt 清单，再向控制面逐项 reconcile；不得未经确认自行重跑。
- `complete` 接口幂等。相同结果重复提交返回原确认；冲突终态返回明确错误并保留审计记录。
- Reconciler 回收过期 lease 后可以创建新的 attempt，原 attempt 的迟到结果不得覆盖新 attempt。

## 本地目录

建议布局：

```text
AUTOFORGE_AGENT_DATA_DIR/
├── identity/                       # Runner 身份与受限权限凭据
├── work/<attempt-id>-*/            # 独立执行工作目录
└── spool/
    ├── logs/<attempt-id>/          # 待确认的有序日志块
    ├── attempts/<attempt-id>.json  # lease、完成结果和上传水位
    └── uploads/<attempt-id>/       # 待确认产物内容
```

目录权限遵循最小权限。spool 和 diagnostics 都必须有配额、保留期和启动时恢复策略；清理不得跟随越界符号链接。

## 配置草案

| 变量                                    | 说明                                  |
| --------------------------------------- | ------------------------------------- |
| `AUTOFORGE_SERVER_URL`                  | 控制面基础地址，必须显式配置          |
| `AUTOFORGE_AGENT_DATA_DIR`              | Agent 身份、spool 和工作目录根路径    |
| `AUTOFORGE_AGENT_NAME`                  | 用户可识别的执行机名称                |
| `AUTOFORGE_AGENT_LABELS`                | 调度标签，格式在契约中定义            |
| `AUTOFORGE_AGENT_MAX_CONCURRENCY`       | 本机最大并发，必须有安全上限          |
| `AUTOFORGE_AGENT_SPOOL_MAX_BYTES`       | 日志、结果和上传文件共享字节上限      |
| `AUTOFORGE_AGENT_SPOOL_RETENTION`       | 无未决 attempt 的孤立日志保留期       |
| `AUTOFORGE_AGENT_LOG_UPLOAD_BATCH`      | 单次日志上传块数，范围 1–256          |
| `AUTOFORGE_AGENT_BOOTSTRAP_TOKEN`       | 仅首次注册使用，成功后移除            |
| `AUTOFORGE_AGENT_CA_FILE`               | 私有 CA 文件，支持离线内网 TLS        |
| `AUTOFORGE_AGENT_ADAPTER_JAR`           | 内置 CoTest Adapter JAR 绝对路径      |
| `AUTOFORGE_AGENT_TERMINAL_ENABLED`      | 显式开启交互终端；默认关闭            |
| `AUTOFORGE_AGENT_TERMINAL_SHELL`        | 固定 Shell 绝对路径；默认 `/bin/bash` |
| `AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS` | 并发终端上限，范围 1–4                |
| `AUTOFORGE_AGENT_TERMINAL_MAX_DURATION` | 单会话时限，范围 1m–8h                |
| `AUTOFORGE_AGENT_LOG_LEVEL`             | Agent 自身日志级别，不影响用例日志    |

Agent 配置同样集中解析和校验，秘密不得出现在命令行参数、进程列表或日志中。

## 离线交付

- Runner Agent 与服务端发布版本建立明确兼容矩阵。
- GitHub Release 的四种后端镜像均内置 `amd64`、`arm64` Agent、安装脚本和 CoTest Adapter，不提供独立 Agent 或工具链 Release 资产。
- 两种 Agent 二进制均使用 `CGO_ENABLED=0` 静态编译，不依赖目标机 glibc 或 musl。
- 安装包包含运行所需代码与依赖，不在首次运行时下载浏览器、驱动或 npm 包。
- 用例确需浏览器/SDK 时，由管理员制作版本化 Runner 镜像或预置工具链，并通过 capability 上报。
- Agent 默认不自动更新；离线升级由管理员验证校验和后执行，失败可回滚上一版本。界面在内置资源版本高于执行机上报版本时给出“可更新”提示，管理员可通过 SSH 触发原地更新：复用安装链路的逐文件 SHA-256 校验与 `.autoforge-previous` 备份，执行机身份与历史记录保留；该路径不新增 Agent 下载端点，Agent 进程自身仍无权替换二进制（`ProtectSystem=strict`）。

## 安全模型

- Agent 仅信任明确配置的控制面地址和 CA，所有请求都带 Runner 身份并使用 TLS。
- bootstrap token 一次性、短时有效、最小权限；注册后使用可撤销和轮换的凭据。
- 控制面记录任务创建、调度、领取、命令摘要、取消、完成和产物审计，但不记录秘密值。
- 命令摘要包含 executable、参数的脱敏表示和输入摘要，支持追溯。
- Runner 本地策略可以收紧服务端任务，但不能放宽服务端限制。
- Agent API 需要速率限制、请求体上限、重放防护和稳定的幂等键。

## 测试要求

- 契约：相邻 Agent/Server 版本兼容、不兼容版本明确拒绝。
- 进程：成功、非零退出、启动失败、超时、取消和进程树清理。
- 日志：中文跨块、stdout/stderr 交错、重复块、缺口、断线重传、截断和脱敏。
- 产物：空匹配、超限、路径穿越、符号链接、重复上传、摘要不匹配。
- 租约：续期、过期、网络分区、Agent 重启、迟到结果和重复完成。
- 安全：Shell 注入、环境泄露、恶意文件名、越界 cwd 和失效凭据。
- 模式：同一 Agent 测试套件分别连接 Lite 与 Full 控制面。
- 离线：禁止出站网络，从离线包安装、注册并完成一个命令用例。

## 当前实现顺序

assignment/lease、Agent claim/续期、process supervisor、权威测试/依赖 JAR 输入、TestNG descriptor 精确方法选择与参数注入、取消、reconcile、有序日志、双层脱敏、有界 spool、产物上传、幂等完成、结构化 TestNG 报告解析、凭据轮换（15 分钟宽限期）与管理员撤销/注销已落地。结构化报告采用有界流式 XML 解析，拒绝 DTD/实体扩展，明细达到上限后继续累计汇总；控制面在双数据库保存结果，原始 XML 按产物规则上传。后续按以下顺序继续，未列为完成的能力不得用于生产声明：

1. 补齐离线服务安装和相邻版本兼容矩阵。
2. 完成专用文件系统/项目配额部署验证。
3. 完成 Lite/Full 断网端到端与故障恢复验收。
