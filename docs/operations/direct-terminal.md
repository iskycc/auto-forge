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
- 控制面每 25 秒发送 WebSocket ping，浏览器和 Agent 自动回应 pong。浮窗关闭、网络超时、Agent 断线或服务端关闭都会终止 PTY 和同一终端 session 内的进程。
- WebSocket 持续连接只保证浮窗存活期间的交互会话，不绕过令牌过期、反向代理超时或 Agent 本地最长时限。

## 启用

首次启动会在私有 `platform.json` 中生成与 Runner bootstrap 凭据不同的终端签名密钥，不需要
设置应用环境变量。该值只用于控制面签发和校验短时票据，不发送给浏览器，也不是用户凭据；
Runner 本地终端策略默认关闭，因此仅有该密钥不会开放 Shell。登录用户必须具有独立的
`runner.terminal` 权限，调用
`POST /api/v1/terminal-sessions` 后取得 30 秒一次性浏览器票据。

每台允许交互登录的 Runner 还需在 `/etc/autoforge-agent/config.json` 显式开启本地策略，指定固定
Shell、最大会话数和最长时限。后台自动安装默认关闭终端；管理员必须在受控配置变更中开启，本地
策略只能收紧控制面设置。

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

浏览器连接执行严格同源校验。Agent 的短时票据同时放在 `Authorization` 和 WebSocket 子协议中，
以兼容会移除 Upgrade 请求认证头的企业代理；两条通道使用同一份签名、有效期和一次性 nonce，
不是长期凭据降级。反向代理应覆盖而不是透传客户端伪造的 `X-Forwarded-Host` 和
`X-Forwarded-Proto`。访问日志必须同时隐藏 `Authorization` 与 `Sec-WebSocket-Protocol`，后者也
包含短时票据。

当前单进程 Lite 和单副本 Full 可直接使用。Full 多 Web 副本部署终端时，负载均衡器必须让同一 Runner 通道和对应浏览器会话落到同一控制面实例；任务与心跳 API 不需要这项亲和。后续如通过 NATS 实现跨实例终端中继，应先新增协议与威胁模型 ADR。

浏览器刷新不会恢复旧 PTY，而是结束旧会话并要求新票据；Agent WebSocket 重连后只接受新会话。
票据/会话过期、Web 进程关闭、平台重启和任何 Agent 网关断开都会向 Agent 发送关闭或触发连接级
`CloseAll`，随后终止 PTY 与同一终端 session 内的进程。若 Web 副本异常崩溃，Agent 的 ping/读超时负责清理；不会把
断开的 Shell 保留为可重连孤儿进程。

## 功能键与浏览器快捷键

终端输入区有焦点时，F1–F12 以及 Shift、Ctrl、Alt、Meta 修饰的功能键继续由 xterm.js 生成原终端序列，只发送一次，同时取消页面收到的功能键事件的浏览器默认动作与冒泡。功能键的按下、抬起都在终端实例内处理；浮窗放大、还原和重新打开后沿用同一规则，关闭实例时随终端释放，不安装全局键盘拦截器。

窗口工具栏有焦点或离开终端后，浏览器按键行为保持原样。普通字符、粘贴、Tab 补全、读屏支持和 Escape 的窗口操作保持现有行为。终端采用 xterm 的[自定义按键钩子](https://xtermjs.org/docs/api/terminal/classes/terminal/#attachcustomkeyeventhandler)，取消浏览器默认动作后仍允许 xterm 处理按键。

拦截范围是浏览器实际交给页面且允许取消的键盘事件；操作系统、浏览器或扩展预先保留而没有交给页面的快捷键，以及键盘 Fn 层的硬件动作，页面无法接管。浏览器只允许对可取消事件执行 [`preventDefault()`](https://developer.mozilla.org/en-US/docs/Web/API/Event/preventDefault)。

## 安全边界

- 终端访问同时要求有效登录会话、独立 `runner.terminal` 权限、同源校验和一次性短时票据；Runner 通道另行使用 Runner 身份签发的票据。
- Shell 以 Agent 服务账户运行。默认非特权模式风险更低；如果显式启用 root 模式，终端同样获得 root 权限，只能在专用受控主机上开启，并应使用操作系统已有的审计策略。
- 每条消息限制为 64 KiB，单次输入/输出数据限制为 32 KiB，慢消费者缓冲超过 1 MiB 时主动断开。
- 会话数、最长时长、终端尺寸、工作目录、环境变量和进程 session 生命周期均在 Agent 本地限制；控制面不能放宽。
- 终端输出只写入 xterm.js，不进入 React HTML，不使用 `dangerouslySetInnerHTML`。
- 持久审计记录请求、实际开始、结束、操作者、Runner、会话 ID、断开原因及输入消息数/输入输出字节数。为避免把密码和密文复制到审计库，当前不保存命令内容、终端输出或录屏；需要命令级审计时应使用执行机操作系统的受控提权/会话审计能力。

前端使用固定版本的 `@xterm/xterm` 与 `@xterm/addon-fit`（MIT），控制面使用 `ws`（MIT），Agent 使用 `github.com/coder/websocket`（ISC）和 `github.com/creack/pty`（MIT）。全部依赖在构建时锁定并随离线发布物交付，运行时不访问公网。

## 功能键修复验证（2026-10-08）

修复前先添加 Playwright 回归场景，实际复现 F1 已发送 `ESC OP`，但按下和抬起事件均未取消浏览器默认动作。原因是终端使用 `screenReaderMode: true`，该版本 xterm 对没有 Ctrl/Alt 的按键保留默认动作；修复只在实例的自定义按键钩子中处理 F1–F12，返回 `true` 继续原输入路径。

实际执行的检查：

- `pnpm exec playwright test tests/e2e/runner-telemetry.spec.ts --grep 'Runner terminal'`：本地 Lite 生产服务下三项通过。新场景使用真实 Chromium 键盘事件和 WebSocket 接收夹具，在深浅色、1024×768/1536×960、普通/放大窗口中验证 F1–F12、Shift+F5、Ctrl+F5、Alt+F1、Ctrl+Shift+F12，共 128 次功能键输入；每次只发送一个正确序列，按下/抬起默认动作均被取消，事件不冒泡到页面，没有页面导航，焦点仍在终端。另覆盖普通字符、Enter、工具栏和关闭后的非拦截行为；原 Tab 补全/工具栏焦点、Escape 放大还原/关闭及初始化失败后重开场景均通过。
- `pnpm exec vitest run` 选择终端票据和访问权限测试：两个文件、21 项通过；`pnpm exec vitest run apps/web/src/components/ui-usage.test.ts --maxWorkers=1`：17 项通过。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm --filter @autoforge/web build`、`pnpm test:e2e:matrix`、`git diff --check`：通过。

已实际查看八张终端截图，覆盖 1024×768 与 1536×960、深浅色、普通和放大窗口；标题、连接状态、按钮、文本、边框、间距和视口边界正常，无变形或溢出。

本次仅修改 Lite/Full 共用浏览器组件；没有改动数据库、终端票据、网关、Runner 或协议，也没有新增配置或依赖。该按键验收使用 WebSocket 夹具，不等同于真实 Agent PTY 验收；未运行 Full 整体部署、真实 Runner、离线验收或其他浏览器/操作系统的保留快捷键检查。
