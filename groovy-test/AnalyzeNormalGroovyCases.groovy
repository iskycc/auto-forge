#!/usr/bin/env groovy

@Grab('org.apache.poi:poi-ooxml:5.5.1')

import groovy.transform.CompileStatic
import org.apache.poi.ss.usermodel.BorderStyle
import org.apache.poi.ss.usermodel.Cell
import org.apache.poi.ss.usermodel.CellStyle
import org.apache.poi.ss.usermodel.FillPatternType
import org.apache.poi.ss.usermodel.Font
import org.apache.poi.ss.usermodel.HorizontalAlignment
import org.apache.poi.ss.usermodel.IndexedColors
import org.apache.poi.ss.usermodel.Row
import org.apache.poi.ss.usermodel.Sheet
import org.apache.poi.ss.usermodel.VerticalAlignment
import org.apache.poi.ss.usermodel.Workbook
import org.apache.poi.ss.util.CellRangeAddress
import org.apache.poi.xssf.streaming.SXSSFWorkbook
import org.codehaus.groovy.ast.AnnotatedNode
import org.codehaus.groovy.ast.AnnotationNode
import org.codehaus.groovy.ast.ASTNode
import org.codehaus.groovy.ast.ClassNode
import org.codehaus.groovy.ast.MethodNode
import org.codehaus.groovy.ast.builder.AstBuilder
import org.codehaus.groovy.control.CompilePhase

import java.lang.reflect.Modifier
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.util.regex.Matcher
import java.util.regex.Pattern
import java.util.stream.Stream

/**
 * Recursively finds Groovy test cases below the selected directory, excludes
 * abnormal/negative scenarios, and writes the result to an XLSX workbook.
 *
 * Run `groovy AnalyzeNormalGroovyCases.groovy --help` for usage. Apache POI is
 * resolved through Groovy Grape, so an internal repository can be configured
 * in ~/.groovy/grapeConfig.xml when Maven Central is not directly reachable.
 */
final class AnalyzeNormalGroovyCases {
    static void main(String[] arguments) {
        try {
            if (System.getProperty('log4j2.loggerContextFactory') == null) {
                System.setProperty(
                    'log4j2.loggerContextFactory',
                    'org.apache.logging.log4j.simple.SimpleLoggerContextFactory'
                )
            }
            AnalyzerOptions options = AnalyzerOptions.parse(arguments as List<String>)
            if (options.showHelp) {
                println AnalyzerOptions.usage()
                return
            }

            GroovyCaseAnalyzer analyzer = new GroovyCaseAnalyzer(options)
            AnalysisReport report = analyzer.analyze()
            new CaseWorkbookWriter().write(report, options)

            println "Scanned ${report.sourceFileCount} Groovy file(s) and " +
                "${report.candidateCount()} case candidate(s)."
            println "Exported ${report.normalCases.size()} normal case(s); " +
                "${report.excludedCases.size()} candidate(s) were excluded."
            if (!report.scanIssues.isEmpty()) {
                println "${report.scanIssues.size()} file(s) could not be analyzed; " +
                    "see the '扫描问题' worksheet."
            }
            println "Workbook: ${options.outputFile}"
        } catch (IllegalArgumentException error) {
            System.err.println "Invalid arguments: ${error.message}"
            System.err.println AnalyzerOptions.usage()
            System.exit(2)
        } catch (Exception error) {
            throw new IllegalStateException('Failed to analyze Groovy cases', error)
        }
    }
}

@CompileStatic
final class AnalyzerOptions {
    static final List<String> DEFAULT_NEGATIVE_KEYWORDS = [
        'abnormal', 'exception', 'error', 'suspended',
        'failure', 'failed', 'invalid', 'illegal', 'negative',
        'timeout', 'timed out', 'cancelled', 'canceled', 'rejected',
        'denied', 'forbidden', 'unauthorized', 'unavailable', 'fault',
        '异常', '错误', '挂起', '暂停', '失败', '无效', '非法',
        '负向', '反向', '超时', '取消', '拒绝', '无权限', '不可用'
    ].asImmutable()

    static final List<String> POSITIVE_KEYWORDS = [
        'normal', 'success', 'successful', 'happy path', 'positive', 'valid', 'smoke',
        '正常', '成功', '正向', '冒烟'
    ].asImmutable()

