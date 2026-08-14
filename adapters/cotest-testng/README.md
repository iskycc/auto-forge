# CoTest TestNG Adapter

这是旧 CoTest/TestNG 用例入口的独立 Maven 模块。它只提供启动、隔离类加载、CoTest 参数注入和
结果输出，不内置 JDK、TestNG、业务 JAR、浏览器或驱动。运行时使用哪个 JDK，以及 JAR 目录中
包含哪些版本，由项目级运行时资源明确指定。

## 构建

要求 JDK 11 或更高版本和 Maven 3.9：

```bash
mvn clean verify
```

可执行 JAR 输出到 `target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar`。生产代码没有第三方编译或
运行时依赖；JUnit 和 TestNG 只用于模块测试，不会进入产物。

## 准备运行目录

把以下内容放入同一个 JAR 根目录，允许最多 10 层子目录和 4096 个 JAR。这个边界限制的是
本地依赖文件扫描，不限制 JAR 内的测试类或用例数量：

- 待执行的测试 JAR；
- 测试所需的全部业务依赖；
- 管理员选择的 TestNG 及其完整依赖；
- 配置环境地址时，提供 `com.huawei.cotest.util.ProjectFileUtil` 的 JAR；
- 使用类数据文件时，提供 `cotest.auto.dataproviders.MM2DataProvider` 的 JAR。

Adapter 不会访问网络或自动补装缺失依赖。

## 执行

使用管理员准备的 JDK 启动：

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
- `--class-data FILE`：不提供时不会加载 `MM2DataProvider`；
- `--output DIR`：默认是当前目录下的 `reports/testng`。

退出码 `0` 表示 TestNG 成功，`1` 表示用例或执行失败，`2` 表示 Adapter 参数无效。

## 类加载边界

旧实现只修改线程上下文 ClassLoader，但 `URLClassLoader` 默认仍是父优先；当父进程已经加载
TestNG 或同名业务类时，实际版本可能不是 JAR 目录中的版本。同时，静态全局 URL 列表会让多次
执行互相污染。

本模块为每次执行创建并关闭一个独立 ClassLoader：JDK、XML API 和 Adapter 自身类父优先，
TestNG、CoTest 扩展、测试类与业务依赖子优先。所有反射类型都从同一个加载器解析，并在执行前
设置线程上下文加载器，结束后无条件恢复。

Runner 安装时会同时安装本 Adapter。项目配置的 JDK/JAR 压缩包由 Runner 下载、校验和安全解压，
随后以 `java -jar` 调用；平台选择的主用例 JAR 始终排在其余依赖之前。每个用例使用独立进程和
新建的 ClassLoader，两个用例之间不会共享已加载的同名业务类。
