package control

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

const dynamicJavaExecutable = "runtime/jdk/bin/java"

func cotestAdapterExecutorSpec(
	specification ExecutionSpec,
	toolchain config.ToolchainConfig,
	adapter config.AdapterConfig,
) (executor.Spec, []ExecutionInput, error) {
	if specification.SchemaVersion != protocolVersion || specification.Executor != "testng" {
		return executor.Spec{}, nil, errors.New("CoTest adapter supports only the process TestNG executor")
	}
	if !adapter.Enabled() || specification.Adapter == nil {
		return executor.Spec{}, nil, errors.New("CoTest adapter execution is not configured")
	}
	if len(specification.Inputs) < 1 || len(specification.Inputs) > 128 {
		return executor.Spec{}, nil, errors.New("CoTest execution requires 1-128 inputs")
	}
	inputs := append([]ExecutionInput(nil), specification.Inputs...)
	var testJAR, jdkArchive, jarBundle *ExecutionInput
	for index := range inputs {
		input := &inputs[index]
		switch input.Kind {
		case "test-jar":
			if testJAR != nil {
				return executor.Spec{}, nil, errors.New("CoTest execution contains multiple test JARs")
			}
			testJAR = input
		case "jdk-archive":
			if jdkArchive != nil {
				return executor.Spec{}, nil, errors.New("CoTest execution contains multiple JDK archives")
			}
			jdkArchive = input
		case "jar-bundle":
			if jarBundle != nil {
				return executor.Spec{}, nil, errors.New("CoTest execution contains multiple JAR bundles")
			}
			jarBundle = input
		case "dependency-jar":
		default:
			return executor.Spec{}, nil, fmt.Errorf("unsupported CoTest input kind %q", input.Kind)
		}
	}
	if testJAR == nil {
		return executor.Spec{}, nil, errors.New("CoTest execution requires exactly one test JAR")
	}
	javaExecutable := toolchain.JavaExecutable
	if jdkArchive != nil {
		javaExecutable = dynamicJavaExecutable
	}
	if javaExecutable == "" {
		return executor.Spec{}, nil, errors.New("CoTest execution requires a JDK archive or local Java executable")
	}
	arguments := []string{
		"-jar", adapter.JarPath,
		"--jars", "test-jars",
		"--class", specification.ClassName,
		"--output", "reports/testng",
	}
	if specification.Adapter.SuiteName != "" {
		arguments = append(arguments, "--suite-name", specification.Adapter.SuiteName)
	}
	if specification.Adapter.TestName != "" {
		arguments = append(arguments, "--test-name", specification.Adapter.TestName)
	}
	if specification.Adapter.EnvironmentAddress != "" {
		arguments = append(
			arguments,
			"--environment-address",
			specification.Adapter.EnvironmentAddress,
		)
	}
	if specification.Adapter.CaseTimeoutSeconds < 0 || specification.Adapter.CaseTimeoutSeconds > 86_400 {
		return executor.Spec{}, nil, errors.New("adapter case timeout seconds is outside the supported range")
	}
	if specification.Adapter.CaseTimeoutSeconds > 0 {
		arguments = append(
			arguments,
			"--case-timeout-seconds",
			strconv.FormatInt(specification.Adapter.CaseTimeoutSeconds, 10),
		)
	}
	environment := make(map[string]string, len(specification.Environment))
	for _, entry := range specification.Environment {
		if _, exists := environment[entry.Name]; exists {
			return executor.Spec{}, nil, fmt.Errorf("duplicate environment variable %q", entry.Name)
		}
		environment[entry.Name] = entry.Value
	}
	return executor.Spec{
		SchemaVersion: executor.SupportedSchemaVersion,
		AttemptID:     specification.AttemptID,
		Command: executor.Command{
			Executable: javaExecutable,
			Args:       arguments,
		},
		Environment: environment,
		Limits: executor.Limits{
			TimeoutMs:          specification.TimeoutMs,
			MaxLogBytes:        min(specification.ResourceLimits.LogBytes, 64<<20),
			TerminationGraceMs: 2_000,
			CPUMillicores:      specification.ResourceLimits.CPUMillicores,
			MemoryBytes:        specification.ResourceLimits.MemoryBytes,
			DiskBytes:          specification.ResourceLimits.DiskBytes,
			ProcessCount:       specification.ResourceLimits.ProcessCount,
			FileCount:          specification.ResourceLimits.FileCount,
		},
	}, inputs, nil
}

