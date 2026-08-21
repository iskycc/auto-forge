#!/usr/bin/env groovy

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
import java.nio.file.attribute.PosixFilePermission
import java.util.regex.Matcher
import java.util.regex.Pattern
import java.util.stream.Stream

final class CommandLineOptions {
    Path sourceRoot = Paths.get('.')
    String basePackage = ''
    boolean dryRun = false
    boolean helpRequested = false
}

final class PackageDeclaration {
    int startOffset
    int endOffset
    String packageName
    String trailingComment
}

final class SourceChange {
    Path sourceFile
    byte[] originalBytes
    byte[] correctedBytes
    String currentPackage
    String expectedPackage
}

final class PackagePathFixer {
    private static final byte[] UTF8_BOM = [(byte) 0xEF, (byte) 0xBB, (byte) 0xBF] as byte[]
    private static final Set<String> RESERVED_PACKAGE_SEGMENTS = [
        'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
        'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
        'extends', 'false', 'final', 'finally', 'float', 'for', 'goto', 'if',
        'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
        'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short',
        'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw',
        'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while', '_',
        // Groovy contextual keywords are rejected too, so one path has the same
        // package meaning for both supported source types.
        'as', 'def', 'in', 'trait'
    ] as Set<String>
    private static final String IDENTIFIER = '[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*'
    private static final Pattern PACKAGE_DECLARATION = Pattern.compile(
        '(?m)^([ \\t]*)package[ \\t]+(' + IDENTIFIER + '(?:[ \\t]*\\.[ \\t]*' + IDENTIFIER + ')*)' +
            '[ \\t]*(;?)[ \\t]*(//[^\\r\\n]*)?[ \\t]*(?=\\r?$)'
    )

    private final Path sourceRoot
    private final String basePackage
    private final Path scriptPath

    PackagePathFixer(Path sourceRoot, String basePackage, Path scriptPath) {
        this.sourceRoot = sourceRoot.toAbsolutePath().normalize()
        this.basePackage = normalizeAndValidatePackage(basePackage, 'base package')
        this.scriptPath = scriptPath?.toAbsolutePath()?.normalize()
    }

    List<Path> findSourceFiles() {
        if (!Files.exists(sourceRoot)) {
            throw new IllegalArgumentException("Source root does not exist: ${sourceRoot}")
        }
        if (!Files.isDirectory(sourceRoot)) {
            throw new IllegalArgumentException("Source root is not a directory: ${sourceRoot}")
        }

        List<Path> sourceFiles = []
        Stream<Path> paths = Files.walk(sourceRoot)
        try {
            paths.filter { Path path -> isCaseSource(path) }
                .forEach { Path path -> sourceFiles.add(path.toAbsolutePath().normalize()) }
        } finally {
            paths.close()
        }
        sourceFiles.sort { Path left, Path right ->
            displayPath(left) <=> displayPath(right)
        }
        return sourceFiles
    }

    List<SourceChange> planChanges(List<Path> sourceFiles) {
        return sourceFiles.collect { Path sourceFile -> planChange(sourceFile) }
            .findAll { SourceChange change -> change != null }
    }

    void applyChanges(List<SourceChange> changes) {
        changes.each { SourceChange change ->
            byte[] currentBytes = Files.readAllBytes(change.sourceFile)
            if (!Arrays.equals(currentBytes, change.originalBytes)) {
                throw new IOException("Source changed while it was being processed: ${change.sourceFile}")
            }
            replaceAtomically(change.sourceFile, change.correctedBytes)
        }
    }

    String displayPath(Path sourceFile) {
        return sourceRoot.relativize(sourceFile).toString().replace(File.separatorChar, '/' as char)
    }

    private boolean isCaseSource(Path path) {
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            return false
        }
        Path normalizedPath = path.toAbsolutePath().normalize()
        if (scriptPath != null && normalizedPath == scriptPath) {
            return false
        }

