# TestNG 静态发现边界

状态：JAR 有界静态扫描、根目录 `testng.xml` 选择规则、JAR 内父类注解继承、Multi-Release class 选择和运行时语义警告已在 Lite/Full 实现；本文固化已实现语义与明确不支持的边界。

## 扫描边界

`packages/testng-discovery` 只解析 ZIP 目录和 JVM class 文件结构，不加载、链接、初始化或执行上传的 class。JAR 压缩大小、条目数、解压总量、单 class 大小、发现类数量和警告数量都有上限；超过整体限制的 JAR 拒绝导入，单个损坏或超限的 class 产生有界警告后跳过。

## testng.xml（AF-CASE-001）

只解析 JAR 根目录的 `testng.xml`。解析器是有界手写解析（1 MiB、10k 节点、深度 64），拒绝 DTD/实体声明。已支持的语义：

- suite/test 级 `parameter`，按 suite → test → class → method 顺序合并，键冲突时以后层覆盖并产生 `TESTNG_XML_PARAMETER_CONFLICT` 警告；合并结果写入用例定义的 `parameters`，执行时注入 `ExecutionSpec.parameters`。
- `groups` 的 `include`/`exclude`、`packages` 包选择（支持 `*` 前缀匹配）、`classes`/`methods` 的 `include`/`exclude`（方法名支持 `*` 通配）。未命中选择的类/方法保留在结果中但标记 `enabled: false`。

明确不支持并产生有界警告的语义：

- `suite-files`：不展开引用，产生 `TESTNG_XML_SUITE_FILES_UNSUPPORTED`。
- `listeners`、方法选择器（`script`/`selector-class`）：仅在执行期生效，产生 `TESTNG_LISTENERS_RUNTIME_ONLY`、`TESTNG_METHOD_SELECTOR_RUNTIME_ONLY`。
- 非根目录的 `testng.xml`（任意大小写路径）：不参与发现，产生一条 `TESTNG_XML_NESTED_IGNORED` 汇总警告。

## 继承（AF-CASE-002）

JAR 内父类的 TestNG 语义会合并到子类：父类的类级 `@Test`（enabled、groups、description）和非 private 方法按名称+descriptor 合入，子类同名同描述符方法视为覆盖；抽象类不产生用例候选；继承环产生 `CLASS_INHERITANCE_CYCLE` 警告。父类不在当前 JAR 内时不加载外部 class，产生 `EXTERNAL_SUPERCLASS_NOT_SCANNED` 警告，发现结果只包含本类声明的语义。

## Multi-Release JAR（AF-CASE-003）

仅当 `META-INF/MANIFEST.MF` 声明 `Multi-Release: true` 时处理 `META-INF/versions/N/` 下的 class：按平台配置页面持久化的目标 Java 版本（默认 21）选择不大于该版本的最高版本条目，并产生 `MULTI_RELEASE_SELECTED` 提示；未启用 Multi-Release 但存在版本条目时产生 `MULTI_RELEASE_NOT_ENABLED`；版本条目按目标版本被过滤时产生 `MULTI_RELEASE_TARGET_FILTERED`。目标版本必须与执行基线一致，否则发现的类可能与 Runner 实际运行的字节码不同。

## 工厂与动态语义（AF-CASE-004）

`@Factory`、`@DataProvider`、`@Listeners` 和 `@Test(dataProvider=…)` 属于运行时语义，静态发现不展开也不执行，分别产生 `TESTNG_FACTORY_RUNTIME_ONLY`、`TESTNG_DATA_PROVIDER_RUNTIME_ONLY`、`TESTNG_LISTENERS_RUNTIME_ONLY` 警告。这些类的静态方法集合仍会作为用例候选导入；运行时动态生成或筛选的测试不在静态发现结果中，批次结果以 TestNG 实际执行为准。