func prepareCotestWorkspace(
	workspace string,
	inputs []ExecutionInput,
	diskLimit int64,
	fileLimit int64,
) error {
	budget, err := newCotestArchiveBudget(inputs, diskLimit, fileLimit)
	if err != nil {
		return err
	}
	if err := materializeCotestJars(workspace, filepath.Join(workspace, "test-jars"), inputs, budget); err != nil {
		return err
	}
	return materializeCotestJDK(workspace, filepath.Join(workspace, "runtime", "jdk"), inputs, budget)
}

func newCotestArchiveBudget(
	inputs []ExecutionInput,
	diskLimit int64,
	fileLimit int64,
) (*archiveBudget, error) {
	var inputBytes int64
	for _, input := range inputs {
		if input.SizeBytes <= 0 || inputBytes > diskLimit-input.SizeBytes {
			return nil, errors.New("execution inputs exceed the attempt disk limit")
		}
		inputBytes += input.SizeBytes
	}
	budget := &archiveBudget{
		remainingBytes: diskLimit - inputBytes,
		remainingFiles: fileLimit - int64(len(inputs)),
	}
	if budget.remainingBytes < 0 || budget.remainingFiles < 0 {
		return nil, errors.New("execution inputs leave no capacity for archive extraction")
	}
	return budget, nil
}

func materializeCotestJars(
	inputRoot string,
	jarDirectory string,
	inputs []ExecutionInput,
	budget *archiveBudget,
) error {
	if err := os.MkdirAll(jarDirectory, 0o700); err != nil {
		return fmt.Errorf("create adapter JAR directory: %w", err)
	}
	for index := range inputs {
		input := &inputs[index]
		source := filepath.Join(inputRoot, filepath.Clean(input.TargetPath))
		switch input.Kind {
		case "test-jar":
			if err := budget.consume(input.SizeBytes); err != nil {
				return err
			}
			if err := copyRegularFile(source, filepath.Join(jarDirectory, "autoforge-case.jar")); err != nil {
				return fmt.Errorf("publish test JAR for adapter: %w", err)
			}
		case "dependency-jar":
			if err := budget.consume(input.SizeBytes); err != nil {
				return err
			}
			if err := copyRegularFile(source, filepath.Join(jarDirectory, filepath.Base(source))); err != nil {
				return fmt.Errorf("publish dependency JAR for adapter: %w", err)
			}
		case "jar-bundle":
			if err := extractArchive(source, jarDirectory, budget); err != nil {
				return fmt.Errorf("extract dependency JAR bundle: %w", err)
			}
		}
	}
	return nil
}

func materializeCotestJDK(
	inputRoot string,
	target string,
	inputs []ExecutionInput,
	budget *archiveBudget,
) error {
	var jdkArchive *ExecutionInput
	for index := range inputs {
		if inputs[index].Kind == "jdk-archive" {
			jdkArchive = &inputs[index]
			break
		}
	}
	if jdkArchive == nil {
		return nil
	}
	unpacked := target + "-unpacked"
	if err := extractArchive(
		filepath.Join(inputRoot, filepath.Clean(jdkArchive.TargetPath)),
		unpacked,
		budget,
	); err != nil {
		return fmt.Errorf("extract JDK: %w", err)
	}
	javaHome, err := locateJavaHome(unpacked)
	if err != nil {
		return err
	}
	if err := os.Rename(javaHome, target); err != nil {
		return fmt.Errorf("publish extracted JDK: %w", err)
	}
	if err := os.Chmod(filepath.Join(target, "bin", "java"), 0o700); err != nil {
		return fmt.Errorf("make extracted Java executable: %w", err)
	}
	return os.RemoveAll(unpacked)
}

type archiveBudget struct {
	remainingBytes int64
	remainingFiles int64
}

func (budget *archiveBudget) consume(size int64) error {
	if size < 0 || budget.remainingFiles < 1 || budget.remainingBytes < size {
		return errors.New("workspace materialization exceeds the attempt limits")
	}
	budget.remainingFiles--
	budget.remainingBytes -= size
	return nil
}

