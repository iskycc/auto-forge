import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
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
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.FormulaEvaluator;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.codehaus.groovy.ast.ASTNode;
import org.codehaus.groovy.ast.AnnotationNode;
import org.codehaus.groovy.ast.ClassNode;
import org.codehaus.groovy.ast.MethodNode;
import org.codehaus.groovy.ast.ModuleNode;
import org.codehaus.groovy.ast.expr.Expression;
import org.codehaus.groovy.ast.expr.ListExpression;
import org.codehaus.groovy.ast.expr.PropertyExpression;
import org.codehaus.groovy.control.CompilationFailedException;
import org.codehaus.groovy.control.CompilationUnit;
import org.codehaus.groovy.control.CompilerConfiguration;
import org.codehaus.groovy.control.Phases;
import org.codehaus.groovy.control.SourceUnit;

/**
 * Applies L0/L1/L2 values from a case-analysis workbook to {@code group} members of Groovy
 * {@code @Test} annotations.
 *
 * <p>The tool uses Groovy's conversion-phase AST. It never loads, links, initializes, or executes
 * the analyzed source classes, and it disables the {@code @Grab} global transformation. After
 * persisting each changed case, it immediately stages that case's Groovy file with {@code git add}.
 */
public final class ApplyGroovyCaseGroups {
  private static final String INCLUDED_CASES_SHEET = "导出用例";
  private static final String EXCLUDED_CASES_SHEET = "排除明细";
  private static final String PACKAGE_HEADER = "包名";
  private static final String CLASS_HEADER = "类名";
  private static final String PATH_HEADER = "相对路径";
  private static final Set<String> LEVEL_HEADER_ALIASES =
      Collections.unmodifiableSet(
          new LinkedHashSet<>(
              Arrays.asList(
                  "人工等级",
                  "人工分级",
                  "用例等级",
                  "用例级别",
                  "等级",
                  "级别",
                  "CASELEVEL",
                  "LEVEL")));
  private static final String TEST_ANNOTATION_NAME = "Test";
  private static final String GROUP_MEMBER = "group";
  private static final String TEST_CASE_GROUP_NAME = "TestCaseGroup";
  private static final Set<String> SUPPORTED_LEVELS =
      Collections.unmodifiableSet(
          new LinkedHashSet<>(Arrays.asList("L0", "L1", "L2")));

  private ApplyGroovyCaseGroups() {}

  public static void main(String[] arguments) {
    try {
      Options options = Options.parse(Arrays.asList(arguments));
      if (options.showHelp) {
        System.out.println(Options.usage());
        return;
      }

      ApplyReport report = new GroupApplication().apply(options);
      System.out.printf("Loaded %d graded case(s) from %s.%n", report.caseCount, options.workbook);
      if (report.cancelled) {
        System.out.println("Cancelled by user; no Groovy source file was changed or staged.");
        return;
      }
      System.out.printf(
          "%s %d @Test annotation(s) in %d Groovy file(s); %d annotation(s) were already correct.%n",
          options.dryRun ? "Would update" : "Updated",
          report.updatedAnnotationCount,
          report.changedFileCount,
          report.unchangedAnnotationCount);
      if (options.dryRun) {
        System.out.println("Dry run only; no Groovy source file was changed.");
      } else {
        System.out.printf(
            "Ran git add after %d changed case(s).%n", report.stagedCaseCount);
      }
    } catch (IllegalArgumentException error) {
      System.err.println("Invalid input: " + error.getMessage());
      System.err.println(Options.usage());
      System.exit(2);
    } catch (Exception error) {
      throw new IllegalStateException("Failed to apply Groovy case groups", error);
    }
  }

  private static final class Options {
    private final Path sourceRoot;
    private final Path workbook;
    private final boolean dryRun;
    private final boolean showHelp;

    private Options(Path sourceRoot, Path workbook, boolean dryRun, boolean showHelp) {
      this.sourceRoot = sourceRoot;
      this.workbook = workbook;
      this.dryRun = dryRun;
      this.showHelp = showHelp;
    }

    private static Options parse(List<String> arguments) {
      Path sourceRoot = Paths.get("").toAbsolutePath().normalize();
      Path workbook = null;
      boolean dryRun = false;
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
          case "--workbook":
            workbook =
                Paths.get(requiredValue(arguments, ++index, argument))
                    .toAbsolutePath()
                    .normalize();
            break;
          case "--dry-run":
            dryRun = true;
            break;
          case "--help":
          case "-h":
            showHelp = true;
            break;
          default:
            throw new IllegalArgumentException("Unknown option: " + argument);
        }
      }

