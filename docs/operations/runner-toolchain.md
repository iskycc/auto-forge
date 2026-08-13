# Runner 离线工具链基线

执行基线为 Java 11 或更高版本、TestNG 7.11.0 及其完整运行时依赖。正式 Release 已提供原生
`amd64`/`arm64` Java 21 + TestNG 工具链资产、逐文件摘要和 SPDX SBOM；组织也可用下述脚本从
已批准输入生成自己的工具链。浏览器、驱动和其他 SDK 仍需单独完成许可证/来源/摘要审查。平台与
Agent 在首次执行或运行期间都不会下载工具链。

将批准的 JDK 目录和 TestNG classpath JAR 放入独立目录后执行：

```bash
operations/build-runner-toolchain.sh \
  --jdk-dir /media/approved/jdk-21 \
  --classpath-dir /media/approved/testng-7.11.0-lib \
  --java-version 21.0.x --testng-version 7.11.0 --architecture amd64 \
  --output autoforge-runner-toolchain-linux-amd64-java21-testng7.11.0.tar.gz
sha256sum --check autoforge-runner-toolchain-linux-amd64-java21-testng7.11.0.tar.gz.sha256
```

脚本只打包本地输入，不访问网络；输出含 manifest、JDK、classpath 和内部文件摘要。它校验
`bin/java` 的 Linux ELF 机器类型与 `--architecture` 一致，并要求 classpath 内存在 TestNG JAR。
为 amd64/arm64 分别生成，不得重命名一种架构伪装另一种。解压后先验证外层与内部 SHA-256，
再放入只读管理员目录，把 `jdk/bin/java` 和全部 `lib/*.jar` 的
绝对路径写入 Agent JSON 配置，执行 `doctor`。浏览器自动化应使用另一个带精确浏览器/驱动版本、
许可证和摘要的 Runner profile；没有对应 capability 时调度前拒绝，不允许运行时补装。
