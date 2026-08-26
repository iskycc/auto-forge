import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;

/**
 * Statically analyzes Groovy source files without loading or compiling them and exports likely
 * normal test cases to an XLSX workbook.
 *
 * <p>The runtime classpath must provide Apache POI 3.13 and its transitive dependencies. The
 * analyzer intentionally has no dependency on Groovy, Grape, or Apache Ivy.
 */
public final class AnalyzeNormalGroovyCases {
  private static final String METADATA_FIELD_SEPARATOR = "\u0000";
  private static final Pattern IDENTIFIER_WORD_PATTERN =
      Pattern.compile("[\\p{L}\\p{N}]+");

  private AnalyzeNormalGroovyCases() {}

  public static void main(String[] arguments) {
    try {
      AnalyzerOptions options = AnalyzerOptions.parse(Arrays.asList(arguments));
      if (options.showHelp) {
        System.out.println(AnalyzerOptions.usage());
        return;
      }

      System.out.println("Source root: " + options.sourceRoot);
      AnalysisReport report = new GroovyCaseAnalyzer(options).analyze();
      new CaseWorkbookWriter().write(report, options);

      System.out.printf(
          "Scanned %d Groovy file(s) and %d case candidate(s).%n",
          report.sourceFileCount, report.candidateCount());
      System.out.printf(
          "Exported %d included case(s); %d candidate(s) were excluded.%n",
          report.includedCases.size(), report.excludedCases.size());
      if (!report.scanIssues.isEmpty()) {
        System.out.printf(
            "%d file(s) had scan issues; see the '扫描问题' worksheet.%n",
            report.scanIssues.size());
      }
      System.out.println("Workbook: " + options.outputFile);
    } catch (IllegalArgumentException error) {
      System.err.println("Invalid arguments: " + error.getMessage());
      System.err.println(AnalyzerOptions.usage());
      System.exit(2);
    } catch (Exception error) {
      throw new IllegalStateException("Failed to analyze Groovy cases", error);
    }
  }

  private static final class AnalyzerOptions {
    private static final List<String> DEFAULT_NEGATIVE_KEYWORDS =
        Collections.unmodifiableList(
            Arrays.asList(
                "abnormal",
                "exception",
                "error",
                "suspended",
                "insufficient",
                "closed",
                "frozen",
                "dormant"));

    private final Path sourceRoot;
    private final Path outputFile;
    private final List<String> negativeKeywords;
    private final boolean showHelp;

    private AnalyzerOptions(
        Path sourceRoot, Path outputFile, List<String> negativeKeywords, boolean showHelp) {
      this.sourceRoot = sourceRoot;
      this.outputFile = outputFile;
      this.negativeKeywords = negativeKeywords;
      this.showHelp = showHelp;
    }

    private static AnalyzerOptions parse(List<String> arguments) {
      Path sourceRoot = defaultSourceRoot();
      Path outputFile = null;
      List<String> extraKeywords = new ArrayList<>();
      boolean showHelp = false;

      for (int index = 0; index < arguments.size(); index++) {
        String argument = arguments.get(index);
        switch (argument) {
          case "--source":
            sourceRoot =
                Paths.get(requiredValue(arguments, ++index, argument))
                    .toAbsolutePath()
                    .normalize();
            break;
          case "--output":
            outputFile =
                Paths.get(requiredValue(arguments, ++index, argument))
                    .toAbsolutePath()
                    .normalize();
            break;
          case "--extra-keywords":
            extraKeywords.addAll(
                splitKeywords(requiredValue(arguments, ++index, argument)));
            break;
          case "--help":
          case "-h":
            showHelp = true;
            break;
          default:
            throw new IllegalArgumentException("Unknown option: " + argument);
        }
      }

      if (!Files.exists(sourceRoot)) {
        throw new IllegalArgumentException("Source directory does not exist: " + sourceRoot);
      }
      if (!Files.isDirectory(sourceRoot)) {
        throw new IllegalArgumentException("Source path is not a directory: " + sourceRoot);
      }

      Path resolvedOutput =
          outputFile == null ? sourceRoot.resolve("normal-groovy-cases.xlsx") : outputFile;
      if (!resolvedOutput
          .getFileName()
          .toString()
          .toLowerCase(Locale.ROOT)
          .endsWith(".xlsx")) {
        throw new IllegalArgumentException("Output file must have an .xlsx extension");
      }

      List<String> keywords = new ArrayList<>(DEFAULT_NEGATIVE_KEYWORDS);
      for (String keyword : extraKeywords) {
        boolean alreadyPresent = false;
        for (String existing : keywords) {
          if (existing.equalsIgnoreCase(keyword)) {
            alreadyPresent = true;
            break;
          }
        }
        if (!alreadyPresent) {
          keywords.add(keyword);
        }
      }
      return new AnalyzerOptions(
          sourceRoot,
          resolvedOutput,
          Collections.unmodifiableList(keywords),
          showHelp);
    }

    private static String usage() {
      return String.join(
          System.lineSeparator(),
          "Usage:",
          "  java -cp \"classes:lib/*\" AnalyzeNormalGroovyCases [options]",
          "",
          "Options:",
          "  --source DIR              Override the analyzer directory used as the scan root",
          "  --output FILE.xlsx        Output workbook (default: DIR/normal-groovy-cases.xlsx)",
          "  --extra-keywords A,B,C    Add comma-separated exclusion keywords",
          "  -h, --help                Show this help",
          "",
          "Example:",
          "  java -cp \"target/classes:lib/*\" AnalyzeNormalGroovyCases \\",
          "    --source ./cases --output ./normal-cases.xlsx");
    }

    private static Path defaultSourceRoot() {
      Path workingDirectory = Paths.get("").toAbsolutePath().normalize();
      if (workingDirectory.getFileName() != null
          && workingDirectory.getFileName().toString().equals("groovy-test")) {
        return workingDirectory;
      }

      Path groovyTestChild = workingDirectory.resolve("groovy-test");
      if (Files.isDirectory(groovyTestChild)) {
        return groovyTestChild.toAbsolutePath().normalize();
      }

      Path codeLocation = analyzerCodeLocation();
      for (Path candidate = codeLocation; candidate != null; candidate = candidate.getParent()) {
        if (candidate.getFileName() != null
            && candidate.getFileName().toString().equals("groovy-test")) {
          return candidate.toAbsolutePath().normalize();
        }
      }
      return workingDirectory;
    }

