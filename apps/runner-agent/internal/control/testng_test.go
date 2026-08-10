package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

func TestTestNGExecutorSpecUsesArgumentArrayAndOfflineClasspath(t *testing.T) {
	toolchain := config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar", "/opt/testng/jcommander.jar"},
		JavaVersion:    "21.0.8",
		TestNGVersion:  "7.11.0",
	}
	specification := testExecutionSpec()
	specification.Inputs = append(specification.Inputs, ExecutionInput{
		InputID: "dependency-1", Kind: "dependency-jar", TargetPath: "inputs/lib/support.jar",
		MediaType: "application/java-archive", SizeBytes: 5, SHA256: strings.Repeat("b", 64),
	})

	mapped, inputs, err := testNGExecutorSpec(specification, toolchain)
	if err != nil {
		t.Fatalf("testNGExecutorSpec() error = %v", err)
	}
	if mapped.Command.Executable != toolchain.JavaExecutable {
		t.Fatalf("Executable = %q", mapped.Command.Executable)
	}
	wantClasspath := filepath.Join("inputs", "tests.jar") + string(filepath.ListSeparator) + filepath.Join("inputs", "lib", "support.jar") + string(filepath.ListSeparator) + "/opt/testng/testng.jar" + string(filepath.ListSeparator) + "/opt/testng/jcommander.jar"
	if len(mapped.Command.Args) < 2 || mapped.Command.Args[0] != "-cp" || mapped.Command.Args[1] != wantClasspath {
		t.Fatalf("Args = %#v, want classpath %q", mapped.Command.Args, wantClasspath)
	}
	if len(inputs) != 2 || inputs[0].InputID != "source-1" || inputs[1].InputID != "dependency-1" {
		t.Fatalf("Inputs = %#v", inputs)
	}
}

func TestTestNGExecutorSpecRejectsMissingOrDuplicateTestJAR(t *testing.T) {
	toolchain := config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21",
		TestNGVersion:  "7.11.0",
	}
	for name, inputs := range map[string][]ExecutionInput{
		"missing": {{
			InputID: "dependency-1", Kind: "dependency-jar", TargetPath: "inputs/dependency.jar",
		}},
		"duplicate": {
			{InputID: "source-1", Kind: "test-jar", TargetPath: "inputs/tests.jar"},
			{InputID: "source-2", Kind: "test-jar", TargetPath: "inputs/tests-2.jar"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			specification := testExecutionSpec()
			specification.Inputs = inputs
			if _, _, err := testNGExecutorSpec(specification, toolchain); err == nil {
				t.Fatal("testNGExecutorSpec() accepted an invalid test JAR set")
			}
		})
	}
}

func TestTestNGExecutorSpecUsesExactJVMMethodSelectors(t *testing.T) {
	specification := testExecutionSpec()
	specification.MethodDescriptors = []string{
		"smoke()V",
		"smoke(Ljava/lang/String;[I)Z",
	}
	specification.Parameters = map[string]string{"browser": "chromium", "region": "offline=west"}
	mapped, _, err := testNGExecutorSpec(specification, config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21",
		TestNGVersion:  "7.11.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	arguments := strings.Join(mapped.Command.Args, " ")
	for _, expected := range []string{
		testNGLauncherRelativePath,
		"--method smoke()V",
		"--method smoke(Ljava/lang/String;[I)Z",
		"--parameter browser=chromium",
		"--parameter region=offline=west",
	} {
		if !strings.Contains(arguments, expected) {
			t.Fatalf("launcher arguments %q do not contain %q", arguments, expected)
		}
	}
	workspace := t.TempDir()
	if err := prepareTestNGLauncher(workspace, specification.MethodDescriptors, specification.Parameters); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(workspace, filepath.FromSlash(testNGLauncherRelativePath))
	info, err := os.Stat(launcher)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("launcher permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestTestNGExecutorSpecRejectsInvalidMethodSelector(t *testing.T) {
	specification := testExecutionSpec()
	specification.MethodDescriptors = []string{"()V"}
	_, _, err := testNGExecutorSpec(specification, config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21",
		TestNGVersion:  "7.11.0",
	})
	if err == nil {
		t.Fatal("testNGExecutorSpec() accepted an invalid method selector")
	}
}

func TestStructuredTestNGResultUsesProtocolFieldNames(t *testing.T) {
	payload, err := json.Marshal(testNGResultSummary{
		testNGResultCounts: testNGResultCounts{Total: 1, Passed: 1},
		Suites: []testNGSuiteResult{{
			testNGResultCounts: testNGResultCounts{Total: 1, Passed: 1},
			Name:               "suite",
			Tests:              []testNGTestResult{},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	jsonText := string(payload)
	for _, expected := range []string{`"total":1`, `"passed":1`, `"detailsTruncated":false`, `"suites"`} {
		if !strings.Contains(jsonText, expected) {
			t.Fatalf("structured TestNG JSON %s does not contain %s", jsonText, expected)
		}
	}
}

func testExecutionSpec() ExecutionSpec {
	return ExecutionSpec{
		SchemaVersion:  protocolVersion,
		Executor:       "testng",
		AttemptID:      "attempt-1",
		ExecutionRunID: "run-1",
		BatchID:        "batch-1",
		ClassName:      "com.example.SmokeTest",
		RuntimeRequirements: RuntimeRequirements{
			OS: "linux", Architectures: []string{"amd64", "arm64"},
			MinimumJavaMajorVersion: 11, TestNGVersion: "7.11.0",
		},
		Inputs: []ExecutionInput{{
			InputID: "source-1", Kind: "test-jar", TargetPath: "inputs/tests.jar",
			MediaType: "application/java-archive", SizeBytes: 3, SHA256: "abc",
		}},
		TimeoutMs:       60_000,
		UploadTimeoutMs: 10_000,
		ResourceLimits:  ResourceLimits{DiskBytes: 1 << 20, LogBytes: 1 << 20},
	}
}