        String fileName = path.fileName.toString()
        if (fileName == 'package-info.java' || fileName == 'module-info.java') {
            return false
        }
        return fileName.endsWith('.groovy') || fileName.endsWith('.java')
    }

    private SourceChange planChange(Path sourceFile) {
        String expectedPackage = expectedPackageFor(sourceFile)
        byte[] originalBytes = Files.readAllBytes(sourceFile)
        boolean hasBom = startsWithUtf8Bom(originalBytes)
        String source = decodeUtf8(originalBytes, hasBom, sourceFile)
        PackageDeclaration declaration = findPackageDeclaration(source)
        String currentPackage = declaration?.packageName ?: ''

        if (currentPackage == expectedPackage) {
            return null
        }

        String correctedSource = correctPackageDeclaration(
            source,
            sourceFile,
            declaration,
            expectedPackage
        )
        return new SourceChange(
            sourceFile: sourceFile,
            originalBytes: originalBytes,
            correctedBytes: encodeUtf8(correctedSource, hasBom),
            currentPackage: currentPackage,
            expectedPackage: expectedPackage
        )
    }

    private String expectedPackageFor(Path sourceFile) {
        Path parent = sourceFile.parent
        Path relativeParent = sourceRoot.relativize(parent)
        List<String> segments = []
        if (!relativeParent.toString().isEmpty()) {
            relativeParent.each { Path segmentPath ->
                String segment = segmentPath.toString()
                validatePackageSegment(segment, "directory in ${displayPath(sourceFile)}")
                segments.add(segment)
            }
        }

        List<String> packageParts = []
        if (!basePackage.isEmpty()) {
            packageParts.add(basePackage)
        }
        packageParts.addAll(segments)
        return packageParts.join('.')
    }

    private static PackageDeclaration findPackageDeclaration(String source) {
        int firstTokenOffset = skipHeaderTrivia(source)
        Matcher matcher = PACKAGE_DECLARATION.matcher(source)
        while (matcher.find()) {
            int packageKeywordOffset = matcher.start() + matcher.group(1).length()
            if (matcher.start() <= firstTokenOffset && matcher.end() >= firstTokenOffset &&
                packageKeywordOffset <= firstTokenOffset) {
                String normalizedPackage = matcher.group(2).replaceAll('[ \\t]', '')
                return new PackageDeclaration(
                    startOffset: matcher.start(),
                    endOffset: matcher.end(),
                    packageName: normalizedPackage,
                    trailingComment: matcher.group(4)
                )
            }
        }
        return null
    }

    private static String correctPackageDeclaration(
        String source,
        Path sourceFile,
        PackageDeclaration declaration,
        String expectedPackage
    ) {
        if (declaration != null) {
            String replacement = expectedPackage.isEmpty()
                ? (declaration.trailingComment ?: '')
                : packageStatement(sourceFile, expectedPackage, declaration.trailingComment)
            return source.substring(0, declaration.startOffset) + replacement +
                source.substring(declaration.endOffset)
        }
        if (expectedPackage.isEmpty()) {
            return source
        }

        int firstTokenOffset = skipHeaderTrivia(source)
        int insertionOffset = lineStartOffset(source, firstTokenOffset)
        String newline = detectNewline(source)
        String statement = packageStatement(sourceFile, expectedPackage, null)
        return source.substring(0, insertionOffset) + statement + newline + newline +
            source.substring(insertionOffset)
    }

    private static String packageStatement(Path sourceFile, String packageName, String trailingComment) {
        String terminator = sourceFile.fileName.toString().endsWith('.java') ? ';' : ''
        String comment = trailingComment == null ? '' : " ${trailingComment}"
        return "package ${packageName}${terminator}${comment}"
    }

    private static int skipHeaderTrivia(String source) {
        int offset = 0
        if (source.startsWith('#!')) {
            offset = endOfLine(source, offset)
        }

        while (offset < source.length()) {
            if (Character.isWhitespace(source.charAt(offset))) {
                offset++
                continue
            }
            if (source.startsWith('//', offset)) {
                offset = endOfLine(source, offset)
                continue
            }
            if (source.startsWith('/*', offset)) {
                int commentEnd = source.indexOf('*/', offset + 2)
                if (commentEnd < 0) {
                    return source.length()
                }
                offset = commentEnd + 2
                continue
            }
            break
        }
        return offset
    }

    private static int endOfLine(String source, int offset) {
        int lineFeed = source.indexOf('\n', offset)
        return lineFeed < 0 ? source.length() : lineFeed + 1
    }

    private static int lineStartOffset(String source, int offset) {
        if (offset <= 0) {
            return 0
        }
        int previousLineFeed = source.lastIndexOf('\n', Math.min(offset, source.length()) - 1)
        return previousLineFeed < 0 ? 0 : previousLineFeed + 1
    }

    private static String detectNewline(String source) {
        int lineFeed = source.indexOf('\n')
        if (lineFeed > 0 && source.charAt(lineFeed - 1) == '\r') {
            return '\r\n'
        }
        if (lineFeed >= 0) {
            return '\n'
        }
        return source.indexOf('\r') >= 0 ? '\r' : System.lineSeparator()
    }

    private static String normalizeAndValidatePackage(String packageName, String context) {
        String normalized = packageName?.trim() ?: ''
        if (normalized.isEmpty()) {
            return ''
        }
        normalized.split('\\.', -1).each { String segment ->
            validatePackageSegment(segment, context)
        }
        return normalized
    }

    private static void validatePackageSegment(String segment, String context) {
        if (segment.isEmpty() || RESERVED_PACKAGE_SEGMENTS.contains(segment)) {
            throw new IllegalArgumentException("Invalid package segment '${segment}' (${context})")
        }

        int offset = 0
        int firstCodePoint = segment.codePointAt(offset)
        if (!Character.isJavaIdentifierStart(firstCodePoint)) {
            throw new IllegalArgumentException("Invalid package segment '${segment}' (${context})")
        }
        offset += Character.charCount(firstCodePoint)
        while (offset < segment.length()) {
            int codePoint = segment.codePointAt(offset)
            if (!Character.isJavaIdentifierPart(codePoint)) {
                throw new IllegalArgumentException("Invalid package segment '${segment}' (${context})")
            }
            offset += Character.charCount(codePoint)
        }
    }

    private static boolean startsWithUtf8Bom(byte[] bytes) {
        return bytes.length >= UTF8_BOM.length &&
            bytes[0] == UTF8_BOM[0] && bytes[1] == UTF8_BOM[1] && bytes[2] == UTF8_BOM[2]
    }

    private static String decodeUtf8(byte[] bytes, boolean hasBom, Path sourceFile) {
        int offset = hasBom ? UTF8_BOM.length : 0
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, offset, bytes.length - offset))
                .toString()
        } catch (CharacterCodingException error) {
            throw new IOException("Source is not valid UTF-8: ${sourceFile}", error)
        }
    }

    private static byte[] encodeUtf8(String source, boolean includeBom) {
        byte[] encoded = source.getBytes(StandardCharsets.UTF_8)
        if (!includeBom) {
            return encoded
        }
        byte[] withBom = new byte[UTF8_BOM.length + encoded.length]
        System.arraycopy(UTF8_BOM, 0, withBom, 0, UTF8_BOM.length)
        System.arraycopy(encoded, 0, withBom, UTF8_BOM.length, encoded.length)
        return withBom
    }

    private static void replaceAtomically(Path sourceFile, byte[] content) {
        Path temporaryFile = Files.createTempFile(sourceFile.parent, '.fix-package-', '.tmp')
        try {
            Files.write(temporaryFile, content, StandardOpenOption.TRUNCATE_EXISTING)
            copyPosixPermissions(sourceFile, temporaryFile)
            try {
                Files.move(
                    temporaryFile,
                    sourceFile,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporaryFile, sourceFile, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temporaryFile)
        }
    }

    private static void copyPosixPermissions(Path sourceFile, Path temporaryFile) {
        try {
            Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(sourceFile)
            Files.setPosixFilePermissions(temporaryFile, permissions)
        } catch (UnsupportedOperationException ignored) {
            // Non-POSIX file systems preserve content correctness without this metadata.
        }
    }
}