    private static Path analyzerCodeLocation() {
      try {
        Path location =
            Paths.get(
                    AnalyzeNormalGroovyCases.class
                        .getProtectionDomain()
                        .getCodeSource()
                        .getLocation()
                        .toURI())
                .toAbsolutePath()
                .normalize();
        return Files.isDirectory(location) ? location : location.getParent();
      } catch (Exception ignored) {
        // A restricted class loader may hide its code source; the working directory remains safe.
        return null;
      }
    }

    private static String requiredValue(List<String> arguments, int index, String option) {
      if (index >= arguments.size() || arguments.get(index).startsWith("--")) {
        throw new IllegalArgumentException(option + " requires a value");
      }
      return arguments.get(index);
    }

    private static List<String> splitKeywords(String value) {
      List<String> keywords = new ArrayList<>();
      for (String part : value.split(",", -1)) {
        String keyword = part.trim();
        if (!keyword.isEmpty()) {
          keywords.add(keyword);
        }
      }
      if (keywords.isEmpty()) {
        throw new IllegalArgumentException(
            "--extra-keywords requires at least one keyword");
      }
      return keywords;
    }
  }

  private static final class AnalysisReport {
    private int sourceFileCount;
    private final List<AnalyzedCase> includedCases = new ArrayList<>();
    private final List<AnalyzedCase> excludedCases = new ArrayList<>();
    private final List<ScanIssue> scanIssues = new ArrayList<>();

    private int candidateCount() {
      return includedCases.size() + excludedCases.size();
    }
  }

  private static final class ScanIssue {
    private final String relativePath;
    private final String message;

    private ScanIssue(String relativePath, String message) {
      this.relativePath = relativePath;
      this.message = message;
    }
  }

  private static final class AnalyzedCase {
    private String title;
    private String packageName;
    private String className;
    private String relativePath;
    private int lineNumber;
    private String discoveryKind;
    private String decision;
    private List<String> matchedKeywords = Collections.emptyList();
    private List<String> exclusionEvidence = Collections.emptyList();
  }

  private static final class CaseCandidate {
    private String title;
    private String packageName;
    private String className;
    private String relativePath;
    private int lineNumber;
    private String discoveryKind;
    private String metadata;
    private String sourceScope;
    private String forcedExclusionReason;
  }

  private static final class GroovyCaseAnalyzer {
    private static final String ANALYZER_GROOVY_FILE_NAME =
        "AnalyzeNormalGroovyCases.groovy";
    private static final Set<String> TEST_ANNOTATIONS =
        Collections.unmodifiableSet(
            new LinkedHashSet<>(
                Arrays.asList(
                    "Test",
                    "TestCase",
                    "Unroll",
                    "Feature",
                    "ParameterizedTest",
                    "RepeatedTest",
                    "TestFactory",
                    "TestTemplate",
                    "Property")));
    private static final Set<String> SPOCK_LIFECYCLE_METHODS =
        Collections.unmodifiableSet(
            new LinkedHashSet<>(
                Arrays.asList("setup", "cleanup", "setupSpec", "cleanupSpec")));
    private static final List<SemanticPattern> CLEAR_NEGATIVE_SEMANTICS =
        Collections.unmodifiableList(
            Arrays.asList(
                new SemanticPattern(
                    "shouldFail 异常断言",
                    Pattern.compile("(?i)\\bshouldFail\\s*[({]")),
                new SemanticPattern(
                    "assertThrows 异常断言",
                    Pattern.compile("(?i)\\bassertThrows\\s*\\(")),
                new SemanticPattern(
                    "thrown 异常断言",
                    Pattern.compile("(?i)(?<!not)\\bthrown\\s*\\(")),
                new SemanticPattern(
                    "期望异常配置",
                    Pattern.compile(
                        "(?i)\\bexpected(?:Exceptions?)?\\s*=\\s*"
                            + "[^,)}\\r\\n]*(?:Exception|Error)\\b"))));
    private static final List<SemanticPattern> ADDITIONAL_EXCLUSION_SEMANTICS =
        Collections.unmodifiableList(
            Arrays.asList(
                new SemanticPattern(
                    "代码主动抛出异常",
                    Pattern.compile(
                        "(?i)\\bthrow\\s+new\\s+[\\w.]*?(?:Exception|Error)\\b")),
                new SemanticPattern(
                    "代码捕获异常",
                    Pattern.compile(
                        "(?i)\\bcatch\\s*\\([^)]*[\\w.]*?(?:Exception|Error)\\b"))));

    private final AnalyzerOptions options;

    private GroovyCaseAnalyzer(AnalyzerOptions options) {
      this.options = options;
    }

    private AnalysisReport analyze() throws IOException {
      List<Path> sourceFiles = findSourceFiles();
      AnalysisReport report = new AnalysisReport();
      report.sourceFileCount = sourceFiles.size();

      for (Path sourceFile : sourceFiles) {
        String relativePath = displayPath(sourceFile);
        try {
          String source = readUtf8(sourceFile);
          List<CaseCandidate> candidates =
              new GroovyDeclarationParser(relativePath, source).discoverCandidates();
          for (CaseCandidate candidate : candidates) {
            addClassifiedCase(report, classify(candidate));
          }
        } catch (Exception error) {
          report.scanIssues.add(new ScanIssue(relativePath, rootMessage(error)));
          CaseCandidate fallback = fallbackCandidate(sourceFile, relativePath, error);
          addClassifiedCase(report, classify(fallback));
        }
      }

      Comparator<AnalyzedCase> byLocation =
          Comparator.comparing((AnalyzedCase testCase) -> testCase.relativePath)
              .thenComparingInt(testCase -> testCase.lineNumber);
      report.includedCases.sort(byLocation);
      report.excludedCases.sort(byLocation);
      report.scanIssues.sort(Comparator.comparing(issue -> issue.relativePath));
      return report;
    }

    private void addClassifiedCase(AnalysisReport report, AnalyzedCase analyzedCase) {
      if (analyzedCase.exclusionEvidence.isEmpty()) {
        report.includedCases.add(analyzedCase);
      } else {
        report.excludedCases.add(analyzedCase);
      }
    }