    Path sourceRoot
    Path outputFile
    List<String> negativeKeywords
    boolean showHelp

    static AnalyzerOptions parse(List<String> arguments) {
        Path sourceRoot = Paths.get('.').toAbsolutePath().normalize()
        Path outputFile = null
        List<String> extraKeywords = []
        boolean showHelp = false

        int index = 0
        while (index < arguments.size()) {
            String argument = arguments[index]
            switch (argument) {
                case '--source':
                    sourceRoot = Paths.get(requiredValue(arguments, ++index, argument))
                        .toAbsolutePath().normalize()
                    break
                case '--output':
                    outputFile = Paths.get(requiredValue(arguments, ++index, argument))
                        .toAbsolutePath().normalize()
                    break
                case '--extra-keywords':
                    String value = requiredValue(arguments, ++index, argument)
                    extraKeywords.addAll(splitKeywords(value))
                    break
                case '--help':
                case '-h':
                    showHelp = true
                    break
                default:
                    throw new IllegalArgumentException("Unknown option: ${argument}")
            }
            index++
        }

        if (!Files.exists(sourceRoot)) {
            throw new IllegalArgumentException("Source directory does not exist: ${sourceRoot}")
        }
        if (!Files.isDirectory(sourceRoot)) {
            throw new IllegalArgumentException("Source path is not a directory: ${sourceRoot}")
        }

        Path resolvedOutput = outputFile ?: sourceRoot.resolve('normal-groovy-cases.xlsx')
        if (!resolvedOutput.fileName.toString().toLowerCase(Locale.ROOT).endsWith('.xlsx')) {
            throw new IllegalArgumentException('Output file must have an .xlsx extension')
        }

        List<String> keywords = new ArrayList<>(DEFAULT_NEGATIVE_KEYWORDS)
        extraKeywords.each { String keyword ->
            if (!keywords.any { String existing -> existing.equalsIgnoreCase(keyword) }) {
                keywords.add(keyword)
            }
        }
        return new AnalyzerOptions(
            sourceRoot: sourceRoot,
            outputFile: resolvedOutput,
            negativeKeywords: keywords.asImmutable(),
            showHelp: showHelp
        )
    }

    static String usage() {
        return '''Usage:
  groovy AnalyzeNormalGroovyCases.groovy [options]

Options:
  --source DIR              Directory to scan recursively (default: current directory)
  --output FILE.xlsx        Output workbook (default: DIR/normal-groovy-cases.xlsx)
  --extra-keywords A,B,C    Add comma-separated abnormal-scene keywords
  -h, --help                Show this help

Examples:
  groovy AnalyzeNormalGroovyCases.groovy
  groovy AnalyzeNormalGroovyCases.groovy --source ./cases --output ./normal-cases.xlsx
  groovy AnalyzeNormalGroovyCases.groovy --extra-keywords Degraded,Rollback,降级,回滚'''
    }

    private static String requiredValue(List<String> arguments, int index, String option) {
        if (index >= arguments.size() || arguments[index].startsWith('--')) {
            throw new IllegalArgumentException("${option} requires a value")
        }
        return arguments[index]
    }

    private static List<String> splitKeywords(String value) {
        List<String> keywords = value.split(',', -1)
            .collect { String keyword -> keyword.trim() }
            .findAll { String keyword -> !keyword.isEmpty() }
        if (keywords.isEmpty()) {
            throw new IllegalArgumentException('--extra-keywords requires at least one keyword')
        }
        return keywords
    }
}

@CompileStatic
final class AnalysisReport {
    int sourceFileCount
    List<AnalyzedCase> normalCases = []
    List<AnalyzedCase> excludedCases = []
    List<ScanIssue> scanIssues = []

    int candidateCount() {
        return normalCases.size() + excludedCases.size()
    }
}

@CompileStatic
final class ScanIssue {
    String relativePath
    String message
}

@CompileStatic
final class AnalyzedCase {
    String title
    String packageName
    String className
    String methodName
    String relativePath
    int lineNumber
    String discoveryKind
    String decision
    List<String> matchedKeywords = []
    List<String> evidence = []
}