static CommandLineOptions parseOptions(String[] arguments) {
    CommandLineOptions options = new CommandLineOptions()
    boolean sourceRootProvided = false

    for (int index = 0; index < arguments.length; index++) {
        String argument = arguments[index]
        if (argument == '--help' || argument == '-h') {
            options.helpRequested = true
        } else if (argument == '--dry-run') {
            options.dryRun = true
        } else if (argument == '--base-package') {
            if (++index >= arguments.length) {
                throw new IllegalArgumentException('--base-package requires a value')
            }
            options.basePackage = arguments[index]
        } else if (argument.startsWith('--base-package=')) {
            options.basePackage = argument.substring('--base-package='.length())
        } else if (argument.startsWith('-')) {
            throw new IllegalArgumentException("Unknown option: ${argument}")
        } else if (sourceRootProvided) {
            throw new IllegalArgumentException('Only one source root may be specified')
        } else {
            options.sourceRoot = Paths.get(argument)
            sourceRootProvided = true
        }
    }
    return options
}

static Path resolveScriptPath(Class scriptClass) {
    try {
        return Paths.get(scriptClass.protectionDomain.codeSource.location.toURI())
    } catch (Exception ignored) {
        return null
    }
}

static void printUsage() {
    println '''Usage: groovy fixPackagePaths.groovy [OPTIONS] [SOURCE_ROOT]

Recursively makes each .groovy and .java case source package match its directory.
SOURCE_ROOT defaults to the current directory and represents BASE_PACKAGE itself.

Options:
  --base-package PACKAGE   Package represented by SOURCE_ROOT (default: empty)
  --dry-run                Report changes without modifying files
  -h, --help               Show this help

Examples:
  groovy groovy-test/fixPackagePaths.groovy src/test/groovy
  groovy groovy-test/fixPackagePaths.groovy --base-package com.example src/test/groovy/com/example
'''
}

try {
    CommandLineOptions options = parseOptions(args)
    if (options.helpRequested) {
        printUsage()
        return
    }

    PackagePathFixer fixer = new PackagePathFixer(
        options.sourceRoot,
        options.basePackage,
        resolveScriptPath(this.class)
    )
    List<Path> sourceFiles = fixer.findSourceFiles()
    List<SourceChange> changes = fixer.planChanges(sourceFiles)

    changes.each { SourceChange change ->
        String oldPackage = change.currentPackage.isEmpty() ? '<default>' : change.currentPackage
        String newPackage = change.expectedPackage.isEmpty() ? '<default>' : change.expectedPackage
        println "${options.dryRun ? 'Would fix' : 'Fixing'} ${fixer.displayPath(change.sourceFile)}: " +
            "${oldPackage} -> ${newPackage}"
    }
    if (!options.dryRun) {
        fixer.applyChanges(changes)
    }

    String action = options.dryRun ? 'would be corrected' : 'corrected'
    println "Scanned ${sourceFiles.size()} source file(s); ${changes.size()} package declaration(s) ${action}."
} catch (Exception error) {
    System.err.println("Error: ${error.message}")
    System.exit(1)
}