    private List<Path> findSourceFiles() throws IOException {
      List<Path> sourceFiles = new ArrayList<>();
      try (Stream<Path> paths = Files.walk(options.sourceRoot)) {
        paths
            .filter(this::isGroovySource)
            .forEach(path -> sourceFiles.add(path.toAbsolutePath().normalize()));
      }
      sourceFiles.sort(Comparator.comparing(this::displayPath));
      return sourceFiles;
    }

    private boolean isGroovySource(Path path) {
      if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
        return false;
      }
      String fileName = path.getFileName().toString();
      return fileName.endsWith(".groovy")
          && !fileName.equals(ANALYZER_GROOVY_FILE_NAME);
    }

    private CaseCandidate fallbackCandidate(
        Path sourceFile, String relativePath, Exception error) {
      CaseCandidate candidate = new CaseCandidate();
      candidate.title = baseName(sourceFile);
      candidate.packageName = "";
      candidate.className = baseName(sourceFile);
      candidate.relativePath = relativePath;
      candidate.lineNumber = 1;
      candidate.discoveryKind = "文件级兜底（解析失败）";
      candidate.metadata = baseName(sourceFile);
      candidate.sourceScope = "";
      candidate.forcedExclusionReason = "无法可靠解析，已排除：" + rootMessage(error);
      return candidate;
    }

    private AnalyzedCase classify(CaseCandidate candidate) {
      LinkedHashSet<String> matchedKeywords = new LinkedHashSet<>();
      List<String> exclusionEvidence = new ArrayList<>();

      List<String> titleMatches =
          findKeywords(candidate.title, options.negativeKeywords);
      if (!titleMatches.isEmpty()) {
        matchedKeywords.addAll(titleMatches);
        String titleSource =
            candidate.discoveryKind.startsWith("类级用例")
                ? "标题（class 后的类名）"
                : "文件标题";
        exclusionEvidence.add(
            titleSource + "明确命中：" + String.join(", ", titleMatches));
      }

      List<String> metadataMatches =
          findKeywords(candidate.metadata, options.negativeKeywords);
      metadataMatches.removeAll(titleMatches);
      if (!metadataMatches.isEmpty()) {
        matchedKeywords.addAll(metadataMatches);
        exclusionEvidence.add(
            "文件名、方法名或注解标题明确命中："
                + String.join(", ", metadataMatches));
      }

      String code = maskCommentsAndStrings(candidate.sourceScope);
      for (SemanticPattern semantic : CLEAR_NEGATIVE_SEMANTICS) {
        Matcher matcher = semantic.pattern.matcher(code);
        if (matcher.find()) {
          exclusionEvidence.add(
              semantic.label + "：" + compactExcerpt(candidate.sourceScope, matcher.start()));
        }
      }

      String narrative = narrativeText(candidate.sourceScope);
      List<String> narrativeMatches =
          findKeywords(narrative, options.negativeKeywords);
      narrativeMatches.removeAll(titleMatches);
      narrativeMatches.removeAll(metadataMatches);
      if (!narrativeMatches.isEmpty()) {
        matchedKeywords.addAll(narrativeMatches);
        exclusionEvidence.add(
            "注释或字符串命中：" + String.join(", ", narrativeMatches));
      }
      for (SemanticPattern semantic : ADDITIONAL_EXCLUSION_SEMANTICS) {
        Matcher matcher = semantic.pattern.matcher(code);
        if (matcher.find()) {
          exclusionEvidence.add(
              semantic.label + "：" + compactExcerpt(candidate.sourceScope, matcher.start()));
        }
      }
      if (candidate.forcedExclusionReason != null) {
        exclusionEvidence.add(candidate.forcedExclusionReason);
      }

      AnalyzedCase analyzedCase = new AnalyzedCase();
      analyzedCase.title = candidate.title;
      analyzedCase.packageName = candidate.packageName;
      analyzedCase.className = candidate.className;
      analyzedCase.relativePath = candidate.relativePath;
      analyzedCase.lineNumber = candidate.lineNumber;
      analyzedCase.discoveryKind = candidate.discoveryKind;
      analyzedCase.matchedKeywords = new ArrayList<>(matchedKeywords);
      analyzedCase.exclusionEvidence = exclusionEvidence;
      if (!exclusionEvidence.isEmpty()) {
        analyzedCase.decision = "排除（命中排除信号）";
      } else {
        analyzedCase.decision = "纳入（未发现排除信号）";
      }
      return analyzedCase;
    }