func extractArchive(source, destination string, budget *archiveBudget) error {
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	lower := strings.ToLower(source)
	if strings.HasSuffix(lower, ".zip") {
		return extractZip(source, destination, budget)
	}
	if strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz") {
		return extractTarGzip(source, destination, budget)
	}
	return errors.New("archive format is unsupported")
}

func extractZip(source, destination string, budget *archiveBudget) error {
	archive, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if entry.FileInfo().Mode()&os.ModeSymlink != 0 || (!entry.FileInfo().Mode().IsRegular() && !entry.FileInfo().IsDir()) {
			return fmt.Errorf("archive entry %q is not a regular file or directory", entry.Name)
		}
		target, err := archiveTarget(destination, entry.Name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := budget.consume(0); err != nil {
				return err
			}
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if entry.UncompressedSize64 > uint64(^uint64(0)>>1) ||
			budget.consume(int64(entry.UncompressedSize64)) != nil {
			return errors.New("workspace materialization exceeds the attempt limits")
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		if err := writeArchiveFile(target, reader, int64(entry.UncompressedSize64)); err != nil {
			reader.Close()
			return err
		}
		if err := reader.Close(); err != nil {
			return err
		}
	}
	return nil
}

func extractTarGzip(source, destination string, budget *archiveBudget) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := archiveTarget(destination, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := budget.consume(0); err != nil {
				return err
			}
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if budget.consume(header.Size) != nil {
				return errors.New("workspace materialization exceeds the attempt limits")
			}
			if err := writeArchiveFile(target, reader, header.Size); err != nil {
				return err
			}
		case tar.TypeLink:
			// JDK archives reuse duplicated legal files as hard links; the link
			// target must stay inside the destination and must already exist.
			if err := budget.consume(0); err != nil {
				return err
			}
			linkTarget, err := archiveTarget(destination, header.Linkname)
			if err != nil {
				return err
			}
			if err := linkArchiveFile(linkTarget, target); err != nil {
				return fmt.Errorf("archive entry %q: %w", header.Name, err)
			}
		case tar.TypeSymlink:
			// Some JDK repacks ship duplicated files as symlinks instead; only
			// relative targets that resolve inside the destination are allowed.
			if err := budget.consume(0); err != nil {
				return err
			}
			if err := symlinkArchiveEntry(destination, target, header.Linkname); err != nil {
				return fmt.Errorf("archive entry %q: %w", header.Name, err)
			}
		default:
			return fmt.Errorf(
				"archive entry %q has a forbidden type %q",
				header.Name,
				rune(header.Typeflag),
			)
		}
	}
}

func archiveTarget(root, name string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(name))
	if cleaned == "." || !filepath.IsLocal(cleaned) {
		return "", fmt.Errorf("archive entry %q escapes the destination", name)
	}
	if len(strings.Split(cleaned, string(filepath.Separator))) > 32 {
		return "", fmt.Errorf("archive entry %q exceeds the directory depth limit", name)
	}
	return filepath.Join(root, cleaned), nil
}

func linkArchiveFile(linkTarget, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	return os.Link(linkTarget, target)
}

func symlinkArchiveEntry(root, target, linkname string) error {
	if filepath.IsAbs(filepath.FromSlash(linkname)) {
		return fmt.Errorf("symlink target %q is absolute", linkname)
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(target), filepath.FromSlash(linkname)))
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("symlink target %q escapes the destination", linkname)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	return os.Symlink(linkname, target)
}

func writeArchiveFile(target string, source io.Reader, size int64) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(file, io.LimitReader(source, size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written != size {
		return errors.New("archive entry size does not match its declaration")
	}
	return nil
}

func locateJavaHome(root string) (string, error) {
	var homes []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		depth := len(strings.Split(relative, string(filepath.Separator)))
		if entry.IsDir() && depth > 4 {
			return filepath.SkipDir
		}
		if !entry.Type().IsRegular() || entry.Name() != "java" || filepath.Base(filepath.Dir(path)) != "bin" {
			return nil
		}
		homes = append(homes, filepath.Dir(filepath.Dir(path)))
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("inspect extracted JDK: %w", err)
	}
	sort.Strings(homes)
	if len(homes) != 1 {
		return "", fmt.Errorf("JDK archive must contain exactly one bin/java, found %d", len(homes))
	}
	return homes[0], nil
}

func copyRegularFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	stat, err := input.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return errors.New("source is not a regular file")
	}
	return writeArchiveFile(destination, input, stat.Size())
}
