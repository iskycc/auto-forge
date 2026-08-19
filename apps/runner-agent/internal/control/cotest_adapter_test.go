package control

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

func TestCotestAdapterExecutorUsesDownloadedJDKAndProjectSettings(t *testing.T) {
	specification := testExecutionSpec()
	specification.Adapter = &AdapterSettings{
		SuiteName:          "project-suite",
		TestName:           "system-test",
		EnvironmentAddress: "10.0.0.8",
	}
	specification.Inputs = append(specification.Inputs, ExecutionInput{
		InputID: "jdk-1", Kind: "jdk-archive", TargetPath: "runtime-inputs/jdk.zip",
		MediaType: "application/zip", SizeBytes: 10, SHA256: strings.Repeat("a", 64),
	})

	mapped, _, err := cotestAdapterExecutorSpec(
		specification,
		config.ToolchainConfig{},
		config.AdapterConfig{JarPath: "/opt/autoforge/lib/cotest-testng-adapter.jar"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.Command.Executable != dynamicJavaExecutable {
		t.Fatalf("executable = %q", mapped.Command.Executable)
	}
	assertJavaUTF8Arguments(t, mapped.Command.Args)
	arguments := strings.Join(mapped.Command.Args, " ")
	for _, expected := range []string{
		"-jar /opt/autoforge/lib/cotest-testng-adapter.jar",
		"--jars test-jars",
		"--class com.example.SmokeTest",
		"--suite-name project-suite",
		"--test-name system-test",
		"--environment-address 10.0.0.8",
	} {
		if !strings.Contains(arguments, expected) {
			t.Fatalf("arguments %q do not contain %q", arguments, expected)
		}
	}
}

func assertJavaUTF8Arguments(t *testing.T, arguments []string) {
	t.Helper()
	expected := javaUTF8Arguments()
	if len(arguments) < len(expected) {
		t.Fatalf("arguments = %#v, want UTF-8 JVM properties first", arguments)
	}
	for index, value := range expected {
		if arguments[index] != value {
			t.Fatalf("arguments[%d] = %q, want %q", index, arguments[index], value)
		}
	}
}

func TestCotestAdapterExecutorPassesCaseTimeoutWhenConfigured(t *testing.T) {
	specification := testExecutionSpec()
	specification.Adapter = &AdapterSettings{CaseTimeoutSeconds: 120}

	mapped, _, err := cotestAdapterExecutorSpec(
		specification,
		config.ToolchainConfig{JavaExecutable: "/usr/bin/java"},
		config.AdapterConfig{JarPath: "/opt/autoforge/lib/cotest-testng-adapter.jar"},
	)
	if err != nil {
		t.Fatal(err)
	}
	arguments := strings.Join(mapped.Command.Args, " ")
	if !strings.Contains(arguments, "--case-timeout-seconds 120") {
		t.Fatalf("arguments %q do not contain the case timeout", arguments)
	}
}

func TestCotestAdapterExecutorOmitsCaseTimeoutWhenAbsent(t *testing.T) {
	specification := testExecutionSpec()
	specification.Adapter = &AdapterSettings{SuiteName: "suite"}

	mapped, _, err := cotestAdapterExecutorSpec(
		specification,
		config.ToolchainConfig{JavaExecutable: "/usr/bin/java"},
		config.AdapterConfig{JarPath: "/opt/autoforge/lib/cotest-testng-adapter.jar"},
	)
	if err != nil {
		t.Fatal(err)
	}
	arguments := strings.Join(mapped.Command.Args, " ")
	if strings.Contains(arguments, "--case-timeout-seconds") {
		t.Fatalf("arguments %q must not contain a case timeout", arguments)
	}
}

func TestCotestAdapterExecutorRejectsCaseTimeoutOutOfRange(t *testing.T) {
	specification := testExecutionSpec()
	specification.Adapter = &AdapterSettings{CaseTimeoutSeconds: 100_000}

	_, _, err := cotestAdapterExecutorSpec(
		specification,
		config.ToolchainConfig{JavaExecutable: "/usr/bin/java"},
		config.AdapterConfig{JarPath: "/opt/autoforge/lib/cotest-testng-adapter.jar"},
	)
	if err == nil || !strings.Contains(err.Error(), "case timeout") {
		t.Fatalf("cotestAdapterExecutorSpec() error = %v", err)
	}
}

func TestPrepareCotestWorkspaceExtractsJDKAndJars(t *testing.T) {
	workspace := t.TempDir()
	writeFixture(t, filepath.Join(workspace, "inputs", "tests.jar"), []byte("case"))
	writeZipFixture(t, filepath.Join(workspace, "runtime-inputs", "jdk.zip"), map[string]string{
		"jdk-21/bin/java": "java",
	})
	writeZipFixture(t, filepath.Join(workspace, "runtime-inputs", "jars.zip"), map[string]string{
		"lib/testng.jar":  "testng",
		"lib/project.jar": "project",
	})
	inputs := []ExecutionInput{
		{Kind: "test-jar", TargetPath: "inputs/tests.jar", SizeBytes: 4},
		{Kind: "jdk-archive", TargetPath: "runtime-inputs/jdk.zip", SizeBytes: fileSize(t, filepath.Join(workspace, "runtime-inputs", "jdk.zip"))},
		{Kind: "jar-bundle", TargetPath: "runtime-inputs/jars.zip", SizeBytes: fileSize(t, filepath.Join(workspace, "runtime-inputs", "jars.zip"))},
	}
	if err := prepareCotestWorkspace(workspace, inputs, 1<<20, 100); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"runtime/jdk/bin/java",
		"test-jars/autoforge-case.jar",
		"test-jars/lib/testng.jar",
		"test-jars/lib/project.jar",
	} {
		if _, err := os.Stat(filepath.Join(workspace, filepath.FromSlash(expected))); err != nil {
			t.Fatalf("expected %s: %v", expected, err)
		}
	}
}

func TestExtractArchiveRejectsPathTraversal(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "unsafe.zip")
	writeZipFixture(t, archive, map[string]string{"../escape.jar": "bad"})
	err := extractArchive(archive, t.TempDir(), &archiveBudget{remainingBytes: 100, remainingFiles: 10})
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("extractArchive() error = %v", err)
	}
}

