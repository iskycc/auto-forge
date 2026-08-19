package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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

func TestRunPersistsAndSafelyKillsRecoveredProcessGroup(t *testing.T) {
	executable := testExecutable(t)
	spec := helperSpec(executable, "sleep")
	var captured ProcessIdentity
	result, err := Run(context.Background(), spec, RunOptions{
		DataDirectory: t.TempDir(),
		Policy:        Policy{AllowedExecutables: []string{executable}},
		ProcessStarted: func(identity ProcessIdentity) error {
			captured = identity
			wrongIdentity := identity
			wrongIdentity.StartTimeTicks++
			if killed, killErr := KillPersistedProcessGroup(wrongIdentity); killErr != nil || killed {
				return fmt.Errorf("PID reuse guard result = (%v, %v), want (false, nil)", killed, killErr)
			}
			if killed, killErr := KillPersistedProcessGroup(identity); killErr != nil || !killed {
				return fmt.Errorf("recovered process kill result = (%v, %v), want (true, nil)", killed, killErr)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if captured.ProcessID <= 0 || captured.StartTimeTicks == 0 {
		t.Fatalf("captured process identity = %#v", captured)
	}
	if result.ExitCode == 0 {
		t.Fatalf("killed process result = %#v, want non-zero exit", result)
	}
}

func TestRunTreatsShellMetacharactersAsLiteralArguments(t *testing.T) {
	executable := testExecutable(t)
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	spec := helperSpec(executable, "argument")
	spec.Command.Args = append(spec.Command.Args, "; touch "+marker)

	result, err := Run(context.Background(), spec, RunOptions{
		DataDirectory: t.TempDir(),
		Policy:        Policy{AllowedExecutables: []string{executable}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Stdout, "; touch "+marker) {
		t.Fatalf("literal argument was not preserved: %q", result.Stdout)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("shell metacharacters created marker file: %v", err)
	}
}

func TestRunTerminatesDescendantProcessTreeOnTimeout(t *testing.T) {
	executable := testExecutable(t)
	pidPath := filepath.Join(t.TempDir(), "descendant.pid")
	spec := helperSpec(executable, "tree")
	spec.Command.Args = append(spec.Command.Args, pidPath)
	spec.Limits.TimeoutMs = 100
	spec.Limits.TerminationGraceMs = 10

	result, err := Run(context.Background(), spec, RunOptions{
		DataDirectory: t.TempDir(),
		Policy:        Policy{AllowedExecutables: []string{executable}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Termination != "timeout" {
		t.Fatalf("termination = %q, want timeout", result.Termination)
	}
	payload, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read descendant pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(payload)))
	if err != nil {
		t.Fatalf("parse descendant pid: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for processExists(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if processExists(pid) {
		t.Fatalf("descendant process %d survived timeout cleanup", pid)
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
	case "argument":
		fmt.Fprint(os.Stdout, os.Args[len(os.Args)-1])
	case "tree":
		pidPath := os.Args[len(os.Args)-1]
		child := exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--", "leaf")
		child.Env = append(os.Environ(), "AUTOFORGE_TEST_HELPER=1")
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			os.Exit(4)
		}
		time.Sleep(5 * time.Second)
	case "leaf":
		time.Sleep(5 * time.Second)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}

func processExists(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
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
			TimeoutMs:   5_000,
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