@CompileStatic
final class CaseCandidate {
    String title
    String packageName
    String className
    String methodName
    String relativePath
    int lineNumber
    String discoveryKind
    String metadata
    String sourceScope
}

@CompileStatic
final class GroovyCaseAnalyzer {
    private static final String ANALYZER_FILE_NAME = 'AnalyzeNormalGroovyCases.groovy'
    private static final Set<String> TEST_ANNOTATIONS = [
        'Test', 'TestCase', 'Unroll', 'Feature', 'ParameterizedTest', 'RepeatedTest',
        'TestFactory', 'TestTemplate', 'Property'
    ] as Set<String>
    private static final Set<String> SPOCK_LIFECYCLE_METHODS = [
        'setup', 'cleanup', 'setupSpec', 'cleanupSpec'
    ] as Set<String>
    private static final Pattern COMMENT_OR_STRING = Pattern.compile(
        '(?s)/\\*.*?\\*/|(?m)//[^\\r\\n]*|(?s)""".*?"""|(?s)\'\'\'.*?\'\'\'|' +
            '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\''
    )
    private static final List<SemanticPattern> NEGATIVE_SEMANTICS = [
        new SemanticPattern('shouldFail 异常断言', Pattern.compile('(?i)\\bshouldFail\\s*[({]')),
        new SemanticPattern('assertThrows 异常断言', Pattern.compile('(?i)\\bassertThrows\\s*\\(')),
        new SemanticPattern('thrown 异常断言', Pattern.compile('(?i)(?<!not)\\bthrown\\s*\\(')),
        new SemanticPattern(
            '期望异常配置',
            Pattern.compile('(?i)\\bexpected(?:Exceptions?)?\\s*=\\s*[^,)}\\r\\n]*(?:Exception|Error)\\b')
        ),
        new SemanticPattern(
            '主动抛出异常',
            Pattern.compile('(?i)\\bthrow\\s+new\\s+[\\w.]*?(?:Exception|Error)\\b')
        ),
        new SemanticPattern(
            '捕获异常',
            Pattern.compile('(?i)\\bcatch\\s*\\([^)]*[\\w.]*?(?:Exception|Error)\\b')
        )
    ].asImmutable()

    private final AnalyzerOptions options

    GroovyCaseAnalyzer(AnalyzerOptions options) {
        this.options = options
    }

    AnalysisReport analyze() {
        List<Path> sourceFiles = findSourceFiles()
        AnalysisReport report = new AnalysisReport(sourceFileCount: sourceFiles.size())

        sourceFiles.each { Path sourceFile ->
            try {
                String source = readUtf8(sourceFile)
                List<CaseCandidate> candidates = discoverCandidates(sourceFile, source)
                candidates.each { CaseCandidate candidate ->
                    AnalyzedCase analyzedCase = classify(candidate)
                    if (analyzedCase.evidence.isEmpty()) {
                        report.normalCases.add(analyzedCase)
                    } else {
                        report.excludedCases.add(analyzedCase)
                    }
                }
            } catch (Exception error) {
                report.scanIssues.add(new ScanIssue(
                    relativePath: displayPath(sourceFile),
                    message: rootMessage(error)
                ))
            }
        }

        Comparator<AnalyzedCase> byLocation = new Comparator<AnalyzedCase>() {
            @Override
            int compare(AnalyzedCase left, AnalyzedCase right) {
                int pathOrder = left.relativePath <=> right.relativePath
                return pathOrder != 0 ? pathOrder : left.lineNumber <=> right.lineNumber
            }
        }
        Collections.sort(report.normalCases, byLocation)
        Collections.sort(report.excludedCases, byLocation)
        report.scanIssues.sort { ScanIssue left, ScanIssue right ->
            left.relativePath <=> right.relativePath
        }
        return report
    }

    private List<Path> findSourceFiles() {
        List<Path> sourceFiles = []
        Stream<Path> paths = Files.walk(options.sourceRoot)
        try {
            paths.filter { Path path -> isGroovySource(path) }
                .forEach { Path path -> sourceFiles.add(path.toAbsolutePath().normalize()) }
        } finally {
            paths.close()
        }
        sourceFiles.sort { Path left, Path right -> displayPath(left) <=> displayPath(right) }
        return sourceFiles
    }

