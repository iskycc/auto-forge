# java-cases 测试用例模块

这是 AutoForge E2E 验收用的 TestNG 用例源码模块，与 `tests/fixtures/real-agent/`
平行存在，但独立成模块目录并拥有自己的构建脚本，用于覆盖
「JAR 导入 → 任务创建 → 用例勾选 → 执行机添加 → 任务执行 → 查看执行详情及日志」
的完整链路。

## 内容

- `src/main/java/com/autoforge/javacases/JavaCasesFixture.java`：成功用例。
  断言受管环境变量、执行密文与任务配置的 Adapter 环境地址均已注入，输出
  `JAVA_CASES_STDOUT_完成:` 标记与 `artifacts/java-cases.txt` 产物。
- `src/main/java/com/autoforge/javacases/JavaCasesFailureFixture.java`：失败用例，
  用于验证失败上报与重试链路。
- `src/main/java/com/autoforge/javacases/JavaCasesConstants.java`：共享常量；
  环境地址 `10.20.30.40` 只是 mock 值，不参与真实网络访问。

## 构建

不依赖 Maven。`scripts/quality/build-java-cases.sh` 用 JDK 自带的 `javac`/`jar`
按 `adapters/cotest-testng` 的运行语义打包：

1. 下载并校验 TestNG 7.11.0 及其依赖（SHA-256 与 CI 脚本一致）。
2. 先把 `tests/fixtures/real-agent/ProjectFileUtil.java` 编译为
   `project-fixture.jar`，再把 java-cases 用例依赖它编译为 `java-cases-tests.jar`。
3. 按 Adapter 读取根目录及最多三层子目录 JAR 的规则，把依赖放进
   `dependency-bundle/level-1/level-2/level-3`，打包为
   `java-cases-dependencies.zip`。
4. 用 `javac`+`jar` 构建 `cotest-testng-adapter` 可执行 JAR（等价于
   `mvn package`，生产代码无第三方依赖）。

构建产物输出到 `tests/fixtures/java-cases/dist/`。

## 运行

```bash
scripts/quality/test-java-cases.sh
```

脚本会构建 java-cases 资产与 Go Agent 二进制，委派
`/sys/fs/cgroup/autoforge-java-cases` cgroup 子树（root 直接写入，无需 sudo），
然后运行 `tests/e2e/java-cases-pipeline.spec.ts`。与 `test-real-agent.sh` 不同，
本脚本面向开发机，不做网络阻断。