      Path resolvedWorkbook =
          workbook == null ? sourceRoot.resolve("normal-groovy-cases.xlsx") : workbook;
      if (!showHelp) {
        validateSourceRoot(sourceRoot);
        validateWorkbook(resolvedWorkbook);
      }
      return new Options(sourceRoot, resolvedWorkbook, dryRun, showHelp);
    }

    private static void validateSourceRoot(Path sourceRoot) {
      if (!Files.isDirectory(sourceRoot, LinkOption.NOFOLLOW_LINKS)) {
        throw new IllegalArgumentException("Source directory does not exist: " + sourceRoot);
      }
    }

    private static void validateWorkbook(Path workbook) {
      if (!workbook
          .getFileName()
          .toString()
          .toLowerCase(Locale.ROOT)
          .endsWith(".xlsx")) {
        throw new IllegalArgumentException("Workbook must have an .xlsx extension: " + workbook);
      }
      if (!Files.isRegularFile(workbook, LinkOption.NOFOLLOW_LINKS)) {
        throw new IllegalArgumentException("Workbook does not exist: " + workbook);
      }
    }

    private static String requiredValue(List<String> arguments, int index, String option) {
      if (index >= arguments.size() || arguments.get(index).startsWith("--")) {
        throw new IllegalArgumentException(option + " requires a value");
      }
      return arguments.get(index);
    }

    private static String usage() {
      return String.join(
          System.lineSeparator(),
          "Usage:",
          "  java -cp \"classes:lib/*\" ApplyGroovyCaseGroups [options]",
          "",
          "Options:",
          "  --source DIR          Groovy source root (default: current directory)",
          "  --workbook FILE.xlsx  Reviewed workbook (default: DIR/normal-groovy-cases.xlsx)",
          "  --dry-run             Print all planned groups without changing or staging files",
          "  -h, --help            Show this help",
          "",
          "Example:",
          "  java -cp \"target/classes:target/dependency/*\" ApplyGroovyCaseGroups \\",
          "    --source ./cases --workbook ./cases/normal-groovy-cases.xlsx");
    }
  }

  private static final class GroupApplication {
    private ApplyReport apply(Options options) throws IOException {
      List<CaseAssignment> assignments = new WorkbookAssignments().read(options.workbook);
      Map<Path, List<CaseAssignment>> assignmentsByFile = groupBySourceFile(assignments);
      ValidationResult validation =
          validateAllAssignments(options.sourceRoot, assignments, assignmentsByFile);
      GitStager gitStager = null;
      if (!options.dryRun && validation.report.updatedAnnotationCount > 0) {
        gitStager = GitStager.open(options.sourceRoot, assignmentsByFile.keySet());
      }
      printGroupPreviews(validation.casePreviews);
      if (options.dryRun) {
        return validation.report;
      }
      if (validation.report.updatedAnnotationCount == 0) {
        return validation.report;
      }
      if (!confirmApplication()) {
        return validation.report.asCancelled();
      }

      Set<Path> changedFiles = new LinkedHashSet<>();
      int updatedAnnotations = 0;
      int unchangedAnnotations = 0;
      int stagedCases = 0;
      for (CaseAssignment assignment : assignments) {
        Path sourceFile = resolveSourceFile(options.sourceRoot, assignment.relativePath);
        String source = readUtf8(sourceFile, assignment.relativePath);
        FileChange change;
        try {
          change =
              new GroovyAstGroupPlanner(assignment.relativePath.toString(), source)
                  .plan(sourceFile, Collections.singletonList(assignment));
        } catch (GroupPlanningException error) {
          throw new IllegalStateException(
              "Source changed after validation; no further cases were processed: "
                  + error.getMessage(),
              error);
        }

        updatedAnnotations += change.updatedAnnotationCount;
        unchangedAnnotations += change.unchangedAnnotationCount;
        if (!change.changed()) {
          continue;
        }
        writeAtomically(sourceFile, change.updatedSource);
        try {
          gitStager.stage(sourceFile);
        } catch (IOException stagingFailure) {
          try {
            writeAtomically(sourceFile, source);
          } catch (IOException rollbackFailure) {
            stagingFailure.addSuppressed(rollbackFailure);
          }
          throw stagingFailure;
        }
        changedFiles.add(sourceFile);
        stagedCases++;
        System.out.printf(
            "Applied %s (%s), then ran git add -- %s%n",
            assignment.qualifiedClassName(),
            assignment.level,
            gitStager.displayPath(sourceFile));
      }
      return new ApplyReport(
          assignments.size(),
          changedFiles.size(),
          updatedAnnotations,
          unchangedAnnotations,
          stagedCases,
          false);
    }

    private ValidationResult validateAllAssignments(
        Path sourceRoot,
        List<CaseAssignment> assignments,
        Map<Path, List<CaseAssignment>> assignmentsByFile) {
      List<FileChange> changes = new ArrayList<>();
      List<String> validationErrors = new ArrayList<>();
      int updatedAnnotations = 0;
      int unchangedAnnotations = 0;

      for (Map.Entry<Path, List<CaseAssignment>> entry : assignmentsByFile.entrySet()) {
        Path sourceFile = resolveSourceFile(sourceRoot, entry.getKey());
        if (!Files.isRegularFile(sourceFile, LinkOption.NOFOLLOW_LINKS)) {
          validationErrors.add("Source file does not exist: " + entry.getKey());
          continue;
        }
        if (Files.isSymbolicLink(sourceFile)) {
          validationErrors.add("Symbolic-link source files are not modified: " + entry.getKey());
          continue;
        }

        String source;
        try {
          source = readUtf8(sourceFile, entry.getKey());
        } catch (IOException invalidSource) {
          validationErrors.add(invalidSource.getMessage());
          continue;
        }

        try {
          FileChange change =
              new GroovyAstGroupPlanner(entry.getKey().toString(), source)
                  .plan(sourceFile, entry.getValue());
          changes.add(change);
          updatedAnnotations += change.updatedAnnotationCount;
          unchangedAnnotations += change.unchangedAnnotationCount;
        } catch (GroupPlanningException error) {
          validationErrors.add(error.getMessage());
        }
      }

      if (!validationErrors.isEmpty()) {
        throw new IllegalArgumentException(
            "No files were changed because validation failed:\n- "
                + String.join("\n- ", validationErrors));
      }

      int changedFiles = 0;
      List<CasePreview> casePreviews = new ArrayList<>();
      for (FileChange change : changes) {
        if (change.changed()) {
          changedFiles++;
        }
        casePreviews.addAll(change.casePreviews);
      }
      ApplyReport report =
          new ApplyReport(
              assignments.size(), changedFiles, updatedAnnotations, unchangedAnnotations, 0, false);
      return new ValidationResult(report, casePreviews);
    }

    private static void printGroupPreviews(List<CasePreview> casePreviews) {
      System.out.printf("%nPlanned @Test group values for %d case(s):%n", casePreviews.size());
      for (int caseIndex = 0; caseIndex < casePreviews.size(); caseIndex++) {
        CasePreview casePreview = casePreviews.get(caseIndex);
        CaseAssignment assignment = casePreview.assignment;
        System.out.printf(
            "[%d/%d] %s (%s) - %s%n",
            caseIndex + 1,
            casePreviews.size(),
            assignment.qualifiedClassName(),
            assignment.level,
            assignment.relativePath);
        for (AnnotationPreview annotation : casePreview.annotations) {
          System.out.printf(
              "  @Test line %d: %s -> %s%s%n",
              annotation.lineNumber,
              annotation.currentGroup,
              annotation.plannedGroup,
              annotation.changed ? "" : " (unchanged)");
        }
      }
    }

    private static boolean confirmApplication() throws IOException {
      System.out.print(
          "Apply all group changes and run git add after each changed case? [y/N]: ");
      System.out.flush();
      BufferedReader reader =
          new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      String answer = reader.readLine();
      System.out.println();
      return answer != null
          && (answer.trim().equalsIgnoreCase("y")
              || answer.trim().equalsIgnoreCase("yes"));
    }

    private static Map<Path, List<CaseAssignment>> groupBySourceFile(
        List<CaseAssignment> assignments) {
      Map<Path, List<CaseAssignment>> assignmentsByFile = new LinkedHashMap<>();
      for (CaseAssignment assignment : assignments) {
        List<CaseAssignment> fileAssignments =
            assignmentsByFile.get(assignment.relativePath);
        if (fileAssignments == null) {
          fileAssignments = new ArrayList<>();
          assignmentsByFile.put(assignment.relativePath, fileAssignments);
        }
        fileAssignments.add(assignment);
      }
      return assignmentsByFile;
    }

    private static Path resolveSourceFile(Path sourceRoot, Path relativePath) {
      Path sourceFile = sourceRoot.resolve(relativePath).normalize();
      if (!sourceFile.startsWith(sourceRoot)) {
        throw new IllegalArgumentException(
            "Workbook path escapes the source directory: " + relativePath);
      }
      return sourceFile;
    }

    private static String decodeUtf8(byte[] content) throws CharacterCodingException {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(content))
          .toString();
    }

    private static String readUtf8(Path sourceFile, Path displayPath) throws IOException {
      try {
        return decodeUtf8(Files.readAllBytes(sourceFile));
      } catch (CharacterCodingException invalidEncoding) {
        throw new IOException("Source file is not valid UTF-8: " + displayPath, invalidEncoding);
      }
    }
  }

  private static final class WorkbookAssignments {
    private final DataFormatter dataFormatter = new DataFormatter();
    private FormulaEvaluator formulaEvaluator;

    private List<CaseAssignment> read(Path workbookPath) throws IOException {
      Map<CaseKey, CaseAssignment> assignments = new LinkedHashMap<>();
      List<SheetReadSummary> sheetSummaries = new ArrayList<>();
      try (InputStream input = Files.newInputStream(workbookPath);
          XSSFWorkbook workbook = new XSSFWorkbook(input)) {
        formulaEvaluator = workbook.getCreationHelper().createFormulaEvaluator();
        sheetSummaries.add(readSheet(workbook, INCLUDED_CASES_SHEET, assignments));
        sheetSummaries.add(readSheet(workbook, EXCLUDED_CASES_SHEET, assignments));
      } finally {
        formulaEvaluator = null;
      }
      if (assignments.isEmpty()) {
        throw new IllegalArgumentException(
            "Workbook '"
                + workbookPath
                + "' contains no graded cases. Expected L0/L1/L2 in a level column named "
                + String.join(", ", LEVEL_HEADER_ALIASES)
                + ". Worksheets read: "
                + joinSheetSummaries(sheetSummaries)
                + ". Confirm that --workbook points to the reviewed file and that it was saved.");
      }
      return new ArrayList<>(assignments.values());
    }

    private SheetReadSummary readSheet(
        XSSFWorkbook workbook,
        String sheetName,
        Map<CaseKey, CaseAssignment> assignments)
        throws IOException {
      Sheet sheet = workbook.getSheet(sheetName);
      if (sheet == null) {
        throw new IOException("Workbook does not contain the '" + sheetName + "' worksheet");
      }
      Row header = sheet.getRow(0);
      if (header == null) {
        throw new IOException("Worksheet has no header row: " + sheetName);
      }
      int packageColumn = requiredColumn(header, PACKAGE_HEADER);
      int classColumn = requiredColumn(header, CLASS_HEADER);
      int pathColumn = requiredColumn(header, PATH_HEADER);
      List<String> headers = headerValues(header);
      int levelColumn = findLevelColumn(sheet, header);
      if (levelColumn < 0) {
        return new SheetReadSummary(
            sheetName, Math.max(0, sheet.getLastRowNum()), headers, "not found", 0);
      }

      int gradedRowCount = 0;
      for (int rowIndex = 1; rowIndex <= sheet.getLastRowNum(); rowIndex++) {
        Row row = sheet.getRow(rowIndex);
        if (row == null) {
          continue;
        }
        String rawLevel = cellText(row, levelColumn);
        if (rawLevel.isEmpty()) {
          continue;
        }
        String level = normalizeLevel(rawLevel);
        if (level == null) {
          throw new IllegalArgumentException(
              "Unsupported level '"
                  + rawLevel
                  + "' in worksheet "
                  + sheetName
                  + " row "
                  + (rowIndex + 1));
        }
        gradedRowCount++;

        String relativePathText = cellText(row, pathColumn).replace('\\', '/');
        String className = cellText(row, classColumn);
        if (relativePathText.isEmpty() || className.isEmpty()) {
          throw new IllegalArgumentException(
              "Missing relative path or class name in worksheet "
                  + sheetName
                  + " row "
                  + (rowIndex + 1));
        }
        Path relativePath = normalizeRelativePath(relativePathText, sheetName, rowIndex);
        CaseAssignment assignment =
            new CaseAssignment(
                relativePath,
                cellText(row, packageColumn),
                className,
                level,
                sheetName,
                rowIndex + 1);
        CaseKey key = assignment.key();
        CaseAssignment existing = assignments.get(key);
        if (existing != null && !existing.level.equals(level)) {
          throw new IllegalArgumentException(
              "Conflicting levels for "
                  + key.displayName()
                  + ": "
                  + existing.level
                  + " and "
                  + level);
        }
        if (existing == null) {
          assignments.put(key, assignment);
        }
      }
      return new SheetReadSummary(
          sheetName,
          Math.max(0, sheet.getLastRowNum()),
          headers,
          cellText(header, levelColumn),
          gradedRowCount);
    }

    private int findLevelColumn(Sheet sheet, Row header) {
      for (int column = 0; column < header.getLastCellNum(); column++) {
        if (LEVEL_HEADER_ALIASES.contains(normalizeHeader(cellText(header, column)))) {
          return column;
        }
      }

      List<Integer> inferredColumns = new ArrayList<>();
      for (int column = 0; column < header.getLastCellNum(); column++) {
        int nonBlankValues = 0;
        int levelValues = 0;
        for (int rowIndex = 1; rowIndex <= sheet.getLastRowNum(); rowIndex++) {
          Row row = sheet.getRow(rowIndex);
          if (row == null) {
            continue;
          }
          String value = cellText(row, column);
          if (value.isEmpty()) {
            continue;
          }
          nonBlankValues++;
          if (looksLikeNamedLevel(value) && normalizeLevel(value) != null) {
            levelValues++;
          }
        }
        if (nonBlankValues > 0 && nonBlankValues == levelValues) {
          inferredColumns.add(column);
        }
      }
      if (inferredColumns.size() > 1) {
        throw new IllegalArgumentException(
            "Multiple columns look like case levels in worksheet "
                + sheet.getSheetName()
                + ": "
                + inferredColumns);
      }
      return inferredColumns.isEmpty() ? -1 : inferredColumns.get(0);
    }

    private static String normalizeHeader(String header) {
      StringBuilder normalized = new StringBuilder();
      for (int index = 0; index < header.length(); index++) {
        char character = header.charAt(index);
        if (Character.isLetterOrDigit(character)) {
          normalized.append(Character.toUpperCase(character));
        }
      }
      return normalized.toString();
    }

    private static boolean looksLikeNamedLevel(String rawLevel) {
      String normalized = rawLevel.trim().toUpperCase(Locale.ROOT);
      return normalized.startsWith("L")
          || normalized.startsWith("等级L")
          || normalized.startsWith("级别L");
    }

    private static String normalizeLevel(String rawLevel) {
      String value = rawLevel.trim();
      if (value.length() >= 4 && value.startsWith("=\"") && value.endsWith("\"")) {
        value = value.substring(2, value.length() - 1);
      }
      String normalized =
          value
              .toUpperCase(Locale.ROOT)
              .replaceAll("[\\s_\\-]", "")
              .replace("等级", "")
              .replace("级别", "")
              .replace("级", "");
      if (SUPPORTED_LEVELS.contains(normalized)) {
        return normalized;
      }
      if (normalized.equals("0")) {
        return "L0";
      }
      if (normalized.equals("1")) {
        return "L1";
      }
      if (normalized.equals("2") || normalized.equals("5")) {
        return "L2";
      }
      return null;
    }

    private List<String> headerValues(Row header) {
      List<String> headers = new ArrayList<>();
      for (int column = 0; column < header.getLastCellNum(); column++) {
        headers.add(cellText(header, column));
      }
      return headers;
    }

    private static String joinSheetSummaries(List<SheetReadSummary> summaries) {
      List<String> values = new ArrayList<>();
      for (SheetReadSummary summary : summaries) {
        values.add(summary.toString());
      }
      return String.join("; ", values);
    }

    private static Path normalizeRelativePath(
        String pathText, String sheetName, int zeroBasedRowIndex) {
      Path relativePath = Paths.get(pathText).normalize();
      if (relativePath.isAbsolute()
          || relativePath.getNameCount() == 0
          || relativePath.startsWith("..")) {
        throw new IllegalArgumentException(
            "Unsafe relative path in worksheet "
                + sheetName
                + " row "
                + (zeroBasedRowIndex + 1)
                + ": "
                + pathText);
      }
      return relativePath;
    }

    private int requiredColumn(Row header, String headerName) throws IOException {
      int column = findColumn(header, headerName);
      if (column < 0) {
        throw new IOException("Missing required worksheet column: " + headerName);
      }
      return column;
    }

    private int findColumn(Row header, String headerName) {
      for (int column = 0; column < header.getLastCellNum(); column++) {
        Cell cell = header.getCell(column);
        if (cell != null && dataFormatter.formatCellValue(cell).trim().equals(headerName)) {
          return column;
        }
      }
      return -1;
    }

    private String cellText(Row row, int column) {
      Cell cell = row.getCell(column);
      if (cell == null) {
        return "";
      }
      try {
        return formulaEvaluator == null
            ? dataFormatter.formatCellValue(cell).trim()
            : dataFormatter.formatCellValue(cell, formulaEvaluator).trim();
      } catch (RuntimeException formulaFailure) {
        return cachedOrFormulaText(cell);
      }
    }

    private String cachedOrFormulaText(Cell cell) {
      if (cell.getCellType() != Cell.CELL_TYPE_FORMULA) {
        return dataFormatter.formatCellValue(cell).trim();
      }
      try {
        switch (cell.getCachedFormulaResultType()) {
          case Cell.CELL_TYPE_STRING:
            return cell.getStringCellValue().trim();
          case Cell.CELL_TYPE_NUMERIC:
            double value = cell.getNumericCellValue();
            long integerValue = (long) value;
            return value == integerValue ? Long.toString(integerValue) : Double.toString(value);
          case Cell.CELL_TYPE_BOOLEAN:
            return Boolean.toString(cell.getBooleanCellValue());
          default:
            return dataFormatter.formatCellValue(cell).trim();
        }
      } catch (RuntimeException invalidCachedValue) {
        return dataFormatter.formatCellValue(cell).trim();
      }
    }
  }

  private static final class SheetReadSummary {
    private final String sheetName;
    private final int dataRowCount;
    private final List<String> headers;
    private final String levelHeader;
    private final int gradedRowCount;

    private SheetReadSummary(
        String sheetName,
        int dataRowCount,
        List<String> headers,
        String levelHeader,
        int gradedRowCount) {
      this.sheetName = sheetName;
      this.dataRowCount = dataRowCount;
      this.headers = headers;
      this.levelHeader = levelHeader;
      this.gradedRowCount = gradedRowCount;
    }

    @Override
    public String toString() {
      return sheetName
          + " {rows="
          + dataRowCount
          + ", levelColumn="
          + levelHeader
          + ", gradedRows="
          + gradedRowCount
          + ", headers="
          + headers
          + "}";
    }
  }

  private static final class GitStager {
    private final Path repositoryRoot;

    private GitStager(Path repositoryRoot) {
      this.repositoryRoot = repositoryRoot;
    }

    private static GitStager open(Path sourceRoot, Set<Path> relativeSourcePaths)
        throws IOException {
      CommandResult repositoryLookup =
          runGit(sourceRoot, Arrays.asList("rev-parse", "--show-toplevel"));
      if (repositoryLookup.exitCode != 0 || repositoryLookup.output.trim().isEmpty()) {
        throw new IllegalArgumentException(
            "Source root is not inside a Git worktree; git add is required after every changed case: "
                + sourceRoot
                + commandFailureSuffix(repositoryLookup));
      }
      Path repositoryRoot =
          Paths.get(repositoryLookup.output.trim()).toAbsolutePath().normalize();
      GitStager stager = new GitStager(repositoryRoot);
      for (Path relativeSourcePath : relativeSourcePaths) {
        Path sourceFile = sourceRoot.resolve(relativeSourcePath).normalize();
        stager.requireInsideRepository(sourceFile);
        CommandResult preflight =
            runGit(
                repositoryRoot,
                Arrays.asList(
                    "add", "--dry-run", "--", stager.displayPath(sourceFile)));
        if (preflight.exitCode != 0) {
          throw new IllegalArgumentException(
              "git add preflight failed for "
                  + stager.displayPath(sourceFile)
                  + commandFailureSuffix(preflight));
        }
      }
      return stager;
    }

    private void stage(Path sourceFile) throws IOException {
      requireInsideRepository(sourceFile);
      String displayPath = displayPath(sourceFile);
      CommandResult result =
          runGit(repositoryRoot, Arrays.asList("add", "--", displayPath));
      if (result.exitCode != 0) {
        throw new IOException(
            "git add failed for " + displayPath + commandFailureSuffix(result));
      }
    }

    private String displayPath(Path sourceFile) {
      return repositoryRoot.relativize(sourceFile.toAbsolutePath().normalize()).toString();
    }

    private void requireInsideRepository(Path sourceFile) {
      Path normalizedSourceFile = sourceFile.toAbsolutePath().normalize();
      if (!normalizedSourceFile.startsWith(repositoryRoot)) {
        throw new IllegalArgumentException(
            "Source file is outside the Git worktree: " + normalizedSourceFile);
      }
    }

    private static CommandResult runGit(Path workingDirectory, List<String> arguments)
        throws IOException {
      List<String> command = new ArrayList<>();
      command.add("git");
      command.add("-C");
      command.add(workingDirectory.toString());
      command.addAll(arguments);
      Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
      byte[] output;
      try (InputStream input = process.getInputStream()) {
        output = readRemainingBytes(input);
      }
      int exitCode;
      try {
        exitCode = process.waitFor();
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new IOException("Interrupted while running git", interrupted);
      }
      return new CommandResult(exitCode, new String(output, StandardCharsets.UTF_8));
    }

    private static byte[] readRemainingBytes(InputStream input) throws IOException {
      ByteArrayOutputStream content = new ByteArrayOutputStream();
      byte[] buffer = new byte[4_096];
      int bytesRead;
      while ((bytesRead = input.read(buffer)) >= 0) {
        content.write(buffer, 0, bytesRead);
      }
      return content.toByteArray();
    }

    private static String commandFailureSuffix(CommandResult result) {
      String output = result.output.trim();
      return output.isEmpty() ? "" : ": " + output;
    }
  }

  private static final class CommandResult {
    private final int exitCode;
    private final String output;

    private CommandResult(int exitCode, String output) {
      this.exitCode = exitCode;
      this.output = output;
    }
  }

  private static final class GroovyAstGroupPlanner {
    private static final Set<String> DISABLED_GLOBAL_TRANSFORMS =
        Collections.singleton("groovy.grape.GrabAnnotationTransformation");

    private final String displayPath;
    private final String source;
    private final SourcePositions sourcePositions;

    private GroovyAstGroupPlanner(String displayPath, String source) {
      this.displayPath = displayPath;
      this.source = source;
      this.sourcePositions = new SourcePositions(source);
    }

    private FileChange plan(Path sourceFile, List<CaseAssignment> assignments)
        throws GroupPlanningException {
      ModuleNode module = parseModule();
      List<TextEdit> edits = new ArrayList<>();
      List<CasePreview> casePreviews = new ArrayList<>();
      int updatedAnnotations = 0;
      int unchangedAnnotations = 0;

      for (CaseAssignment assignment : assignments) {
        ClassNode caseClass = findCaseClass(module, assignment);
        List<AnnotationNode> testAnnotations = findTestAnnotations(caseClass);
        if (testAnnotations.isEmpty()) {
          throw problem(
              assignment,
              "no class-level or method-level @Test annotation was found");
        }
        List<AnnotationPreview> annotationPreviews = new ArrayList<>();
        for (AnnotationNode annotation : testAnnotations) {
          AnnotationPlan annotationPlan = planAnnotation(annotation, assignment);
          annotationPreviews.add(annotationPlan.preview);
          if (annotationPlan.edit == null) {
            unchangedAnnotations++;
          } else {
            edits.add(annotationPlan.edit);
            updatedAnnotations++;
          }
        }
        annotationPreviews.sort(Comparator.comparingInt(preview -> preview.lineNumber));
        casePreviews.add(new CasePreview(assignment, annotationPreviews));
      }

      validateNonOverlapping(edits);
      String updatedSource = applyEdits(edits);
      return new FileChange(
          sourceFile,
          source,
          updatedSource,
          updatedAnnotations,
          unchangedAnnotations,
          casePreviews);
    }

    private ModuleNode parseModule() throws GroupPlanningException {
      CompilerConfiguration configuration = new CompilerConfiguration();
      configuration.setTargetBytecode(CompilerConfiguration.JDK8);
      configuration.setDisabledGlobalASTTransformations(DISABLED_GLOBAL_TRANSFORMS);
      CompilationUnit compilationUnit = new CompilationUnit(configuration);
      SourceUnit sourceUnit = compilationUnit.addSource(displayPath, source);
      try {
        compilationUnit.compile(Phases.CONVERSION);
      } catch (CompilationFailedException error) {
        throw new GroupPlanningException(
            displayPath + ": Groovy AST parsing failed: " + error.getMessage(), error);
      }
      ModuleNode module = sourceUnit.getAST();
      if (module == null) {
        throw new GroupPlanningException(displayPath + ": Groovy parser returned no module AST");
      }
      return module;
    }

    private ClassNode findCaseClass(ModuleNode module, CaseAssignment assignment)
        throws GroupPlanningException {
      List<ClassNode> matches = new ArrayList<>();
      for (ClassNode candidate : module.getClasses()) {
        if (candidate.getOuterClass() != null) {
          continue;
        }
        if (!candidate.getNameWithoutPackage().equals(assignment.className)) {
          continue;
        }
        String packageName = candidate.getPackageName();
        if (packageName == null) {
          packageName = "";
        }
        if (packageName.equals(assignment.packageName)) {
          matches.add(candidate);
        }
      }
      if (matches.isEmpty()) {
        throw problem(assignment, "the class was not found in the Groovy AST");
      }
      if (matches.size() > 1) {
        throw problem(assignment, "multiple matching classes were found in the Groovy AST");
      }
      return matches.get(0);
    }

    private List<AnnotationNode> findTestAnnotations(ClassNode caseClass) {
      Set<AnnotationNode> annotations =
          Collections.newSetFromMap(new IdentityHashMap<AnnotationNode, Boolean>());
      addTestAnnotations(caseClass.getAnnotations(), annotations);
      for (MethodNode method : caseClass.getMethods()) {
        if (method.getDeclaringClass() == caseClass) {
          addTestAnnotations(method.getAnnotations(), annotations);
        }
      }
      return new ArrayList<>(annotations);
    }

    private static void addTestAnnotations(
        List<AnnotationNode> candidates, Set<AnnotationNode> annotations) {
      for (AnnotationNode annotation : candidates) {
        if (annotation.getClassNode().getNameWithoutPackage().equals(TEST_ANNOTATION_NAME)) {
          annotations.add(annotation);
        }
      }
    }

    private AnnotationPlan planAnnotation(AnnotationNode annotation, CaseAssignment assignment)
        throws GroupPlanningException {
      String desiredGroup = TEST_CASE_GROUP_NAME + "." + assignment.level;
      Expression groupExpression = annotation.getMember(GROUP_MEMBER);
      if (groupExpression == null) {
        TextEdit edit = addMissingGroup(annotation, desiredGroup, assignment);
        return annotationPlan(annotation, "<not set>", "[" + desiredGroup + "]", edit);
      }
      SourceRange groupRange = range(groupExpression, assignment, "group value");
      String currentGroup = source.substring(groupRange.start, groupRange.end);
      TextEdit edit;
      if (groupExpression instanceof ListExpression) {
        edit = updateGroupList((ListExpression) groupExpression, desiredGroup, assignment);
      } else if (isLevelGroup(groupExpression)) {
        if (levelName(groupExpression).equals(assignment.level)) {
          edit = null;
        } else {
          edit = new TextEdit(groupRange.start, groupRange.end, desiredGroup);
        }
      } else {
        edit =
            new TextEdit(
                groupRange.start,
                groupRange.end,
                "[" + currentGroup + ", " + desiredGroup + "]");
      }
      String plannedGroup =
          edit == null ? currentGroup : applyEditWithinRange(groupRange, edit);
      return annotationPlan(annotation, currentGroup, plannedGroup, edit);
    }

    private AnnotationPlan annotationPlan(
        AnnotationNode annotation, String currentGroup, String plannedGroup, TextEdit edit) {
      AnnotationPreview preview =
          new AnnotationPreview(
              annotation.getLineNumber(),
              compactPreview(currentGroup),
              compactPreview(plannedGroup),
              edit != null);
      return new AnnotationPlan(edit, preview);
    }

    private String applyEditWithinRange(SourceRange range, TextEdit edit) {
      StringBuilder value = new StringBuilder(source.substring(range.start, range.end));
      value.replace(
          edit.start - range.start,
          edit.end - range.start,
          edit.replacement);
      return value.toString();
    }

    private static String compactPreview(String value) {
      return value.replaceAll("\\s+", " ").trim();
    }

    private TextEdit addMissingGroup(
        AnnotationNode annotation, String desiredGroup, CaseAssignment assignment)
        throws GroupPlanningException {
      SourceRange annotationRange = range(annotation, assignment, "@Test annotation");
      int lastToken = previousNonWhitespace(annotationRange.end - 1, annotationRange.start);
      if (lastToken >= annotationRange.start && source.charAt(lastToken) == ')') {
        String separator = annotation.getMembers().isEmpty() ? "" : ", ";
        return new TextEdit(
            lastToken,
            lastToken,
            separator + GROUP_MEMBER + " = [" + desiredGroup + "]");
      }
      if (!annotation.getMembers().isEmpty()) {
        throw problem(
            assignment,
            "@Test members were parsed but the annotation closing parenthesis could not be located");
      }
      return new TextEdit(
          annotationRange.end,
          annotationRange.end,
          "(" + GROUP_MEMBER + " = [" + desiredGroup + "])");
    }

    private TextEdit updateGroupList(
        ListExpression groupList, String desiredGroup, CaseAssignment assignment)
        throws GroupPlanningException {
      List<Expression> existingLevels = new ArrayList<>();
      for (Expression expression : groupList.getExpressions()) {
        if (isLevelGroup(expression)) {
          existingLevels.add(expression);
        }
      }
      if (existingLevels.size() > 1) {
        throw problem(
            assignment,
            "the @Test group list contains multiple L0/L1/L2 markers and is ambiguous");
      }
      if (existingLevels.size() == 1) {
        Expression existingLevel = existingLevels.get(0);
        if (levelName(existingLevel).equals(assignment.level)) {
          return null;
        }
        SourceRange levelRange = range(existingLevel, assignment, "existing level group");
        return new TextEdit(levelRange.start, levelRange.end, desiredGroup);
      }

      SourceRange listRange = range(groupList, assignment, "group list");
      int closingBracket = previousNonWhitespace(listRange.end - 1, listRange.start);
      if (closingBracket < listRange.start || source.charAt(closingBracket) != ']') {
        throw problem(assignment, "the closing bracket of the @Test group list was not found");
      }
      int previousToken = previousNonWhitespace(closingBracket - 1, listRange.start);
      String separator;
      if (groupList.getExpressions().isEmpty() || previousToken < listRange.start) {
        separator = "";
      } else if (source.charAt(previousToken) == ',') {
        separator = " ";
      } else {
        separator = ", ";
      }
      return new TextEdit(closingBracket, closingBracket, separator + desiredGroup);
    }

    private static boolean isLevelGroup(Expression expression) {
      if (!(expression instanceof PropertyExpression)) {
        return false;
      }
      PropertyExpression property = (PropertyExpression) expression;
      String propertyName = property.getPropertyAsString();
      if (!SUPPORTED_LEVELS.contains(propertyName)) {
        return false;
      }
      String owner = property.getObjectExpression().getText();
      return owner.equals(TEST_CASE_GROUP_NAME)
          || owner.endsWith("." + TEST_CASE_GROUP_NAME);
    }

    private static String levelName(Expression expression) {
      return ((PropertyExpression) expression).getPropertyAsString();
    }

    private SourceRange range(
        ASTNode node, CaseAssignment assignment, String description)
        throws GroupPlanningException {
      try {
        return sourcePositions.range(node);
      } catch (IllegalArgumentException invalidPosition) {
        throw problem(
            assignment,
            "Groovy AST did not provide a valid source range for " + description);
      }
    }

    private int previousNonWhitespace(int start, int lowerBound) {
      for (int index = start; index >= lowerBound; index--) {
        if (!Character.isWhitespace(source.charAt(index))) {
          return index;
        }
      }
      return -1;
    }

    private void validateNonOverlapping(List<TextEdit> edits) throws GroupPlanningException {
      List<TextEdit> ordered = new ArrayList<>(edits);
      ordered.sort(Comparator.comparingInt(edit -> edit.start));
      for (int index = 1; index < ordered.size(); index++) {
        TextEdit previous = ordered.get(index - 1);
        TextEdit current = ordered.get(index);
        if (current.start < previous.end) {
          throw new GroupPlanningException(
              displayPath + ": planned @Test source edits overlap; no files were changed");
        }
      }
    }

    private String applyEdits(List<TextEdit> edits) {
      List<TextEdit> descending = new ArrayList<>(edits);
      descending.sort((left, right) -> Integer.compare(right.start, left.start));
      StringBuilder updated = new StringBuilder(source);
      for (TextEdit edit : descending) {
        updated.replace(edit.start, edit.end, edit.replacement);
      }
      return updated.toString();
    }

    private GroupPlanningException problem(CaseAssignment assignment, String message) {
      return new GroupPlanningException(
          displayPath
              + ": "
              + assignment.qualifiedClassName()
              + " ("
              + assignment.sheetName
              + " row "
              + assignment.rowNumber
              + "): "
              + message);
    }
  }

  private static final class SourcePositions {
    private final String source;
    private final List<Integer> lineStarts = new ArrayList<>();

    private SourcePositions(String source) {
      this.source = source;
      lineStarts.add(0);
      for (int index = 0; index < source.length(); index++) {
        if (source.charAt(index) == '\n') {
          lineStarts.add(index + 1);
        }
      }
    }

    private SourceRange range(ASTNode node) {
      int start = offset(node.getLineNumber(), node.getColumnNumber());
      int end = offset(node.getLastLineNumber(), node.getLastColumnNumber());
      if (start < 0 || end < start || end > source.length()) {
        throw new IllegalArgumentException("Invalid AST source range");
      }
      return new SourceRange(start, end);
    }

    private int offset(int oneBasedLine, int oneBasedColumn) {
      if (oneBasedLine < 1 || oneBasedLine > lineStarts.size() || oneBasedColumn < 1) {
        return -1;
      }
      int offset = lineStarts.get(oneBasedLine - 1) + oneBasedColumn - 1;
      return offset <= source.length() ? offset : -1;
    }
  }

  private static final class SourceRange {
    private final int start;
    private final int end;

    private SourceRange(int start, int end) {
      this.start = start;
      this.end = end;
    }
  }

  private static final class TextEdit {
    private final int start;
    private final int end;
    private final String replacement;

    private TextEdit(int start, int end, String replacement) {
      this.start = start;
      this.end = end;
      this.replacement = replacement;
    }
  }

  private static final class CaseAssignment {
    private final Path relativePath;
    private final String packageName;
    private final String className;
    private final String level;
    private final String sheetName;
    private final int rowNumber;

    private CaseAssignment(
        Path relativePath,
        String packageName,
        String className,
        String level,
        String sheetName,
        int rowNumber) {
      this.relativePath = relativePath;
      this.packageName = packageName;
      this.className = className;
      this.level = level;
      this.sheetName = sheetName;
      this.rowNumber = rowNumber;
    }

    private CaseKey key() {
      return new CaseKey(relativePath, packageName, className);
    }

    private String qualifiedClassName() {
      return packageName.isEmpty() ? className : packageName + "." + className;
    }
  }

  private static final class CaseKey {
    private final Path relativePath;
    private final String packageName;
    private final String className;

    private CaseKey(Path relativePath, String packageName, String className) {
      this.relativePath = relativePath;
      this.packageName = packageName;
      this.className = className;
    }

    private String displayName() {
      String qualifiedName = packageName.isEmpty() ? className : packageName + "." + className;
      return qualifiedName + " in " + relativePath;
    }

    @Override
    public boolean equals(Object other) {
      if (this == other) {
        return true;
      }
      if (!(other instanceof CaseKey)) {
        return false;
      }
      CaseKey that = (CaseKey) other;
      return relativePath.equals(that.relativePath)
          && packageName.equals(that.packageName)
          && className.equals(that.className);
    }

    @Override
    public int hashCode() {
      int result = relativePath.hashCode();
      result = 31 * result + packageName.hashCode();
      result = 31 * result + className.hashCode();
      return result;
    }
  }

  private static final class FileChange {
    private final Path sourceFile;
    private final String originalSource;
    private final String updatedSource;
    private final int updatedAnnotationCount;
    private final int unchangedAnnotationCount;
    private final List<CasePreview> casePreviews;

    private FileChange(
        Path sourceFile,
        String originalSource,
        String updatedSource,
        int updatedAnnotationCount,
        int unchangedAnnotationCount,
        List<CasePreview> casePreviews) {
      this.sourceFile = sourceFile;
      this.originalSource = originalSource;
      this.updatedSource = updatedSource;
      this.updatedAnnotationCount = updatedAnnotationCount;
      this.unchangedAnnotationCount = unchangedAnnotationCount;
      this.casePreviews = casePreviews;
    }

    private boolean changed() {
      return !originalSource.equals(updatedSource);
    }
  }

  private static final class ValidationResult {
    private final ApplyReport report;
    private final List<CasePreview> casePreviews;

    private ValidationResult(ApplyReport report, List<CasePreview> casePreviews) {
      this.report = report;
      this.casePreviews = casePreviews;
    }
  }

  private static final class CasePreview {
    private final CaseAssignment assignment;
    private final List<AnnotationPreview> annotations;

    private CasePreview(CaseAssignment assignment, List<AnnotationPreview> annotations) {
      this.assignment = assignment;
      this.annotations = annotations;
    }
  }

  private static final class AnnotationPreview {
    private final int lineNumber;
    private final String currentGroup;
    private final String plannedGroup;
    private final boolean changed;

    private AnnotationPreview(
        int lineNumber, String currentGroup, String plannedGroup, boolean changed) {
      this.lineNumber = lineNumber;
      this.currentGroup = currentGroup;
      this.plannedGroup = plannedGroup;
      this.changed = changed;
    }
  }

  private static final class AnnotationPlan {
    private final TextEdit edit;
    private final AnnotationPreview preview;

    private AnnotationPlan(TextEdit edit, AnnotationPreview preview) {
      this.edit = edit;
      this.preview = preview;
    }
  }

  private static final class ApplyReport {
    private final int caseCount;
    private final int changedFileCount;
    private final int updatedAnnotationCount;
    private final int unchangedAnnotationCount;
    private final int stagedCaseCount;
    private final boolean cancelled;

    private ApplyReport(
        int caseCount,
        int changedFileCount,
        int updatedAnnotationCount,
        int unchangedAnnotationCount,
        int stagedCaseCount,
        boolean cancelled) {
      this.caseCount = caseCount;
      this.changedFileCount = changedFileCount;
      this.updatedAnnotationCount = updatedAnnotationCount;
      this.unchangedAnnotationCount = unchangedAnnotationCount;
      this.stagedCaseCount = stagedCaseCount;
      this.cancelled = cancelled;
    }

    private ApplyReport asCancelled() {
      return new ApplyReport(
          caseCount,
          changedFileCount,
          updatedAnnotationCount,
          unchangedAnnotationCount,
          0,
          true);
    }
  }

  private static final class GroupPlanningException extends Exception {
    private GroupPlanningException(String message) {
      super(message);
    }

    private GroupPlanningException(String message, Throwable cause) {
      super(message, cause);
    }
  }

  private static void writeAtomically(Path sourceFile, String content) throws IOException {
    Path parent = sourceFile.getParent();
    if (parent == null) {
      throw new IOException("Source file must have a parent directory: " + sourceFile);
    }
    Path temporaryFile =
        Files.createTempFile(parent, "." + sourceFile.getFileName().toString() + ".", ".tmp");
    try {
      Files.write(
          temporaryFile,
          content.getBytes(StandardCharsets.UTF_8),
          StandardOpenOption.TRUNCATE_EXISTING,
          StandardOpenOption.WRITE);
      copyPosixPermissions(sourceFile, temporaryFile);
      moveAtomically(temporaryFile, sourceFile);
    } finally {
      Files.deleteIfExists(temporaryFile);
    }
  }

  private static void copyPosixPermissions(Path source, Path target) throws IOException {
    try {
      Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(source);
      Files.setPosixFilePermissions(target, permissions);
    } catch (UnsupportedOperationException ignored) {
      // Permission copying is unavailable on non-POSIX file systems.
    }
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