    private boolean isGroovySource(Path path) {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            return false
        }
        String fileName = path.fileName.toString()
        return fileName.endsWith('.groovy') && fileName != ANALYZER_FILE_NAME
    }

    private List<CaseCandidate> discoverCandidates(Path sourceFile, String source) {
        List<ASTNode> nodes = new AstBuilder().buildFromString(CompilePhase.CONVERSION, false, source)
        List<ClassNode> declaredClasses = []
        nodes.findAll { ASTNode node -> node instanceof ClassNode }
            .each { ASTNode node -> collectClasses((ClassNode) node, declaredClasses) }

        List<ClassNode> concreteClasses = declaredClasses.findAll { ClassNode classNode ->
            !classNode.script && !classNode.interface && !classNode.enum
        }
        String relativePath = displayPath(sourceFile)
        if (concreteClasses.isEmpty()) {
            return [new CaseCandidate(
                title: baseName(sourceFile),
                packageName: '',
                className: baseName(sourceFile),
                methodName: '',
                relativePath: relativePath,
                lineNumber: 1,
                discoveryKind: 'Groovy 脚本',
                metadata: "${relativePath} ${baseName(sourceFile)}",
                sourceScope: source
            )]
        }

        List<CaseCandidate> candidates = []
        concreteClasses.each { ClassNode classNode ->
            List<MethodNode> methods = testMethods(classNode)
            if (methods.isEmpty()) {
                String classAnnotations = annotationText(classNode)
                candidates.add(new CaseCandidate(
                    title: preferredTitle(classAnnotations, classNode.nameWithoutPackage),
                    packageName: classNode.packageName ?: '',
                    className: classNode.nameWithoutPackage,
                    methodName: '',
                    relativePath: relativePath,
                    lineNumber: positiveLine(classNode.lineNumber),
                    discoveryKind: '类级用例（未发现测试方法）',
                    metadata: "${relativePath} ${classNode.nameWithoutPackage} ${classAnnotations}",
                    sourceScope: sourceLines(source, classNode.lineNumber, classNode.lastLineNumber)
                ))
            } else {
                methods.each { MethodNode method ->
                    String methodAnnotations = annotationText(method)
                    candidates.add(new CaseCandidate(
                        title: preferredTitle(methodAnnotations, method.name),
                        packageName: classNode.packageName ?: '',
                        className: classNode.nameWithoutPackage,
                        methodName: method.name,
                        relativePath: relativePath,
                        lineNumber: positiveLine(method.lineNumber),
                        discoveryKind: discoveryKind(classNode, method),
                        metadata: "${relativePath} ${classNode.nameWithoutPackage} ${method.name} " +
                            "${annotationText(classNode)} ${methodAnnotations}",
                        sourceScope: sourceLines(source, method.lineNumber, method.lastLineNumber)
                    ))
                }
            }
        }
        return candidates
    }

    private static void collectClasses(ClassNode classNode, List<ClassNode> classes) {
        String identity = "${classNode.name}:${classNode.lineNumber}"
        if (!classes.any { ClassNode existing ->
            "${existing.name}:${existing.lineNumber}" == identity
        }) {
            classes.add(classNode)
        }
        Iterator<? extends ClassNode> innerClasses = classNode.innerClasses
        while (innerClasses.hasNext()) {
            collectClasses(innerClasses.next(), classes)
        }
    }

    private static List<MethodNode> testMethods(ClassNode classNode) {
        boolean classLevelTest = hasTestAnnotation(classNode)
        boolean spockSpecification = isSpockSpecification(classNode)
        return classNode.methods.findAll { MethodNode method ->
            if (method.declaringClass.name != classNode.name || method.lineNumber <= 0 || method.synthetic) {
                return false
            }
            if (SPOCK_LIFECYCLE_METHODS.contains(method.name)) {
                return false
            }
            return hasTestAnnotation(method) || isTestStyleName(method.name) ||
                (classLevelTest && Modifier.isPublic(method.modifiers)) || spockSpecification
        }
    }

    private static boolean hasTestAnnotation(AnnotatedNode node) {
        return node.annotations.any { AnnotationNode annotation ->
            TEST_ANNOTATIONS.contains(annotation.classNode.nameWithoutPackage)
        }
    }

    private static boolean isTestStyleName(String methodName) {
        return methodName ==~ /(?i)test(?:[A-Z0-9_].*)?/ || methodName.contains(' ')
    }

    private static boolean isSpockSpecification(ClassNode classNode) {
        return classNode.nameWithoutPackage.endsWith('Spec') ||
            classNode.nameWithoutPackage.endsWith('Specification') ||
            classNode.superClass?.nameWithoutPackage == 'Specification'
    }

    private static String discoveryKind(ClassNode classNode, MethodNode method) {
        if (hasTestAnnotation(method)) {
            return '@Test/测试注解方法'
        }
        if (isSpockSpecification(classNode)) {
            return 'Spock 特性方法'
        }
        if (hasTestAnnotation(classNode)) {
            return '类级 @Test 方法'
        }
        return 'test* 命名方法'
    }

    private AnalyzedCase classify(CaseCandidate candidate) {
        List<String> evidence = []
        LinkedHashSet<String> negativeMatches = new LinkedHashSet<>()
        LinkedHashSet<String> positiveMatches = new LinkedHashSet<>()

        List<String> metadataMatches = findKeywords(candidate.metadata, options.negativeKeywords)
        if (!metadataMatches.isEmpty()) {
            negativeMatches.addAll(metadataMatches)
            evidence.add("标题/路径/类或方法元数据命中：${metadataMatches.join(', ')}".toString())
        }

        String narrative = narrativeText(candidate.sourceScope)
        List<String> narrativeMatches = findKeywords(narrative, options.negativeKeywords)
        if (!narrativeMatches.isEmpty()) {
            negativeMatches.addAll(narrativeMatches)
            evidence.add(("注释或字符串内容命中：${narrativeMatches.join(', ')}；" +
                "${excerptAroundKeyword(narrative, narrativeMatches[0])}").toString())
        }

        NEGATIVE_SEMANTICS.each { SemanticPattern semantic ->
            Matcher matcher = semantic.pattern.matcher(candidate.sourceScope)
            if (matcher.find()) {
                evidence.add(
                    "${semantic.label}：${compactExcerpt(candidate.sourceScope, matcher.start())}".toString()
                )
            }
        }

        positiveMatches.addAll(findKeywords(candidate.metadata, AnalyzerOptions.POSITIVE_KEYWORDS))
        positiveMatches.addAll(findKeywords(narrative, AnalyzerOptions.POSITIVE_KEYWORDS))
        String decision = evidence.isEmpty()
            ? (positiveMatches.isEmpty()
                ? '正常（未发现异常信号，建议抽样复核）'
                : "正常（命中正向信号：${positiveMatches.join(', ')}）")
            : '排除（发现异常/负向场景信号）'

        return new AnalyzedCase(
            title: candidate.title,
            packageName: candidate.packageName,
            className: candidate.className,
            methodName: candidate.methodName,
            relativePath: candidate.relativePath,
            lineNumber: candidate.lineNumber,
            discoveryKind: candidate.discoveryKind,
            decision: decision,
            matchedKeywords: negativeMatches as List<String>,
            evidence: evidence
        )
    }

    private static List<String> findKeywords(String text, List<String> keywords) {
        if (text == null || text.isEmpty()) {
            return []
        }
        String searchable = removeNegatedPhrases(splitIdentifierWords(text))
        return keywords.findAll { String keyword -> containsKeyword(searchable, keyword) }
    }

    private static boolean containsKeyword(String text, String keyword) {
        String normalizedKeyword = splitIdentifierWords(keyword).trim()
        if (normalizedKeyword.isEmpty()) {
            return false
        }
        if (normalizedKeyword ==~ /.*[\\p{IsHan}].*/) {
            return text.contains(normalizedKeyword)
        }
        Pattern pattern = Pattern.compile(
            '(?iu)(?<![\\p{L}\\p{N}])' + Pattern.quote(normalizedKeyword) +
                '(?![\\p{L}\\p{N}])'
        )
        return pattern.matcher(text).find()
    }

    private static String splitIdentifierWords(String value) {
        return value
            .replaceAll('(?<=[a-z0-9])(?=[A-Z])', ' ')
            .replaceAll('(?<=[A-Z])(?=[A-Z][a-z])', ' ')
            .replaceAll('[_\\-.\\/\\\\]+', ' ')
            .toLowerCase(Locale.ROOT)
    }

    private static String removeNegatedPhrases(String value) {
        String cleaned = value.replaceAll(
            '(?iu)\\b(?:no|not|without|never)\\s+(?:an?\\s+)?' +
                '(?:abnormal|exception|error|failure|fault|timeout|suspended)\\b',
            ' '
        )
        return cleaned
            .replace('无异常', ' ')
            .replace('无错误', ' ')
            .replace('没有异常', ' ')
            .replace('没有错误', ' ')
            .replace('不抛异常', ' ')
            .replace('不会抛出异常', ' ')
    }

    private static String narrativeText(String source) {
        StringBuilder narrative = new StringBuilder()
        Matcher matcher = COMMENT_OR_STRING.matcher(source ?: '')
        while (matcher.find()) {
            narrative.append(' ').append(matcher.group())
        }
        return narrative.toString()
    }

    private static String excerptAroundKeyword(String text, String keyword) {
        String normalized = splitIdentifierWords(text)
        String sought = splitIdentifierWords(keyword).trim()
        int offset = normalized.indexOf(sought)
        return compactExcerpt(text, Math.max(0, offset))
    }

    private static String compactExcerpt(String text, int offset) {
        String compact = (text ?: '').replaceAll('\\s+', ' ').trim()
        if (compact.isEmpty()) {
            return ''
        }
        int safeOffset = Math.min(Math.max(0, offset), compact.length() - 1)
        int start = Math.max(0, safeOffset - 45)
        int end = Math.min(compact.length(), safeOffset + 95)
        return (start > 0 ? '…' : '') + compact.substring(start, end) +
            (end < compact.length() ? '…' : '')
    }

    private static String annotationText(AnnotatedNode node) {
        return node.annotations.collect { AnnotationNode annotation ->
            String members = annotation.members.collect { String name, Object expression ->
                "${name}=${expression}"
            }.join(' ')
            "@${annotation.classNode.nameWithoutPackage} ${members}"
        }.join(' ')
    }

    private static String preferredTitle(String annotationText, String fallback) {
        Matcher matcher = Pattern.compile(
            '(?i)(?:description|title|name|value)=ConstantExpression\\[([^]]+)]'
        ).matcher(annotationText ?: '')
        return matcher.find() ? matcher.group(1).trim() : fallback
    }

    private static String sourceLines(String source, int firstLine, int lastLine) {
        String[] lines = source.split('\\r\\n|\\r|\\n', -1)
        int startIndex = Math.max(0, positiveLine(firstLine) - 1)
        int requestedEnd = lastLine > 0 ? lastLine : lines.length
        int endExclusive = Math.min(lines.length, Math.max(startIndex + 1, requestedEnd))
        return lines[startIndex..<endExclusive].join('\n')
    }

    private static int positiveLine(int lineNumber) {
        return lineNumber > 0 ? lineNumber : 1
    }

    private static String baseName(Path path) {
        String fileName = path.fileName.toString()
        return fileName.substring(0, fileName.length() - '.groovy'.length())
    }

    private String displayPath(Path sourceFile) {
        return options.sourceRoot.relativize(sourceFile).toString()
            .replace(File.separatorChar, '/' as char)
    }

    private static String readUtf8(Path sourceFile) {
        byte[] content = Files.readAllBytes(sourceFile)
        int offset = content.length >= 3 && content[0] == (byte) 0xEF &&
            content[1] == (byte) 0xBB && content[2] == (byte) 0xBF ? 3 : 0
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(content, offset, content.length - offset))
                .toString()
        } catch (CharacterCodingException error) {
            throw new IOException("File is not valid UTF-8: ${sourceFile}", error)
        }
    }

    private static String rootMessage(Throwable error) {
        Throwable current = error
        while (current.cause != null && current.cause != current) {
            current = current.cause
        }
        return current.message ?: current.class.simpleName
    }
}

