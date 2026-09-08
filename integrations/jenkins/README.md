# AutoForge Jenkins 插件

`autoforge-execution` 提供 `autoforgeRun`，`autoforge-dependency-publisher` 提供
`autoforgePublishDependencies`。两个 HPI 可以分别安装，共享的控制台 Java 库随 HPI 打包。

## 安装与兼容性

两个插件的最低运行要求相同：

| 组件                                     | 最低版本                |
| ---------------------------------------- | ----------------------- |
| Jenkins Controller                       | `2.479.3`               |
| Pipeline: Step API (`workflow-step-api`) | `700.v6e45cb_a_5a_a_21` |

插件直接以 Step API `700` 编译；安装该版本的 Jenkins 无需为 AutoForge 升级到 `724`。
CI 在 `700.v6e45cb_a_5a_a_21` 和 `724.v538c2362b_dfb_` 上分别运行真实 Jenkins
Pipeline Job，覆盖任务执行、等待超时、停止后等待平台终态、创建期间停止、结果链接、依赖发布及控制台输出；测试确认实际加载的
Step API 版本，防止传递依赖升级掩盖兼容性问题。低于 `700` 的版本尚未验证。

`1.13.1` 的 HPI 声明了 `724` 最低依赖；遇到 `Update required: Pipeline: Step API`
时，应在 Jenkins「管理 Jenkins → 插件 → 高级设置」上传包含此修复的 HPI，并按 Jenkins
提示重启。重新上传原 `1.13.1` 文件不会改变依赖要求；同时使用两个 AutoForge 插件时需分别更新。
Jenkins Controller 的最低版本保持不变。

离线环境需提前安装 Pipeline 及其依赖，AutoForge HPI 不内嵌或自动下载 Pipeline 插件。
`workflow-job`、`workflow-cps` 和 `scm-api` 的显式依赖仅用于测试，不会成为 AutoForge HPI 的
新增运行依赖。依赖声明与 HPI manifest 的关系见 [Jenkins 官方说明](https://www.jenkins.io/doc/developer/plugin-development/dependencies-and-class-loading/#depending-on-other-plugins)。

## 构建与验证

从仓库根目录执行默认兼容基线的完整验证：

```bash
pnpm test:jenkins-plugins
```

该命令运行 Maven reactor 的 `clean verify`，避免切换构建版本时混入旧控制台 JAR，再检查两个 HPI 的插件版本、Jenkins 最低版本、
Step API 唯一直接插件依赖、Pipeline step class 和内置控制台库。

复验较新的 Step API（仅用于兼容性测试，不用于正式发布包）：

```bash
mvn --batch-mode --no-transfer-progress --file integrations/jenkins/pom.xml \
  -Dworkflow-step-api.version=724.v538c2362b_dfb_ clean verify
bash scripts/verify-jenkins-hpis.sh 1.2.0-SNAPSHOT 724.v538c2362b_dfb_
```

正式发布继续使用默认 `700` 基线，以保证 HPI 的最低依赖不被提高。首次联网构建会解析
Maven 依赖；依赖缓存齐全后可使用 `mvn --offline` 构建和运行测试，运行时只访问配置的 AutoForge
控制面和平台返回的进度 API。

任务执行插件的 API Key 需要项目的 `run.create`、`run.cancel`、`run.read` 权限。
普通 Pipeline 停止会先请求平台平滑终止，等待最终报告后才结束步骤，具体收尾和失败边界见[执行插件说明](./autoforge-execution/README.md)。
