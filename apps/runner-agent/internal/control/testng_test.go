package control

import (
	"path/filepath"
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

	mapped, input, err := testNGExecutorSpec(specification, toolchain)
	if err != nil {
		t.Fatalf("testNGExecutorSpec() error = %v", err)
	}
	if mapped.Command.Executable != toolchain.JavaExecutable {
		t.Fatalf("Executable = %q", mapped.Command.Executable)
	}
	wantClasspath := filepath.Join("inputs", "tests.jar") + string(filepath.ListSeparator) + "/opt/testng/testng.jar" + string(filepath.ListSeparator) + "/opt/testng/jcommander.jar"
	if len(mapped.Command.Args) < 2 || mapped.Command.Args[0] != "-cp" || mapped.Command.Args[1] != wantClasspath {
		t.Fatalf("Args = %#v, want classpath %q", mapped.Command.Args, wantClasspath)
	}
	if input.InputID != "source-1" {
		t.Fatalf("InputID = %q", input.InputID)
	}
}

func TestTestNGExecutorSpecRejectsUnsupportedMethodDescriptorSelection(t *testing.T) {
	specification := testExecutionSpec()
	specification.MethodDescriptors = []string{"()V"}
	_, _, err := testNGExecutorSpec(specification, config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21",
		TestNGVersion:  "7.11.0",
	})
	if err == nil {
		t.Fatal("testNGExecutorSpec() accepted unsupported method selection")
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
		Inputs: []ExecutionInput{{
			InputID: "source-1", Kind: "test-jar", TargetPath: "inputs/tests.jar",
			MediaType: "application/java-archive", SizeBytes: 3, SHA256: "abc",
		}},
		TimeoutMs:      60_000,
		ResourceLimits: ResourceLimits{DiskBytes: 1 << 20, LogBytes: 1 << 20},
	}
}
