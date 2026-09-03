# CoTest TestNG Adapter

这是旧 CoTest/TestNG 用例入口的独立 Maven 模块。它只提供启动、隔离类加载、CoTest 参数注入和
结果输出，不内置 JDK、TestNG、业务 JAR、浏览器或驱动。运行时使用哪个 JDK，以及 JAR 目录中
包含哪些版本，由项目级运行时资源明确指定；Suite、Test 与环境地址则随用例任务固化。

## 构建

正式 Adapter 必须使用 JDK 8 和 Maven 3.9 构建。仓库提供的校验脚本会拒绝其他构建 JDK，执行
全部模块测试，并逐个确认产物 class 的 major version 为 Java 8 的 `52`：

```bash
JAVA_HOME=/opt/approved-jdk8 \
PATH=/opt/approved-jdk8/bin:$PATH \
bash scripts/quality/test-cotest-adapter-java8.sh
```

可执行 JAR 输出到 `target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar`。生产代码没有第三方编译或
运行时依赖；JUnit 和 TestNG 只用于模块测试，不会进入产物。Java 8 构建使用 TestNG 6.14.3
和 7.5.1 验证旧运行时，CI 还会使用 JDK 21 + TestNG 7.11.0 复验当前基线，因此只发布一个
Adapter，Runner 不需要按 JDK 版本选择不同 JAR。

## 准备运行目录

把以下内容放入同一个 JAR 根目录。Adapter 会读取根目录及最多三层子目录中的全部 JAR，不设置
独立 JAR 数量上限；为避免异常目录耗尽内存，整体扫描仍限制为 100,000 个目录条目。这个安全
边界不限制 JAR 内的测试类或用例数量：

- 待执行的测试 JAR；
- 测试所需的全部业务依赖；
- 管理员选择的 TestNG 及其完整依赖；
- 配置环境地址时，提供 `com.huawei.cotest.util.ProjectFileUtil` 的 JAR；
- 使用类数据文件时，提供 `cotest.auto.dataproviders.MM2DataProvider` 的 JAR。

Adapter 不会访问网络或自动补装缺失依赖。

## 执行

使用管理员准备的 JDK 8 或更高版本启动；依赖目录中的 TestNG 及业务依赖也必须兼容该 JDK：

```bash
/opt/approved-jdk/bin/java \
  -jar target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar \
  --jars /opt/cotest/test-jars \
  --class com.example.AdapterCase \
  --environment-address 10.0.0.8 \
  --class-data /opt/cotest/data/class-data.json \
  --output /var/lib/autoforge/attempt/reports/testng
```

可选参数：

- `--config FILE`：读取前两个非空、非注释行作为 suite name 和 test name；
- `--suite-name NAME`、`--test-name NAME`：显式值优先于配置文件；
- `--environment-address VALUE`：配置时才加载并调用 CoTest `ProjectFileUtil`；
- `--class-data FILE`：不提供时不会加载 `MM2DataProvider`；平台执行 DDT 用例时会自动传入当前
  CaseID 的不可变 JSON 快照，普通用例不会传入；
- `--output DIR`：默认是当前目录下的 `reports/testng`。

退出码 `0` 表示 TestNG 成功，`1` 表示用例或执行失败，`2` 表示 Adapter 参数无效。

失败摘要会额外输出为 ASCII 单行的 `TestCase Run Failed Stack Base64` 标记；载荷是完整的 UTF-8
`Throwable.toString()`。因此，多行异常消息、中文内容和跨日志分块的长摘要都不会被截断或受
控制台默认字符集影响。

## 类加载边界

旧实现只修改线程上下文 ClassLoader，但 `URLClassLoader` 默认仍是父优先；当父进程已经加载
TestNG 或同名业务类时，实际版本可能不是 JAR 目录中的版本。同时，静态全局 URL 列表会让多次
执行互相污染。

本模块为每次执行创建并关闭一个独立 ClassLoader：JDK、XML API 和 Adapter 自身类父优先，
TestNG、CoTest 扩展、测试类与业务依赖子优先。所有反射类型都从同一个加载器解析，并在执行前
设置线程上下文加载器，结束后无条件恢复。

Runner 安装时会同时安装本 Adapter。项目配置的 JDK/JAR 压缩包由 Runner 下载、校验和安全解压，
任务配置提供 Suite、Test 和按用例轮询后的环境地址，随后以 `java -jar` 调用；平台选择的主用例
JAR 始终排在其余依赖之前。每个用例使用独立进程和新建的 ClassLoader，两个用例之间不会共享
已加载的同名业务类。

DDT 用例在平台侧绑定一个同项目版本、同测试阶段的普通 TestNG 类。创建批次后，Runner 通过租约
保护的控制面输入接口下载该 CaseID 的 JSON 快照到独立执行路径，校验大小和 SHA-256 后再传给
`--class-data`。Adapter 的反射注入方式和普通用例执行方式没有改变；平台也不会让 Runner 直接
读取数据库或对象存储长期凭据。
