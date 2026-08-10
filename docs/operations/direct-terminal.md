# Runner 直连终端

AutoForge 的交互终端直接复用现有 Runner Agent，不需要 ShellHub、SSH Server 或新的基础设施。管理员在执行机页面打开方案 E 浮窗后，浏览器与 Agent 分别主动连接控制面的同源 WebSocket，控制面只做有界会话中继。

这不是 SSH 协议，也不是任务执行器：终端启动的是 Agent 本地策略固定的 Shell，并继承 Agent 服务账户的操作系统权限。它不能代替 assignment、lease、执行日志或审计闭环。

## 连接拓扑

```text
Browser terminal (xterm.js)
          |
          | WSS + one-time browser ticket
          v
AutoForge /api/v1/terminal-stream
          ^
          | WSS + short-lived Runner ticket
          |
Runner Agent -> bounded PTY -> configured shell
```

- Agent 只建立出站连接，执行机不开放新的入站端口。
- 浏览器会话票据有效期 30 秒且在单个网关进程内只消费一次；Agent 票据由认证心跳滚动签发。
- 控制面每 25 秒发送 WebSocket ping，浏览器和 Agent 自动回应 pong。浮窗关闭、网络超时、Agent 断线或服务端关闭都会终止 PTY 和进程组。
- WebSocket 持续连接只保证浮窗存活期间的交互会话，不绕过令牌过期、反向代理超时或 Agent 本地最长时限。

## 启用

服务端配置一个与 Runner bootstrap token 不同的离线随机密钥：

```bash
AUTOFORGE_TERMINAL_ACCESS_TOKEN=replace-with-at-least-32-random-characters
```

未设置时终端 API 与 WebSocket 网关关闭，页面按钮会显示不可用。该值只用于控制面签发和校验短时票据，不发送给浏览器，也不是用户凭据。登录用户必须具有独立的 `runner.terminal` 权限，调用 `POST /api/v1/terminal-sessions` 后取得 30 秒一次性浏览器票据。

每台允许交互登录的 Runner 还需显式开启本地策略：

```bash
AUTOFORGE_AGENT_TERMINAL_ENABLED=true
AUTOFORGE_AGENT_TERMINAL_SHELL=/bin/sh
AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS=1
AUTOFORGE_AGENT_TERMINAL_MAX_DURATION=1h
```

Agent 启动诊断会验证 Shell 是可执行的普通文件，并创建权限为 `0700` 的终端工作目录。PTY 只接收固定 Shell，不接收控制面下发的可执行文件或启动参数；环境变量使用白名单，AutoForge 和 Runner 凭据不会注入 Shell。

## 反向代理

生产环境必须使用 HTTPS/WSS，并确保 `/api/v1/terminal-stream` 支持 HTTP Upgrade。以 Nginx 为例：

```nginx
location /api/v1/terminal-stream {
    proxy_pass http://autoforge:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
}
```

浏览器连接执行严格同源校验。反向代理应覆盖而不是透传客户端伪造的 `X-Forwarded-Host` 和 `X-Forwarded-Proto`。访问日志必须隐藏 `Authorization` 与 `Sec-WebSocket-Protocol`，后者包含短时浏览器票据。

当前单进程 Lite 和单副本 Full 可直接使用。Full 多 Web 副本部署终端时，负载均衡器必须让同一 Runner 通道和对应浏览器会话落到同一控制面实例；任务与心跳 API 不需要这项亲和。后续如通过 NATS 实现跨实例终端中继，应先新增协议与威胁模型 ADR。

## 安全边界

- 终端访问同时要求有效登录会话、独立 `runner.terminal` 权限、同源校验和一次性短时票据；Runner 通道另行使用 Runner 身份签发的票据。
- Shell 以 Agent 服务账户运行。不要让 Agent 以 root 启动；需要高权限运维时使用操作系统已有的审计和提权策略。
- 每条消息限制为 64 KiB，单次输入/输出数据限制为 32 KiB，慢消费者缓冲超过 1 MiB 时主动断开。
- 会话数、最长时长、终端尺寸、工作目录、环境变量和进程组生命周期均在 Agent 本地限制；控制面不能放宽。
- 终端输出只写入 xterm.js，不进入 React HTML，不使用 `dangerouslySetInnerHTML`。
- 持久审计记录请求、实际开始、结束、操作者、Runner、会话 ID、断开原因及输入消息数/输入输出字节数。为避免把密码和密文复制到审计库，当前不保存命令内容、终端输出或录屏；需要命令级审计时应使用执行机操作系统的受控提权/会话审计能力。

前端使用固定版本的 `@xterm/xterm` 与 `@xterm/addon-fit`（MIT），控制面使用 `ws`（MIT），Agent 使用 `github.com/coder/websocket`（ISC）和 `github.com/creack/pty`（MIT）。全部依赖在构建时锁定并随离线发布物交付，运行时不访问公网。
