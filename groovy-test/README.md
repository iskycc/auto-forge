# Groovy case analyzer

`AnalyzeNormalGroovyCases.java` recursively analyzes `.groovy` source files without compiling,
loading, or executing them. It exports an XLSX workbook through Apache POI 3.13, uses
JLine 3.25.1/Jansi 2.4.1 for interactive terminal input, and does not use Groovy, Grape, or
Apache Ivy. The analyzer targets Java 8 and does not call Java 9+ runtime APIs.
Both the Maven build and the focused regression script can be run with JDK 8 or newer.

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

After creating the workbook, the analyzer reviews every row in `导出用例` interactively. Press
`0` for `L0`, `1` for `L1`, or `9` to return to the previous row; a real terminal reads each key
immediately without Enter. Press `Ctrl+C` to pause safely. Every selection is written to the
`人工等级` column at once. Only rows in `导出用例` are reviewed. If the workbook already exists,
scanning is skipped and review resumes at the first unclassified row. Use `--regenerate` to
intentionally replace it, or `--no-review` for non-interactive batch runs. Single-key input requires
a real terminal; some IDE run consoles may buffer input until Enter.

When `--source` is omitted, the analyzer anchors the scan to its `groovy-test` directory even if
the Java process was started from the repository root by an IDE. The recursive walk does not
follow symbolic links. The resolved root is printed as `Source root: ...` before scanning.

The default exclusion keywords are `Abnormal`, `Exception`, `Error`, `Suspended`, `Insufficient`,
`Closed`, `Frozen`, and `Dormant` (case-insensitive). Add explicitly agreed keywords with
`--extra-keywords A,B,C`. A concatenated keyword also matches the equivalent CamelCase word
sequence, so `statusnew` matches `StatusNew` and `statuspendingactive` matches
`StatusPendingActive`.

Classification follows an exclusion-first rule:

- Each declared class produces one case row. Multiple test methods in the same class are aggregated
  and are never exported as separate rows; Groovy scripts without a class produce one file-level row.
- The case title is always the class name immediately following the `class` keyword. It takes
  precedence over annotation descriptions and other text when classifying a case.
- A class is excluded when its title/file name, any test method name or annotation title clearly
  matches a configured keyword, or its code uses an explicit negative-test construct such as
  `shouldFail`, `assertThrows`, `thrown`, or an expected-exception annotation.
- Keywords found in ordinary comments or strings, business `throw`/`catch`, malformed source, and
  every signal that previously required review now exclude the class directly. When the same keyword
  is already matched by the class title or other metadata, it is recorded only once using the
  higher-priority evidence.
- `排除明细` records the exact evidence used for exclusions, while `扫描问题` records parse
  failures that were excluded.

Run the focused regression test after building a POI 3.13 classpath:

```bash
POI_CLASSPATH="$(find groovy-test/target/dependency -name '*.jar' -printf '%p:' | sed 's/:$//')" \
  bash groovy-test/analyze-normal-groovy-cases.test.sh
```
