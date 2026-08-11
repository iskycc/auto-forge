# Runner 运维手册

## 生命周期与凭据

后台“执行机”页面可排空、禁用、恢复、注销、撤销凭据或请求轮换。请求轮换不会把新凭据返回给
浏览器；控制面在下一次认证心跳下发指令，Agent 调用专用轮换端点并以 `0600` 原子保存新身份，
成功后切换所有 claim、lease、日志和产物请求。旧凭据只保留 15 分钟宽限，便于持久化失败时重试。
离线维护也可在执行机运行 `autoforge-agent rotate-credential --config /etc/autoforge-agent/config.json`。
撤销和注销会立即阻断协议认证，不能用轮换恢复，必须重新执行受信任的安装/注册流程。

## 离线安装

平台内置 Linux amd64/arm64 Agent。管理员在 Runner 页面提交 SSH 目标、用户、密码并核对主机
指纹后，平台探测 Ubuntu/openSUSE 与架构、传输二进制/安装脚本/一次性 bootstrap token，创建
专用用户、目录和 systemd 服务。脚本不调用包管理器、不联网。详细路径、权限、私有 CA 和卸载
命令见 [Agent 安装](../operations/runner-agent-install.md)。

## 工具链与能力

Java、TestNG、依赖 JAR、浏览器和驱动必须从受控离线介质预置。使用
`operations/build-runner-toolchain.sh` 把已批准的 JDK 与完整 classpath 组装为带摘要的版本包；
基线见 [Runner 工具链](../operations/runner-toolchain.md)。Agent 配置文件记录绝对 Java 路径、
classpath 和精确版本；`doctor`/`health ready` 校验可执行文件、classpath、数据目录、cgroup v2 和
私有 CA，校验失败时不声明对应 capability。

## 生命周期与诊断

安装后执行 `autoforge-agent health live` 检查进程，执行
`autoforge-agent health ready --config /etc/autoforge-agent/config.json` 检查就绪。
排空停止新 claim 并允许 lease 内任务完成；禁用/撤销会拒绝心跳、claim、续租、上报与终端；
注销前应排空。升级使用平台内置的新二进制覆盖并重启，回滚恢复上一受控二进制和配置备份。

spool 保存未确认日志/结果并受大小与保留期限制；达到上限会明确截断或失败，不静默丢失。
attempt 使用独立工作目录、cgroup v2、rlimit 和进程组；process 模式不是完整沙箱。终端、取消、
超时、lease 丢失、Agent 关闭和控制面断开都会关闭 Shell/测试进程组。诊断日志与用例输出分流并
执行脱敏。
