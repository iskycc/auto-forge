# Groovy case analyzer

`AnalyzeNormalGroovyCases.java` recursively analyzes `.groovy` source files without compiling,
loading, or executing them. It exports an XLSX workbook through Apache POI 3.13 and does not use
Groovy, Grape, or Apache Ivy.

Build the analyzer and copy its runtime dependencies:

```bash
mvn --file groovy-test/pom.xml clean compile dependency:copy-dependencies
```

Run it from the repository root:

```bash
java -cp "groovy-test/target/classes:groovy-test/target/dependency/*" \
  AnalyzeNormalGroovyCases \
  --source ./cases \
  --output ./normal-cases.xlsx
```

The default exclusion keywords are only `Abnormal`, `Exception`, `Error`, and `Suspended`
(case-insensitive). Add explicitly agreed keywords with `--extra-keywords A,B,C`.

Classification follows a conservative inclusion rule:

- A case is excluded only when its file/class/method/annotation title clearly matches a configured
  keyword, or its code uses an explicit negative-test construct such as `shouldFail`,
  `assertThrows`, `thrown`, or an expected-exception annotation.
- A keyword found only in ordinary comments or strings, a business `throw`/`catch`, malformed
  source, or any other uncertain signal stays in the `导出用例` worksheet with a review hint.
- `排除明细` records the exact evidence used for exclusions, while `扫描问题` records parse
  failures that were conservatively included.

Run the focused regression test after building a POI 3.13 classpath:

```bash
POI_CLASSPATH="$(find groovy-test/target/dependency -name '*.jar' -printf '%p:' | sed 's/:$//')" \
  bash groovy-test/analyze-normal-groovy-cases.test.sh
```
