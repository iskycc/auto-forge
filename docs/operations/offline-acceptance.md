# 断网发布验收

Gate E 必须在阻断所有出站网络、仅允许测试 LDAP/Runner 内网的环境执行。验收证据记录 Release
tag/commit、四平台 variant、镜像 digest、SHA256SUMS、SBOM、来源证明、基础设施摘要、硬件规模和
每一步时间/结果。

1. 从 Release 资产和预先导出的 Full 基础设施镜像启动，确认 `pull_policy: never` 且无 DNS/CDN/
   遥测/包下载请求。
2. 完成首次管理员、本地登录、私有 CA LDAP 登录、用户/角色/项目隔离。
3. 后台导入带 testng.xml/继承/MR class 的 JAR，比较并确认来源，创建含 Runner、项目版本、重跑和 Adapter 地址的完整任务，并确认发现参数只读固化且界面没有手工参数覆盖。
4. 从平台 SSH 自动安装内置 Agent，运行 doctor；分别完成单用例/批量执行、失败重试、取消、日志
   断线补传、产物上传/下载和分析导出。
5. Lite 完成崩溃恢复；Full 注入 PostgreSQL/NATS/Redis/MinIO 短暂故障和重复消息，验证唯一终态。
6. 执行停止状态备份，恢复到新卷，核对登录、执行、对象摘要和分析；携带上一正式版本夹具升级，
   模拟迁移失败并按手册回滚。
7. 检查 Agent/JDK/TestNG/浏览器全程无公网获取，诊断包不含凭据，保留/清理有审计且死信可见。
8. 先执行 `pnpm test:jenkins-plugins` 验证真实 Pipeline DSL 和已打包 HPI，再从 Release 安装两个 Jenkins HPI，按 [`examples/jenkins/Jenkinsfile`](../../examples/jenkins/Jenkinsfile) 以最小权限 API Key 验证依赖按项目版本替换、任务全生命周期等待、30 秒进度日志和免登录只读进展页。

独立 `Published Release acceptance` workflow 在同 tag 的 `Release` 成功完成后启动，自动消费已发布的签名资产和上一正式 Release，而不是源码构建结果。资产完整性、业务、真实 Agent、LDAP、停止状态备份恢复、迁移完整性故障、旧版本回滚与成功升级分别在隔离 Job 中并行执行，避免把发布等待和所有场景串成一个长任务。它核对可信公钥、manifest 全部资产、摘要、镜像/部署 SBOM 与许可证，使用 `--internal` Docker 网络启动发布镜像，并提取镜像内 Agent 与 Adapter 完成真实执行。该 workflow 的成功或失败不参与 `Release` 依赖链；失败会保留 Gate E 红灯和诊断证据，并要求后续 hotfix，但不会阻塞或撤回发布。

任一步缺少自动化或实机证据时 Gate E 保持未完成；本清单本身不等同于验收通过。PR/普通分支 CI 只验证脚本和业务矩阵，不能伪造正式 tag、已发布签名资产或上一 Release，因此不会提前勾选 Gate E。
