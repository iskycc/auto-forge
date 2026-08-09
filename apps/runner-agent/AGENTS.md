# Runner Agent Development Rules

本目录继承仓库根 `AGENTS.md`。Runner Agent 使用 Go，任何实现都必须继续满足控制面隔离、离线运行、Clean Code 和执行安全约束。

- 默认只使用 Go 标准库；新增依赖前必须说明许可证、离线获取、交叉编译和供应链影响。
- 发布目标仅为 Linux `amd64` 与 `arm64`；标准版和 musl 版均使用 `CGO_ENABLED=0` 构建静态二进制。
- 命令执行必须使用 `exec.Command` 的 executable/args 形式，禁止调用 Shell 或接受拼接命令。
- 工作目录、日志、超时、环境变量和进程树都必须有上限、校验和测试。
- 当前 Agent 已实现 Runner Protocol v1 注册/心跳、assignment claim、lease 续租、启动 reconcile、权威 JAR 下载校验、离线 TestNG 类级执行、取消/进程组清理和完成上报；日志 spool/重传、产物闭环、方法 descriptor 精确选择及 Linux 资源硬限制仍未完成，不得描述为生产执行闭环。
- Go 文件必须通过 `gofmt`、`go vet`、`go test`；跨架构发布脚本还必须验证目标二进制格式。
