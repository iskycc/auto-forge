# Runner Agent Development Rules

本目录继承仓库根 `AGENTS.md`。Runner Agent 使用 Go，任何实现都必须继续满足控制面隔离、离线运行、Clean Code 和执行安全约束。

- 默认只使用 Go 标准库；新增依赖前必须说明许可证、离线获取、交叉编译和供应链影响。
- 发布目标仅为 Linux `amd64` 与 `arm64`；标准版和 musl 版均使用 `CGO_ENABLED=0` 构建静态二进制。
- 命令执行必须使用 `exec.Command` 的 executable/args 形式，禁止调用 Shell 或接受拼接命令。
- 工作目录、日志、超时、环境变量和进程树都必须有上限、校验和测试。
- 当前控制面实现 Runner Protocol v1 的注册、CPU/内存/负载心跳和可选直连终端，并能基于快照生成初始调度分配；不得把 `run-once`、调度记录或交互终端描述为已经具备 assignment claim、lease、TestNG 执行、日志和产物闭环的完整 Agent。
- Go 文件必须通过 `gofmt`、`go vet`、`go test`；跨架构发布脚本还必须验证目标二进制格式。