@CompileStatic
final class SemanticPattern {
    final String label
    final Pattern pattern

    SemanticPattern(String label, Pattern pattern) {
        this.label = label
        this.pattern = pattern
    }
}

@CompileStatic
final class CaseWorkbookWriter {
    private static final int MAX_CELL_CHARACTERS = 32_000

    void write(AnalysisReport report, AnalyzerOptions options) {
        Path parent = options.outputFile.parent
        if (parent == null) {
            throw new IllegalArgumentException('Output file must have a parent directory')
        }
        Files.createDirectories(parent)
        if (Files.exists(options.outputFile, LinkOption.NOFOLLOW_LINKS) &&
            !Files.isRegularFile(options.outputFile, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Output path is not a regular file: ${options.outputFile}")
        }

        SXSSFWorkbook workbook = new SXSSFWorkbook(200)
        workbook.setCompressTempFiles(true)
        Path temporaryFile = Files.createTempFile(parent, '.normal-groovy-cases-', '.xlsx')
        try {
            WorkbookStyles styles = WorkbookStyles.create(workbook)
            writeNormalCases(workbook, styles, report.normalCases)
            writeExcludedCases(workbook, styles, report.excludedCases)
            writeScanIssues(workbook, styles, report.scanIssues)
            writeSummary(workbook, styles, report, options)

            OutputStream output = Files.newOutputStream(
                temporaryFile,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE
            )
            try {
                workbook.write(output)
            } finally {
                output.close()
            }
            moveAtomically(temporaryFile, options.outputFile)
        } finally {
            workbook.close()
            workbook.dispose()
            Files.deleteIfExists(temporaryFile)
        }
    }

    private static void writeNormalCases(
        Workbook workbook,
        WorkbookStyles styles,
        List<AnalyzedCase> cases
    ) {
        List<String> headers = [
            '序号', '用例标题', '包名', '类名', '测试方法', '相对路径', '起始行',
            '识别方式', '正常判断'
        ]
        List<List<Object>> rows = []
        cases.eachWithIndex { AnalyzedCase testCase, int index ->
            rows.add([
                index + 1, testCase.title, testCase.packageName, testCase.className,
                testCase.methodName, testCase.relativePath, testCase.lineNumber,
                testCase.discoveryKind, testCase.decision
            ] as List<Object>)
        }
        writeTable(workbook, styles, '正常用例', headers, rows,
            [8, 34, 28, 30, 30, 48, 10, 24, 42])
    }

    private static void writeExcludedCases(
        Workbook workbook,
        WorkbookStyles styles,
        List<AnalyzedCase> cases
    ) {
        List<String> headers = [
            '序号', '用例标题', '包名', '类名', '测试方法', '相对路径', '起始行',
            '识别方式', '排除判断', '命中关键词', '证据摘要'
        ]
        List<List<Object>> rows = []
        cases.eachWithIndex { AnalyzedCase testCase, int index ->
            rows.add([
                index + 1, testCase.title, testCase.packageName, testCase.className,
                testCase.methodName, testCase.relativePath, testCase.lineNumber,
                testCase.discoveryKind, testCase.decision,
                testCase.matchedKeywords.join(', '), testCase.evidence.join('\n')
            ] as List<Object>)
        }
        writeTable(workbook, styles, '排除明细', headers, rows,
            [8, 34, 28, 30, 30, 48, 10, 24, 32, 30, 72])
    }

    private static void writeScanIssues(
        Workbook workbook,
        WorkbookStyles styles,
        List<ScanIssue> issues
    ) {
        List<List<Object>> rows = []
        issues.each { ScanIssue issue -> rows.add([issue.relativePath, issue.message] as List<Object>) }
        writeTable(workbook, styles, '扫描问题', ['相对路径', '问题'], rows, [52, 100])
    }

    private static void writeSummary(
        Workbook workbook,
        WorkbookStyles styles,
        AnalysisReport report,
        AnalyzerOptions options
    ) {
        List<List<Object>> rows = [
            ['生成时间（UTC）', Instant.now().toString()],
            ['扫描目录', options.sourceRoot.toString()],
            ['输出文件', options.outputFile.toString()],
            ['Groovy 文件数', report.sourceFileCount],
            ['候选用例数', report.candidateCount()],
            ['正常用例数', report.normalCases.size()],
            ['排除用例数', report.excludedCases.size()],
            ['扫描问题数', report.scanIssues.size()],
            ['异常关键词', options.negativeKeywords.join(', ')],
            ['判断规则', '文件/路径、类名、测试方法、注解标题、注释和字符串命中异常关键词时排除；' +
                'shouldFail/assertThrows/thrown/expected exception/throw/catch 等异常测试语义也会排除。'],
            ['粒度', '优先按 @Test、Spock 特性或 test* 方法逐项分析；没有测试方法的类按类分析；' +
                '没有显式类的 Groovy 脚本按文件分析。'],
            ['复核建议', '关键词和静态语义属于启发式判断。请在“排除明细”中检查误判，' +
                '并对“未发现异常信号”的正常用例抽样复核。']
        ]
        writeTable(workbook, styles, '扫描说明', ['项目', '内容'], rows, [24, 120])
    }

    private static void writeTable(
        Workbook workbook,
        WorkbookStyles styles,
        String sheetName,
        List<String> headers,
        List<List<Object>> values,
        List<Integer> columnWidths
    ) {
        Sheet sheet = workbook.createSheet(sheetName)
        Row header = sheet.createRow(0)
        headers.eachWithIndex { String value, int columnIndex ->
            Cell cell = header.createCell(columnIndex)
            cell.setCellValue(value)
            cell.setCellStyle(styles.header)
        }
        header.heightInPoints = 28

        values.eachWithIndex { List<Object> rowValues, int rowIndex ->
            Row row = sheet.createRow(rowIndex + 1)
            rowValues.eachWithIndex { Object value, int columnIndex ->
                Cell cell = row.createCell(columnIndex)
                if (value instanceof Number) {
                    cell.setCellValue(((Number) value).doubleValue())
                    cell.setCellStyle(styles.number)
                } else {
                    cell.setCellValue(limitCellText(value?.toString() ?: ''))
                    cell.setCellStyle(styles.body)
                }
            }
        }

        columnWidths.eachWithIndex { Integer width, int columnIndex ->
            sheet.setColumnWidth(columnIndex, Math.min(255, width) * 256)
        }
        sheet.createFreezePane(0, 1)
        sheet.setAutoFilter(new CellRangeAddress(0, Math.max(0, values.size()), 0, headers.size() - 1))
    }

    private static String limitCellText(String value) {
        return value.length() <= MAX_CELL_CHARACTERS
            ? value
            : value.substring(0, MAX_CELL_CHARACTERS - 1) + '…'
    }

    private static void moveAtomically(Path source, Path target) {
        try {
            Files.move(
                source,
                target,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING
            )
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

@CompileStatic
final class WorkbookStyles {
    CellStyle header
    CellStyle body
    CellStyle number

    static WorkbookStyles create(Workbook workbook) {
        Font headerFont = workbook.createFont()
        headerFont.bold = true
        headerFont.color = IndexedColors.WHITE.index

        CellStyle header = workbook.createCellStyle()
        header.setFont(headerFont)
        header.fillForegroundColor = IndexedColors.DARK_BLUE.index
        header.fillPattern = FillPatternType.SOLID_FOREGROUND
        header.alignment = HorizontalAlignment.CENTER
        header.verticalAlignment = VerticalAlignment.CENTER
        header.wrapText = true
        addBorders(header)

        CellStyle body = workbook.createCellStyle()
        body.verticalAlignment = VerticalAlignment.TOP
        body.wrapText = true
        addBorders(body)

        CellStyle number = workbook.createCellStyle()
        number.cloneStyleFrom(body)
        number.alignment = HorizontalAlignment.CENTER

        return new WorkbookStyles(header: header, body: body, number: number)
    }

    private static void addBorders(CellStyle style) {
        style.borderTop = BorderStyle.THIN
        style.borderRight = BorderStyle.THIN
        style.borderBottom = BorderStyle.THIN
        style.borderLeft = BorderStyle.THIN
        style.topBorderColor = IndexedColors.GREY_25_PERCENT.index
        style.rightBorderColor = IndexedColors.GREY_25_PERCENT.index
        style.bottomBorderColor = IndexedColors.GREY_25_PERCENT.index
        style.leftBorderColor = IndexedColors.GREY_25_PERCENT.index
    }
}
