# ADR 0014：统一使用 Ant Design，并完整离线交付

状态：已实施，验证范围与结果记录于[迁移记录](../design/ant-design-migration.md)。

## 背景与决策

原全局样式表超过两万行，存在重复组件样式与逐次覆盖。产品决定放弃尚未发布的 shadcn/ui 迁移，改用 Ant Design；`globals.css` 与页面 CSS Module 的退役继续执行。

统一由 `AntDesignProvider` 配置中文语言、蓝色主色、语义状态色、字号、控件高度和圆角。按钮、输入、选择、弹窗、通知、进度、卡片与状态标签采用 Ant Design；业务复合组件保留自身布局。Tailwind 仅负责布局、状态组合及语义 token，不引入第二套交互组件库。

共享组件保留现有表单提交、权限、未保存草稿保护及事件契约。原生表单桥接字段用于 FormData、required、reset 和已有业务接口；可见控件由 Ant Design 提供。大表格和日志保留有界渲染、目录展开加载及原滚动容器，不因视觉迁移改为全量加载。

公开日志改为浅色卡片、状态标签、信息说明和日志正文区域。执行机交互终端使用自身终端调色板，不影响公开日志主题。

## 离线与依赖

生产依赖精确锁定：Ant Design 6.6.5、Ant Design Icons 6.3.4、Next.js Registry 1.3.0、CSS-in-JS 2.1.2、Day.js 1.11.22，均为 MIT 许可，纯 JavaScript，无新增原生运行时要求。Tailwind 及 PostCSS 4.3.3 为构建依赖，其平台二进制通过 lockfile 和离线包固定。依赖完整许可清单由仓库脚本生成。

使用 Ant Design 6 的 `zeroRuntime` 与本地 `antd/dist/antd.css`，完整组件样式在构建时编译为 Next.js 静态 CSS；图标以本地 SVG/JS 模块、中文语言包以 JS 模块打包。Registry 提供服务端首屏样式，避免首次加载闪烁。禁止在线 CDN、字体、Iconfont 脚本及浏览器运行时拉取 npm 资源。

离线 tar 为包含后端镜像的 Docker 归档。镜像必须包含全部 `.next/static`、服务端追踪依赖和许可证；发布打包校验必须检查资源完整性。此决策不增加 Lite 外部服务依赖，也不改变 Full 数据与部署协议。

## 回滚与验证

无数据库或 Runner 协议迁移；可通过回滚整个前端版本恢复。不得只恢复旧 CSS 并叠加两套主题。验证覆盖类型、组件业务测试、生产构建、核心 E2E、1024px/1536px 真实截图和阻断外网的已打包运行时访问。

## 参考

- [Ant Design 与 Next.js](https://ant.design/docs/react/use-with-next/)
- [Ant Design 主题与静态样式](https://ant.design/docs/react/customize-theme/)
