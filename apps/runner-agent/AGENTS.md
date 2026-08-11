# Runner Agent Development Rules

本目录继承仓库根 `AGENTS.md`。Runner Agent 使用 Go，任何实现都必须继续满足控制面隔离、离线运行、Clean Code 和执行安全约束。

- 默认只使用 Go 标准库；新增依赖前必须说明许可证、离线获取、交叉编译和供应链影响。
- 内置资源目标仅为 Linux `amd64` 与 `arm64`，均使用 `CGO_ENABLED=0` 构建静态二进制；Agent 随主平台镜像交付，不生成独立 GitHub Release 资产。
- 命令执行必须使用 `exec.Command` 的 executable/args 形式，禁止调用 Shell 或接受拼接命令。
- 工作目录、日志、超时、环境变量和进程树都必须有上限、校验和测试。
- 当前 Agent 已实现 Runner Protocol v1 注册/心跳、assignment claim、lease 续租、凭据轮换（`rotate-credential`，旧凭据 15 分钟宽限）、按有效 lease 领取执行密文并仅注入本次进程环境、启动 reconcile、权威测试/依赖 JAR 下载校验、离线 TestNG 类/方法执行与参数注入、cgroup v2/rlimit 资源限制、取消/进程组清理、日志 spool/重传、产物闭环和完成上报；严格磁盘配额仍依赖部署能力，不得把 process 模式描述为完整安全沙箱。
- Go 文件必须通过 `gofmt`、`go vet`、`go test`；内置资源脚本还必须验证双架构二进制格式、静态链接和资源清单摘要。