func TestPrepareCotestWorkspaceCountsCopiedJarsAgainstDiskLimit(t *testing.T) {
	workspace := t.TempDir()
	path := filepath.Join(workspace, "inputs", "tests.jar")
	writeFixture(t, path, []byte("case"))
	err := prepareCotestWorkspace(
		workspace,
		[]ExecutionInput{{Kind: "test-jar", TargetPath: "inputs/tests.jar", SizeBytes: 4}},
		7,
		10,
	)
	if err == nil || !strings.Contains(err.Error(), "workspace materialization exceeds") {
		t.Fatalf("prepareCotestWorkspace() error = %v", err)
	}
}

func TestExtractArchiveExtractsTarHardLinks(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "jdk.tar.gz")
	writeTarGzipFixture(t, archive, []tarFixtureEntry{
		{name: "jdk-21/legal/java.base/ADDITIONAL_LICENSE_INFO", content: "license"},
		{name: "jdk-21/legal/java.compiler/ADDITIONAL_LICENSE_INFO", link: "jdk-21/legal/java.base/ADDITIONAL_LICENSE_INFO"},
	})
	destination := t.TempDir()
	if err := extractArchive(archive, destination, &archiveBudget{remainingBytes: 100, remainingFiles: 10}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(destination, "jdk-21", "legal", "java.compiler", "ADDITIONAL_LICENSE_INFO"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "license" {
		t.Fatalf("hard-linked content = %q", content)
	}
}

func TestExtractArchiveRejectsEscapingHardLink(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "unsafe.tar.gz")
	writeTarGzipFixture(t, archive, []tarFixtureEntry{
		{name: "jdk-21/legal/link", link: "../outside"},
	})
	err := extractArchive(archive, t.TempDir(), &archiveBudget{remainingBytes: 100, remainingFiles: 10})
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("extractArchive() error = %v", err)
	}
}

func TestExtractArchiveExtractsTarSymlinks(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "jdk.tar.gz")
	writeTarGzipFixture(t, archive, []tarFixtureEntry{
		{name: "jdk-21/legal/java.base/ADDITIONAL_LICENSE_INFO", content: "license"},
		{name: "jdk-21/legal/java.compiler/ADDITIONAL_LICENSE_INFO", symlink: "../java.base/ADDITIONAL_LICENSE_INFO"},
	})
	destination := t.TempDir()
	if err := extractArchive(archive, destination, &archiveBudget{remainingBytes: 100, remainingFiles: 10}); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(destination, "jdk-21", "legal", "java.compiler", "ADDITIONAL_LICENSE_INFO"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "license" {
		t.Fatalf("symlinked content = %q", content)
	}
}

func TestExtractArchiveRejectsUnsafeSymlink(t *testing.T) {
	for _, linkname := range []string{"../../../outside", "/etc/passwd"} {
		archive := filepath.Join(t.TempDir(), "unsafe.tar.gz")
		writeTarGzipFixture(t, archive, []tarFixtureEntry{
			{name: "jdk-21/legal/link", symlink: linkname},
		})
		err := extractArchive(archive, t.TempDir(), &archiveBudget{remainingBytes: 100, remainingFiles: 10})
		if err == nil || !strings.Contains(err.Error(), "symlink target") {
			t.Fatalf("extractArchive(%q) error = %v", linkname, err)
		}
	}
}

type tarFixtureEntry struct {
	name    string
	content string
	link    string
	symlink string
}

func writeTarGzipFixture(t *testing.T, path string, entries []tarFixtureEntry) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	archive := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: 0o600}
		switch {
		case entry.link != "":
			header.Typeflag = tar.TypeLink
			header.Linkname = entry.link
		case entry.symlink != "":
			header.Typeflag = tar.TypeSymlink
			header.Linkname = entry.symlink
		default:
			header.Typeflag = tar.TypeReg
			header.Size = int64(len(entry.content))
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.link == "" && entry.symlink == "" {
			if _, err := archive.Write([]byte(entry.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeZipFixture(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	for name, content := range entries {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeFixture(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}
