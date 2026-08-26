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

When `--source` is omitted, the analyzer anchors the scan to its `groovy-test` directory even if
the Java process was started from the repository root by an IDE. The recursive walk does not
follow symbolic links. The resolved root is printed as `Source root: ...` before scanning.

The default exclusion keywords are `Abnormal`, `Exception`, `Error`, `Suspended`, `Insufficient`,
`Closed`, `Frozen`, and `Dormant` (case-insensitive). Add explicitly agreed keywords with
`--extra-keywords A,B,C`. A concatenated keyword also matches the equivalent CamelCase word
sequence, so `statusnew` matches `StatusNew` and `statuspendingactive` matches
`StatusPendingActive`.

Classification follows a conservative inclusion rule:

- Each declared class produces one case row. Multiple test methods in the same class are aggregated
  and are never exported as separate rows; Groovy scripts without a class produce one file-level row.
- A class is excluded when its file/class name, any test method name or annotation title clearly
  matches a configured keyword, or its code uses an explicit negative-test construct such as
  `shouldFail`, `assertThrows`, `thrown`, or an expected-exception annotation.
- A keyword found only in ordinary comments or strings, a business `throw`/`catch`, malformed
  source, or any other uncertain signal stays in the `导出用例` worksheet with a review hint.
- `排除明细` records the exact evidence used for exclusions, while `扫描问题` records parse
  failures that were conservatively included.

Run the focused regression test after building a POI 3.13 classpath:

```bash
POI_CLASSPATH="$(find groovy-test/target/dependency -name '*.jar' -printf '%p:' | sed 's/:$//')" \
  bash groovy-test/analyze-normal-groovy-cases.test.sh
```