    private String displayPath(Path sourceFile) {
      return options.sourceRoot
          .relativize(sourceFile)
          .toString()
          .replace(java.io.File.separatorChar, '/');
    }
  }

  private static final class GroovyDeclarationParser {
    private static final String PACKAGE_IDENTIFIER =
        "[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*";
    private static final Pattern PACKAGE_DECLARATION =
        Pattern.compile(
            "(?m)^[ \\t]*package[ \\t]+("
                + PACKAGE_IDENTIFIER
                + "(?:[ \\t]*\\.[ \\t]*"
                + PACKAGE_IDENTIFIER
                + ")*)");
    private static final Set<String> NON_METHOD_NAMES =
        Collections.unmodifiableSet(
            new LinkedHashSet<>(
                Arrays.asList(
                    "if",
                    "for",
                    "while",
                    "switch",
                    "catch",
                    "new",
                    "super",
                    "this",
                    "assert",
                    "synchronized")));

    private final String relativePath;
    private final String source;
    private final List<Token> tokens;

    private GroovyDeclarationParser(String relativePath, String source) {
      this.relativePath = relativePath;
      this.source = source;
      this.tokens = new GroovyLexer(source).tokenize();
    }

    private List<CaseCandidate> discoverCandidates() {
      String packageName = discoverPackageName();
      List<ClassSpan> classes = discoverClasses();
      if (classes.isEmpty()) {
        return Collections.singletonList(scriptCandidate(packageName));
      }

      List<CaseCandidate> candidates = new ArrayList<>();
      for (ClassSpan classSpan : classes) {
        List<MethodSpan> methods = discoverTestMethods(classSpan);
        candidates.add(classCandidate(packageName, classSpan, methods));
      }
      return candidates;
    }

    private String discoverPackageName() {
      // Groovy package declarations normally have no semicolon. Matching the declaration line
      // directly prevents the following import statement from being appended when no punctuation
      // separates the two lines. The identifier-only capture also ignores optional trailing
      // semicolons or comments.
      Matcher matcher = PACKAGE_DECLARATION.matcher(maskCommentsAndStrings(source));
      return matcher.find() ? matcher.group(1).replaceAll("[ \\t]", "") : "";
    }

    private List<ClassSpan> discoverClasses() {
      List<ClassSpan> classes = new ArrayList<>();
      for (int index = 0; index < tokens.size() - 2; index++) {
        Token keyword = tokens.get(index);
        if (!keyword.isIdentifier("class")) {
          continue;
        }
        Token name = tokens.get(index + 1);
        if (name.type != TokenType.IDENTIFIER) {
          continue;
        }
        int openBrace = findNextSymbol(index + 2, "{", ";");
        if (openBrace < 0) {
          throw new SourceParseException(
              "Class " + name.text + " has no opening brace at line " + keyword.line);
        }
        int closeBrace = findMatching(openBrace, "{", "}");
        if (closeBrace < 0) {
          throw new SourceParseException(
              "Class " + name.text + " has an unclosed body at line " + keyword.line);
        }
        int annotationStart = findAnnotationStart(index, 0);
        String annotations = source.substring(tokens.get(annotationStart).start, keyword.start);
        classes.add(
            new ClassSpan(name.text, keyword.line, index, openBrace, closeBrace, annotations));
      }
      return classes;
    }

    private List<MethodSpan> discoverTestMethods(ClassSpan classSpan) {
      boolean classLevelTest = hasTestAnnotation(classSpan.annotations);
      boolean spockSpecification =
          classSpan.name.endsWith("Spec") || classSpan.name.endsWith("Specification");
      List<MethodSpan> methods = new ArrayList<>();
      int memberStart = classSpan.openBraceToken + 1;
      int braceDepth = 0;

      for (int index = classSpan.openBraceToken + 1;
          index < classSpan.closeBraceToken;
          index++) {
        Token token = tokens.get(index);
        if (token.isSymbol("{")) {
          braceDepth++;
          continue;
        }
        if (token.isSymbol("}")) {
          if (braceDepth > 0) {
            braceDepth--;
          }
          if (braceDepth == 0) {
            memberStart = index + 1;
          }
          continue;
        }
        if (braceDepth != 0) {
          continue;
        }
        if (token.isSymbol(";")) {
          memberStart = index + 1;
          continue;
        }
        if (!isPotentialMethodName(token) || index + 1 >= classSpan.closeBraceToken) {
          continue;
        }
        if (!tokens.get(index + 1).isSymbol("(") || isInvocation(index)) {
          continue;
        }

        int closeParenthesis = findMatching(index + 1, "(", ")");
        if (closeParenthesis < 0 || closeParenthesis >= classSpan.closeBraceToken) {
          throw new SourceParseException(
              "Unclosed method parameters at line " + token.line);
        }
        int bodyOpen = findMethodBodyOpen(closeParenthesis + 1, classSpan.closeBraceToken);
        if (bodyOpen < 0) {
          continue;
        }
        int bodyClose = findMatching(bodyOpen, "{", "}");
        if (bodyClose < 0 || bodyClose > classSpan.closeBraceToken) {
          throw new SourceParseException("Unclosed method body at line " + token.line);
        }

        int annotationStart = findAnnotationStart(index, memberStart);
        String prefix = source.substring(tokens.get(annotationStart).start, token.start);
        String methodName = token.type == TokenType.STRING ? unquote(token.text) : token.text;
        if (methodName.equals(classSpan.name)
            || GroovyCaseAnalyzer.SPOCK_LIFECYCLE_METHODS.contains(methodName)) {
          index = bodyClose;
          memberStart = bodyClose + 1;
          continue;
        }
        boolean annotatedTest = hasTestAnnotation(prefix);
        boolean testStyleName = isTestStyleName(methodName);
        boolean classMethod = classLevelTest && !containsWord(prefix, "private");
        if (annotatedTest || testStyleName || classMethod || spockSpecification) {
          methods.add(new MethodSpan(methodName, prefix));
        }
        index = bodyClose;
        memberStart = bodyClose + 1;
      }
      return methods;
    }

    private CaseCandidate scriptCandidate(String packageName) {
      String name = baseName(relativePath);
      CaseCandidate candidate = baseCandidate(packageName, name, 1);
      candidate.title = name;
      candidate.discoveryKind = "Groovy 脚本";
      candidate.metadata = name;
      candidate.sourceScope = source;
      return candidate;
    }

    private CaseCandidate classCandidate(
        String packageName, ClassSpan classSpan, List<MethodSpan> methods) {
      CaseCandidate candidate =
          baseCandidate(packageName, classSpan.name, classSpan.line);
      candidate.title = classSpan.name;
      candidate.discoveryKind =
          methods.isEmpty()
              ? "类级用例（未发现测试方法）"
              : "类级用例（汇总 " + methods.size() + " 个测试方法）";
      List<String> metadataFields = new ArrayList<>();
      metadataFields.add(baseName(relativePath));
      metadataFields.add(classSpan.annotations);
      for (MethodSpan method : methods) {
        metadataFields.add(method.name);
        metadataFields.add(method.annotations);
      }
      candidate.metadata = joinMetadataFields(metadataFields);
      candidate.sourceScope =
          source.substring(
              tokens.get(classSpan.classToken).start,
              tokens.get(classSpan.closeBraceToken).end);
      return candidate;
    }

    private CaseCandidate baseCandidate(String packageName, String className, int line) {
      CaseCandidate candidate = new CaseCandidate();
      candidate.packageName = packageName;
      candidate.className = className;
      candidate.relativePath = relativePath;
      candidate.lineNumber = line;
      return candidate;
    }

    private boolean isPotentialMethodName(Token token) {
      return (token.type == TokenType.IDENTIFIER
              && !NON_METHOD_NAMES.contains(token.text))
          || token.type == TokenType.STRING;
    }

    private boolean isInvocation(int methodNameToken) {
      if (methodNameToken == 0) {
        return false;
      }
      Token previous = tokens.get(methodNameToken - 1);
      return previous.isSymbol(".")
          || previous.isSymbol("@")
          || previous.isIdentifier("new");
    }

    private int findMethodBodyOpen(int start, int limit) {
      for (int index = start; index < limit; index++) {
        Token token = tokens.get(index);
        if (token.isSymbol("{")) {
          return index;
        }
        if (token.isSymbol(";") || token.isSymbol("=") || token.isSymbol("}")) {
          return -1;
        }
      }
      return -1;
    }

    private int findNextSymbol(int start, String wanted, String stop) {
      for (int index = start; index < tokens.size(); index++) {
        Token token = tokens.get(index);
        if (token.isSymbol(wanted)) {
          return index;
        }
        if (token.isSymbol(stop)) {
          return -1;
        }
      }
      return -1;
    }

    private int findMatching(int openIndex, String open, String close) {
      int depth = 0;
      for (int index = openIndex; index < tokens.size(); index++) {
        Token token = tokens.get(index);
        if (token.isSymbol(open)) {
          depth++;
        } else if (token.isSymbol(close)) {
          depth--;
          if (depth == 0) {
            return index;
          }
        }
      }
      return -1;
    }

    private int findAnnotationStart(int tokenIndex, int lowerBound) {
      int start = tokenIndex;
      for (int index = tokenIndex - 1; index >= lowerBound; index--) {
        Token token = tokens.get(index);
        if (token.isSymbol(";") || token.isSymbol("{") || token.isSymbol("}")) {
          break;
        }
        start = index;
      }
      for (int index = start; index < tokenIndex; index++) {
        if (tokens.get(index).isSymbol("@")) {
          return index;
        }
      }
      return tokenIndex;
    }

    private static boolean hasTestAnnotation(String text) {
      for (String annotation : GroovyCaseAnalyzer.TEST_ANNOTATIONS) {
        if (Pattern.compile("(?s)@(?:[\\w$]+\\.)*" + Pattern.quote(annotation) + "\\b")
            .matcher(text)
            .find()) {
          return true;
        }
      }
      return false;
    }

    private static boolean isTestStyleName(String name) {
      return name.matches("(?i)test(?:[A-Z0-9_].*)?") || name.contains(" ");
    }

    private static boolean containsWord(String text, String word) {
      return Pattern.compile(
              "(?i)(?<![\\p{L}\\p{N}_])"
                  + Pattern.quote(word)
                  + "(?![\\p{L}\\p{N}_])")
          .matcher(text)
          .find();
    }

  }

  private enum TokenType {
    IDENTIFIER,
    STRING,
    SYMBOL
  }

  private static final class Token {
    private final TokenType type;
    private final String text;
    private final int start;
    private final int end;
    private final int line;

    private Token(TokenType type, String text, int start, int end, int line) {
      this.type = type;
      this.text = text;
      this.start = start;
      this.end = end;
      this.line = line;
    }

    private boolean isIdentifier(String value) {
      return type == TokenType.IDENTIFIER && text.equals(value);
    }

    private boolean isSymbol(String value) {
      return type == TokenType.SYMBOL && text.equals(value);
    }
  }

  private static final class GroovyLexer {
    private final String source;
    private int offset;
    private int line = 1;

    private GroovyLexer(String source) {
      this.source = source;
    }

    private List<Token> tokenize() {
      List<Token> tokens = new ArrayList<>();
      while (offset < source.length()) {
        char character = source.charAt(offset);
        if (Character.isWhitespace(character)) {
          consumeWhitespace();
        } else if (startsWith("//")) {
          consumeLineComment();
        } else if (startsWith("/*")) {
          consumeBlockComment();
        } else if (character == '\'' || character == '"') {
          tokens.add(consumeString(character));
        } else if (Character.isJavaIdentifierStart(character)) {
          tokens.add(consumeIdentifier());
        } else {
          tokens.add(
              new Token(
                  TokenType.SYMBOL, String.valueOf(character), offset, offset + 1, line));
          offset++;
        }
      }
      return tokens;
    }

    private void consumeWhitespace() {
      while (offset < source.length() && Character.isWhitespace(source.charAt(offset))) {
        if (source.charAt(offset) == '\n') {
          line++;
        }
        offset++;
      }
    }

    private void consumeLineComment() {
      offset += 2;
      while (offset < source.length() && source.charAt(offset) != '\n') {
        offset++;
      }
    }

    private void consumeBlockComment() {
      int startLine = line;
      offset += 2;
      while (offset + 1 < source.length() && !startsWith("*/")) {
        if (source.charAt(offset) == '\n') {
          line++;
        }
        offset++;
      }
      if (offset + 1 >= source.length()) {
        throw new SourceParseException("Unclosed block comment at line " + startLine);
      }
      offset += 2;
    }

    private Token consumeString(char quote) {
      int start = offset;
      int startLine = line;
      boolean triple =
          offset + 2 < source.length()
              && source.charAt(offset + 1) == quote
              && source.charAt(offset + 2) == quote;
      offset += triple ? 3 : 1;
      while (offset < source.length()) {
        if (source.charAt(offset) == '\n') {
          line++;
        }
        if (!triple && source.charAt(offset) == '\\' && offset + 1 < source.length()) {
          offset += 2;
          continue;
        }
        if (triple && offset + 2 < source.length()
            && source.charAt(offset) == quote
            && source.charAt(offset + 1) == quote
            && source.charAt(offset + 2) == quote) {
          offset += 3;
          return new Token(
              TokenType.STRING, source.substring(start, offset), start, offset, startLine);
        }
        if (!triple && source.charAt(offset) == quote) {
          offset++;
          return new Token(
              TokenType.STRING, source.substring(start, offset), start, offset, startLine);
        }
        offset++;
      }
      throw new SourceParseException("Unclosed string at line " + startLine);
    }

    private Token consumeIdentifier() {
      int start = offset;
      int startLine = line;
      offset++;
      while (offset < source.length()
          && Character.isJavaIdentifierPart(source.charAt(offset))) {
        offset++;
      }
      return new Token(
          TokenType.IDENTIFIER, source.substring(start, offset), start, offset, startLine);
    }

    private boolean startsWith(String value) {
      return source.startsWith(value, offset);
    }
  }

  private static final class ClassSpan {
    private final String name;
    private final int line;
    private final int classToken;
    private final int openBraceToken;
    private final int closeBraceToken;
    private final String annotations;

    private ClassSpan(
        String name,
        int line,
        int classToken,
        int openBraceToken,
        int closeBraceToken,
        String annotations) {
      this.name = name;
      this.line = line;
      this.classToken = classToken;
      this.openBraceToken = openBraceToken;
      this.closeBraceToken = closeBraceToken;
      this.annotations = annotations;
    }
  }

  private static final class MethodSpan {
    private final String name;
    private final String annotations;

    private MethodSpan(String name, String annotations) {
      this.name = name;
      this.annotations = annotations;
    }
  }

  private static final class SemanticPattern {
    private final String label;
    private final Pattern pattern;

    private SemanticPattern(String label, Pattern pattern) {
      this.label = label;
      this.pattern = pattern;
    }
  }

  private static final class SourceParseException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private SourceParseException(String message) {
      super(message);
    }
  }

  private static final class CaseWorkbookWriter {
    private static final int MAX_CELL_CHARACTERS = 32_000;

    private void write(AnalysisReport report, AnalyzerOptions options) throws IOException {
      Path parent = options.outputFile.getParent();
      if (parent == null) {
        throw new IllegalArgumentException("Output file must have a parent directory");
      }
      Files.createDirectories(parent);
      if (Files.exists(options.outputFile, LinkOption.NOFOLLOW_LINKS)
          && !Files.isRegularFile(options.outputFile, LinkOption.NOFOLLOW_LINKS)) {
        throw new IOException("Output path is not a regular file: " + options.outputFile);
      }

      SXSSFWorkbook workbook = new SXSSFWorkbook(200);
      workbook.setCompressTempFiles(true);
      Path temporaryFile =
          Files.createTempFile(parent, ".normal-groovy-cases-", ".xlsx");
      try {
        WorkbookStyles styles = WorkbookStyles.create(workbook);
        writeIncludedCases(workbook, styles, report.includedCases);
        writeExcludedCases(workbook, styles, report.excludedCases);
        writeScanIssues(workbook, styles, report.scanIssues);
        writeSummary(workbook, styles, report, options);

        try (OutputStream output =
            Files.newOutputStream(
                temporaryFile,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE)) {
          workbook.write(output);
        }
        moveAtomically(temporaryFile, options.outputFile);
      } finally {
        workbook.close();
        workbook.dispose();
        Files.deleteIfExists(temporaryFile);
      }
    }

    private static void writeIncludedCases(
        Workbook workbook, WorkbookStyles styles, List<AnalyzedCase> cases) {
      List<String> headers =
          Arrays.asList(
              "序号",
              "用例标题",
              "包名",
              "类名",
              "相对路径",
              "起始行",
              "识别方式",
              "导出判断");
      List<List<Object>> rows = new ArrayList<>();
      for (int index = 0; index < cases.size(); index++) {
        AnalyzedCase testCase = cases.get(index);
        rows.add(
            Arrays.asList(
                index + 1,
                testCase.title,
                testCase.packageName,
                testCase.className,
                testCase.relativePath,
                testCase.lineNumber,
                testCase.discoveryKind,
                testCase.decision));
      }
      writeTable(
          workbook,
          styles,
          "导出用例",
          headers,
          rows,
          Arrays.asList(8, 34, 28, 30, 48, 10, 32, 42));
    }

    private static void writeExcludedCases(
        Workbook workbook, WorkbookStyles styles, List<AnalyzedCase> cases) {
      List<String> headers =
          Arrays.asList(
              "序号",
              "用例标题",
              "包名",
              "类名",
              "相对路径",
              "起始行",
              "识别方式",
              "排除判断",
              "命中关键词",
              "排除证据");
      List<List<Object>> rows = new ArrayList<>();
      for (int index = 0; index < cases.size(); index++) {
        AnalyzedCase testCase = cases.get(index);
        rows.add(
            Arrays.asList(
                index + 1,
                testCase.title,
                testCase.packageName,
                testCase.className,
                testCase.relativePath,
                testCase.lineNumber,
                testCase.discoveryKind,
                testCase.decision,
                String.join(", ", testCase.matchedKeywords),
                String.join("\n", testCase.exclusionEvidence)));
      }
      writeTable(
          workbook,
          styles,
          "排除明细",
          headers,
          rows,
          Arrays.asList(8, 34, 28, 30, 48, 10, 32, 36, 30, 72));
    }

    private static void writeScanIssues(
        Workbook workbook, WorkbookStyles styles, List<ScanIssue> issues) {
      List<List<Object>> rows = new ArrayList<>();
      for (ScanIssue issue : issues) {
        rows.add(Arrays.asList(issue.relativePath, issue.message, "已排除"));
      }
      writeTable(
          workbook,
          styles,
          "扫描问题",
          Arrays.asList("相对路径", "问题", "处理结果"),
          rows,
          Arrays.asList(52, 100, 36));
    }

    private static void writeSummary(
        Workbook workbook,
        WorkbookStyles styles,
        AnalysisReport report,
        AnalyzerOptions options) {
      List<List<Object>> rows = new ArrayList<>();
      rows.add(Arrays.asList("生成时间（UTC）", Instant.now().toString()));
      rows.add(Arrays.asList("扫描目录", options.sourceRoot.toString()));
      rows.add(Arrays.asList("输出文件", options.outputFile.toString()));
      rows.add(Arrays.asList("Groovy 文件数", report.sourceFileCount));
      rows.add(Arrays.asList("候选用例数", report.candidateCount()));
      rows.add(Arrays.asList("导出用例数", report.includedCases.size()));
      rows.add(Arrays.asList("排除用例数", report.excludedCases.size()));
      rows.add(Arrays.asList("扫描问题文件数", report.scanIssues.size()));
      rows.add(Arrays.asList("默认异常关键词", String.join(", ", options.negativeKeywords)));
      rows.add(
          Arrays.asList(
              "排除规则",
              "class 后的类名作为标题并优先判定；标题、文件/方法名、注解标题、注释或字符串命中关键词，"
                  + "以及异常断言、throw/catch、解析失败等任何原复核信号，均直接排除。"));
      rows.add(
          Arrays.asList(
              "分析边界",
              "纯 Java 词法和声明扫描，不加载、不编译、不执行 Groovy 源码，"
                  + "也不解析 @Grab 依赖。"));
      writeTable(
          workbook,
          styles,
          "扫描说明",
          Arrays.asList("项目", "内容"),
          rows,
          Arrays.asList(24, 120));
    }

    private static void writeTable(
        Workbook workbook,
        WorkbookStyles styles,
        String sheetName,
        List<String> headers,
        List<List<Object>> values,
        List<Integer> columnWidths) {
      Sheet sheet = workbook.createSheet(sheetName);
      Row header = sheet.createRow(0);
      for (int columnIndex = 0; columnIndex < headers.size(); columnIndex++) {
        Cell cell = header.createCell(columnIndex);
        cell.setCellValue(headers.get(columnIndex));
        cell.setCellStyle(styles.header);
      }
      header.setHeightInPoints(28);

      for (int rowIndex = 0; rowIndex < values.size(); rowIndex++) {
        Row row = sheet.createRow(rowIndex + 1);
        List<Object> rowValues = values.get(rowIndex);
        for (int columnIndex = 0; columnIndex < rowValues.size(); columnIndex++) {
          Object value = rowValues.get(columnIndex);
          Cell cell = row.createCell(columnIndex);
          if (value instanceof Number) {
            cell.setCellValue(((Number) value).doubleValue());
            cell.setCellStyle(styles.number);
          } else {
            cell.setCellValue(limitCellText(value == null ? "" : value.toString()));
            cell.setCellStyle(styles.body);
          }
        }
      }

      for (int columnIndex = 0; columnIndex < columnWidths.size(); columnIndex++) {
        sheet.setColumnWidth(columnIndex, Math.min(255, columnWidths.get(columnIndex)) * 256);
      }
      sheet.createFreezePane(0, 1);
      sheet.setAutoFilter(
          new CellRangeAddress(0, Math.max(0, values.size()), 0, headers.size() - 1));
    }

    private static String limitCellText(String value) {
      return value.length() <= MAX_CELL_CHARACTERS
          ? value
          : value.substring(0, MAX_CELL_CHARACTERS - 1) + "…";
    }

    private static void moveAtomically(Path source, Path target) throws IOException {
      try {
        Files.move(
            source,
            target,
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
      } catch (AtomicMoveNotSupportedException ignored) {
        Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
      }
    }
  }

  private static final class WorkbookStyles {
    private final CellStyle header;
    private final CellStyle body;
    private final CellStyle number;

    private WorkbookStyles(CellStyle header, CellStyle body, CellStyle number) {
      this.header = header;
      this.body = body;
      this.number = number;
    }

    private static WorkbookStyles create(Workbook workbook) {
      Font headerFont = workbook.createFont();
      headerFont.setBoldweight(Font.BOLDWEIGHT_BOLD);
      headerFont.setColor(IndexedColors.WHITE.getIndex());

      CellStyle header = workbook.createCellStyle();
      header.setFont(headerFont);
      header.setFillForegroundColor(IndexedColors.DARK_BLUE.getIndex());
      header.setFillPattern(CellStyle.SOLID_FOREGROUND);
      header.setAlignment(CellStyle.ALIGN_CENTER);
      header.setVerticalAlignment(CellStyle.VERTICAL_CENTER);
      header.setWrapText(true);
      addBorders(header);

      CellStyle body = workbook.createCellStyle();
      body.setVerticalAlignment(CellStyle.VERTICAL_TOP);
      body.setWrapText(true);
      addBorders(body);

      CellStyle number = workbook.createCellStyle();
      number.cloneStyleFrom(body);
      number.setAlignment(CellStyle.ALIGN_CENTER);
      return new WorkbookStyles(header, body, number);
    }

    private static void addBorders(CellStyle style) {
      style.setBorderTop(CellStyle.BORDER_THIN);
      style.setBorderRight(CellStyle.BORDER_THIN);
      style.setBorderBottom(CellStyle.BORDER_THIN);
      style.setBorderLeft(CellStyle.BORDER_THIN);
      style.setTopBorderColor(IndexedColors.GREY_25_PERCENT.getIndex());
      style.setRightBorderColor(IndexedColors.GREY_25_PERCENT.getIndex());
      style.setBottomBorderColor(IndexedColors.GREY_25_PERCENT.getIndex());
      style.setLeftBorderColor(IndexedColors.GREY_25_PERCENT.getIndex());
    }
  }

  private static List<String> findKeywords(String text, List<String> keywords) {
    if (text == null || text.isEmpty()) {
      return Collections.emptyList();
    }
    String searchable = removeNegatedPhrases(splitIdentifierWords(text), keywords);
    List<String> matches = new ArrayList<>();
    for (String keyword : keywords) {
      if (containsKeyword(searchable, keyword)) {
        matches.add(keyword);
      }
    }
    return matches;
  }

  private static boolean containsKeyword(String text, String keyword) {
    String normalizedKeyword = splitIdentifierWords(keyword).trim();
    if (normalizedKeyword.isEmpty()) {
      return false;
    }
    Pattern pattern =
        Pattern.compile(
            "(?iu)(?<![\\p{L}\\p{N}])"
                + Pattern.quote(normalizedKeyword)
                + "(?![\\p{L}\\p{N}])");
    return pattern.matcher(text).find()
        || containsConcatenatedIdentifierKeyword(text, normalizedKeyword);
  }

  private static boolean containsConcatenatedIdentifierKeyword(
      String text, String normalizedKeyword) {
    String compactKeyword = normalizedKeyword.replaceAll("\\s+", "");
    if (compactKeyword.isEmpty()) {
      return false;
    }

    for (String metadataField : text.split(METADATA_FIELD_SEPARATOR, -1)) {
      List<String> identifierWords = identifierWords(metadataField);
      for (int start = 0; start < identifierWords.size(); start++) {
        StringBuilder joinedWords = new StringBuilder(compactKeyword.length());
        for (int end = start; end < identifierWords.size(); end++) {
          joinedWords.append(identifierWords.get(end));
          if (joinedWords.length() > compactKeyword.length()) {
            break;
          }
          if (joinedWords.toString().equals(compactKeyword)
              && !isNegatedIdentifierSequence(identifierWords, start)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private static List<String> identifierWords(String text) {
    List<String> words = new ArrayList<>();
    Matcher matcher = IDENTIFIER_WORD_PATTERN.matcher(text);
    while (matcher.find()) {
      words.add(matcher.group());
    }
    return words;
  }

  private static boolean isNegatedIdentifierSequence(List<String> words, int matchStart) {
    int precedingWord = matchStart - 1;
    if (precedingWord >= 0
        && (words.get(precedingWord).equals("a")
            || words.get(precedingWord).equals("an"))) {
      precedingWord--;
    }
    if (precedingWord < 0) {
      return false;
    }
    String word = words.get(precedingWord);
    return word.equals("no")
        || word.equals("not")
        || word.equals("without")
        || word.equals("never");
  }

  private static String splitIdentifierWords(String value) {
    return value
        .replaceAll("(?<=[a-z0-9])(?=[A-Z])", " ")
        .replaceAll("(?<=[A-Z])(?=[A-Z][a-z])", " ")
        .replaceAll("[_\\-.\\/\\\\]+", " ")
        .toLowerCase(Locale.ROOT);
  }

  private static String removeNegatedPhrases(String value, List<String> keywords) {
    String cleaned = value;
    for (String keyword : keywords) {
      String normalizedKeyword = splitIdentifierWords(keyword).trim();
      if (!normalizedKeyword.isEmpty()) {
        cleaned =
            cleaned.replaceAll(
                "(?iu)\\b(?:no|not|without|never)\\s+(?:an?\\s+)?"
                    + Pattern.quote(normalizedKeyword)
                    + "(?![\\p{L}\\p{N}])",
                " ");
      }
    }
    return cleaned;
  }

  private static String joinMetadataFields(List<String> fields) {
    return String.join(METADATA_FIELD_SEPARATOR, fields);
  }

  private static String narrativeText(String source) {
    StringBuilder narrative = new StringBuilder();
    scanNarrative(source, narrative, null);
    return narrative.toString();
  }

  private static String maskCommentsAndStrings(String source) {
    StringBuilder masked = new StringBuilder(source);
    scanNarrative(source, null, masked);
    return masked.toString();
  }

  private static void scanNarrative(
      String source, StringBuilder narrative, StringBuilder masked) {
    int offset = 0;
    while (offset < source.length()) {
      if (source.startsWith("//", offset)) {
        int end = source.indexOf('\n', offset + 2);
        end = end < 0 ? source.length() : end;
        appendNarrative(source, offset, end, narrative, masked);
        offset = end;
      } else if (source.startsWith("/*", offset)) {
        int closing = source.indexOf("*/", offset + 2);
        int end = closing < 0 ? source.length() : closing + 2;
        appendNarrative(source, offset, end, narrative, masked);
        offset = end;
      } else if (source.charAt(offset) == '\'' || source.charAt(offset) == '"') {
        char quote = source.charAt(offset);
        boolean triple =
            offset + 2 < source.length()
                && source.charAt(offset + 1) == quote
                && source.charAt(offset + 2) == quote;
        int end = findStringEnd(source, offset, quote, triple);
        appendNarrative(source, offset, end, narrative, masked);
        offset = end;
      } else {
        offset++;
      }
    }
  }

  private static void appendNarrative(
      String source,
      int start,
      int end,
      StringBuilder narrative,
      StringBuilder masked) {
    if (narrative != null) {
      narrative.append(' ').append(source, start, end);
    }
    if (masked != null) {
      for (int index = start; index < end; index++) {
        if (masked.charAt(index) != '\n' && masked.charAt(index) != '\r') {
          masked.setCharAt(index, ' ');
        }
      }
    }
  }

  private static int findStringEnd(String source, int start, char quote, boolean triple) {
    int offset = start + (triple ? 3 : 1);
    while (offset < source.length()) {
      if (!triple && source.charAt(offset) == '\\' && offset + 1 < source.length()) {
        offset += 2;
      } else if (triple
          && offset + 2 < source.length()
          && source.charAt(offset) == quote
          && source.charAt(offset + 1) == quote
          && source.charAt(offset + 2) == quote) {
        return offset + 3;
      } else if (!triple && source.charAt(offset) == quote) {
        return offset + 1;
      } else {
        offset++;
      }
    }
    return source.length();
  }

  private static String compactExcerpt(String text, int offset) {
    if (text == null || text.isEmpty()) {
      return "";
    }
    int safeOffset = Math.min(Math.max(0, offset), text.length() - 1);
    int start = Math.max(0, safeOffset - 45);
    int end = Math.min(text.length(), safeOffset + 95);
    String compact = text.substring(start, end).replaceAll("\\s+", " ").trim();
    return (start > 0 ? "…" : "")
        + compact
        + (end < text.length() ? "…" : "");
  }

  private static String unquote(String value) {
    if (value.length() >= 6
        && ((value.startsWith("\"\"\"") && value.endsWith("\"\"\""))
            || (value.startsWith("'''") && value.endsWith("'''")))) {
      return value.substring(3, value.length() - 3);
    }
    if (value.length() >= 2) {
      return value.substring(1, value.length() - 1);
    }
    return value;
  }

  private static String readUtf8(Path sourceFile) throws IOException {
    byte[] content = Files.readAllBytes(sourceFile);
    int offset =
        content.length >= 3
                && content[0] == (byte) 0xEF
                && content[1] == (byte) 0xBB
                && content[2] == (byte) 0xBF
            ? 3
            : 0;
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(content, offset, content.length - offset))
          .toString();
    } catch (CharacterCodingException error) {
      throw new IOException("File is not valid UTF-8: " + sourceFile, error);
    }
  }

  private static String rootMessage(Throwable error) {
    Throwable current = error;
    while (current.getCause() != null && current.getCause() != current) {
      current = current.getCause();
    }
    return current.getMessage() == null
        ? current.getClass().getSimpleName()
        : current.getMessage();
  }

  private static String baseName(Path path) {
    return baseName(path.getFileName().toString());
  }

  private static String baseName(String path) {
    int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    String fileName = slash < 0 ? path : path.substring(slash + 1);
    return fileName.endsWith(".groovy")
        ? fileName.substring(0, fileName.length() - ".groovy".length())
        : fileName;
  }
}
