package control

import (
	"archive/zip"
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
