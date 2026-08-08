package executor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunCapturesBoundedOutputWithoutShell(t *testing.T) {
	executable := testExecutable(t)
	spec := helperSpec(executable, "output")
	spec.Limits.MaxLogBytes = 8

	result, err := Run(context.Background(), spec, RunOptions{
		DataDirectory: t.TempDir(),
		Policy:        Policy{AllowedExecutables: []string{executable}},
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.ExitCode != 0 || result.Termination != "completed" {
		t.Fatalf("result = %#v", result)
	}
	if !result.LogsTruncated {
		t.Fatal("LogsTruncated = false, want true")
	}
	if len(result.Stdout)+len(result.Stderr) > 8 {
		t.Fatalf("captured %d bytes, want at most 8", len(result.Stdout)+len(result.Stderr))
	}
}

func TestRunTerminatesProcessGroupOnTimeout(t *testing.T) {
	executable := testExecutable(t)
	spec := helperSpec(executable, "sleep")
	spec.Limits.TimeoutMs = 25
	spec.Limits.TerminationGraceMs = 10
	started := time.Now()

	result, err := Run(context.Background(), spec, RunOptions{
		DataDirectory: t.TempDir(),
		Policy:        Policy{AllowedExecutables: []string{executable}},
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Termination != "timeout" {
		t.Fatalf("Termination = %q, want timeout", result.Termination)
	}
	if time.Since(started) > time.Second {
		t.Fatal("timed out helper was not terminated promptly")
	}
}

func TestValidateRejectsShellAndEscapingWorkingDirectory(t *testing.T) {
	testCases := []struct {
		name    string
		command Command
		want    string
	}{
		{
			name:    "shell",
			command: Command{Executable: "/bin/sh"},
			want:    "shell executable",
		},
		{
			name:    "path traversal",
			command: Command{Executable: "/usr/bin/java", CwdRelative: "../outside"},
			want:    "cwdRelative",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			spec := helperSpec(testCase.command.Executable, "output")
			spec.Command = testCase.command
			err := Validate(spec, Policy{AllowedExecutables: []string{testCase.command.Executable}})
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("Validate() error = %v, want containing %q", err, testCase.want)
			}
		})
	}
}

func TestCommandEnvironmentDoesNotInheritAgentSecrets(t *testing.T) {
	t.Setenv("AUTOFORGE_AGENT_BOOTSTRAP_TOKEN", "must-not-leak")
	t.Setenv("PATH", "/trusted/bin")

	environment := commandEnvironment(map[string]string{"TEST_SECRET": "execution-secret"})
	joined := strings.Join(environment, "\n")
	if strings.Contains(joined, "AUTOFORGE_AGENT_BOOTSTRAP_TOKEN") {
		t.Fatal("command environment inherited the Agent bootstrap token")
	}
	if !strings.Contains(joined, "PATH=/trusted/bin") || !strings.Contains(joined, "TEST_SECRET=execution-secret") {
		t.Fatalf("command environment = %q, want safe baseline and explicit execution values", joined)
	}
}

func TestHelperProcess(t *testing.T) {
	if os.Getenv("AUTOFORGE_TEST_HELPER") != "1" {
		return
	}
	mode := ""
	for index, argument := range os.Args {
		if argument == "--" && index+1 < len(os.Args) {
			mode = os.Args[index+1]
			break
		}
	}
	switch mode {
	case "output":
		fmt.Fprint(os.Stdout, "stdout-data")
		fmt.Fprint(os.Stderr, "stderr-data")
	case "sleep":
		time.Sleep(5 * time.Second)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func helperSpec(executable, mode string) Spec {
	return Spec{
		SchemaVersion: SupportedSchemaVersion,
		AttemptID:     "attempt-test-1",
		Command: Command{
			Executable: executable,
			Args:       []string{"-test.run=TestHelperProcess", "--", mode},
		},
		Environment: map[string]string{"AUTOFORGE_TEST_HELPER": "1"},
		Limits: Limits{
			TimeoutMs:   1_000,
			MaxLogBytes: 1_024,
		},
	}
}

func testExecutable(t *testing.T) string {
	t.Helper()
	absolute, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatalf("filepath.Abs(os.Args[0]): %v", err)
	}
	return absolute
}
