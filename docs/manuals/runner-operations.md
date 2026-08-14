# Runner 运维手册

## 生命周期与凭据

后台“执行机”页面可排空、禁用、恢复、注销、撤销凭据或请求轮换。请求轮换不会把新凭据返回给
浏览器；控制面在下一次认证心跳下发指令，Agent 调用专用轮换端点并以 `0600` 原子保存新身份，
成功后切换所有 claim、lease、日志和产物请求。旧凭据只保留 15 分钟宽限，便于持久化失败时重试。
离线维护也可在执行机运行 `autoforge-agent rotate-credential --config /etc/autoforge-agent/config.json`。
撤销和注销会立即阻断协议认证，不能用轮换恢复，必须重新执行受信任的安装/注册流程。

## 离线安装

平台内置 Linux amd64/arm64 Agent 与 CoTest Adapter。管理员在 Runner 页面提交 SSH 目标、用户、密码并核对主机
指纹后，平台探测 Ubuntu/openSUSE 与架构、传输二进制/Adapter/安装脚本/一次性 bootstrap token，创建
专用用户、目录和 systemd 服务。脚本不调用包管理器、不联网。详细路径、权限、私有 CA 和卸载
命令见 [Agent 安装](../operations/runner-agent-install.md)。

远程探测与安装使用目标机的 Bash，systemd 固定以 `/var/lib/autoforge-agent` 为工作目录。
若 openSUSE 的 `ID` 被定制成 `sles` 等值，自动模式会结合名称中的 openSUSE 证据纠正；仍无法
确认时，管理员核验主机后可手动选择 Ubuntu/openSUSE 强制模式，不再因识别结果直接阻断。

## 工具链与能力

项目设置可分别流式上传 JDK 压缩包与包含用例全部依赖的 JAR 压缩包，也可登记 Runner 可访问的
HTTP(S) 链接、精确字节数和 SHA-256；上传没有固定业务大小上限，但对象存储与执行工作区配额仍
必须生效。Adapter 的启用状态、Suite/Test 和多个环境地址在创建或编辑用例任务时填写，环境地址
按用例顺序轮询并固化到批次。Runner 下载后再次校验摘要，在 attempt 工作目录内拒绝路径穿越、
符号链接、设备文件和超出磁盘/展开字节/文件预算的内容，再加载 `test-jars` 下三层目录内的全部
JAR 并使用任务 JDK 执行内置 Adapter。组织仍可选择本机预置工具链作为兼容后备，基线见
[Runner 工具链](../operations/runner-toolchain.md)。

## 生命周期与诊断

安装后执行 `autoforge-agent health live` 检查进程，执行
`autoforge-agent health ready --config /etc/autoforge-agent/config.json` 检查就绪。
排空停止新 claim 并允许 lease 内任务完成；禁用/撤销会拒绝心跳、claim、续租、上报与终端；
注销前应排空。升级使用平台内置的新二进制覆盖并重启，回滚恢复上一受控二进制和配置备份。

spool 保存未确认日志/结果并受大小与保留期限制；达到上限会明确截断或失败，不静默丢失。
attempt 使用独立工作目录、cgroup v2、rlimit 和进程组；process 模式不是完整沙箱。终端、取消、
超时、lease 丢失、Agent 关闭和控制面断开都会关闭 Shell/测试进程组。诊断日志与用例输出分流并
执行脱敏。运行期间 Agent 周期上传新增日志块；控制面成功持久化后再推送给同源 WebSocket
订阅者，断线期间仍以持久日志与 spool 确认水位恢复，不把 WebSocket 当作执行正确性依赖。
