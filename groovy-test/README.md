# Groovy case analyzer

`AnalyzeNormalGroovyCases.java` recursively analyzes `.groovy` source files without compiling,
loading, or executing them. It exports an XLSX workbook through Apache POI 3.13, uses
JLine 3.25.1/Jansi 2.4.1 for interactive terminal input, and does not use Groovy, Grape, or
Apache Ivy. `ApplyGroovyCaseGroups.java` is a separate post-review tool that uses the Groovy
3.0.24 conversion-phase AST to update `@Test` annotations. Both tools target Java 8 and do not
call Java 9+ runtime APIs. The Maven build and focused regression scripts can be run with JDK 8
or newer.

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
`0` for `L0`, `1` for `L1`, `5` for `L2`, or `9` to return to the previous row; a real terminal
reads each key immediately without Enter. L2 removes the row from `导出用例`, appends it to
`排除明细`, and records `手工排除` as its evidence. Press `Ctrl+C` to pause safely. Every selection
is written at once. After every included row is classified, a second stage reviews exclusions whose
only evidence is `注释或字符串命中` (rows with title or any other exclusion evidence are skipped).
The prompt shows the previous exclusion decision, matched keywords, and complete exclusion evidence.
In this stage, `0`/`1` moves the row back to `导出用例` as L0/L1, while `5` keeps it in
`排除明细`, marks it L2, and appends `人工复核` to the original evidence. If the workbook already
exists, scanning is skipped and either stage resumes from its first unfinished row. Use
`--regenerate` to intentionally replace it, or `--no-review` for non-interactive batch runs.
Single-key input requires a real terminal; some IDE run consoles may buffer input until Enter.

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

## Apply reviewed levels to Groovy `@Test` groups

After every case has an `人工等级`, apply the workbook levels to the original Groovy sources:

```bash
java -cp "groovy-test/target/classes:groovy-test/target/dependency/*" \
  ApplyGroovyCaseGroups \
  --source ./cases \
  --workbook ./cases/normal-groovy-cases.xlsx
```

The tool reads graded rows from both `导出用例` and `排除明细`, identifies classes and their
class-level/method-level `@Test` annotations through the Groovy AST, and updates the singular
`group` member:

- `@Test` and `@Test()` become `@Test(group = [TestCaseGroup.L0])` for an L0 case.
- Existing entries such as `TestCaseGroup.Completed` are retained and the reviewed level is
  appended.
- An existing L0/L1/L2 entry is replaced when it disagrees with the workbook and is not duplicated
  when it already agrees.
- Annotation-looking text in comments and strings is not considered an annotation.

Use `--dry-run` to validate and report the planned annotation/file counts without writing. The tool
plans and validates the complete workbook first; a missing file, class, `@Test` annotation, malformed
Groovy file, ambiguous multiple level markers, or unsafe relative path stops the run before any source
file is changed. Source files are replaced atomically, and rerunning with the same workbook is
idempotent. Parsing stops at Groovy's conversion phase and disables the `@Grab` transformation, so
the source is never executed and Grape/Ivy dependency resolution is not triggered.

Run the focused regression test after building a POI 3.13 classpath:

```bash
POI_CLASSPATH="$(find groovy-test/target/dependency -name '*.jar' -printf '%p:' | sed 's/:$//')" \
  bash groovy-test/analyze-normal-groovy-cases.test.sh

bash groovy-test/apply-groovy-case-groups.test.sh
```
