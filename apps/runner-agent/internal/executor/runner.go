package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type RunOptions struct {
	DataDirectory string
	KeepWorkspace bool
	Policy        Policy
}

type Result struct {
	AttemptID     string `json:"attemptId"`
	ExitCode      int    `json:"exitCode"`
	Termination   string `json:"termination"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt"`
	DurationMs    int64  `json:"durationMs"`
	Stdout        string `json:"stdout"`
	Stderr        string `json:"stderr"`
	LogsTruncated bool   `json:"logsTruncated"`
	WorkspacePath string `json:"workspacePath,omitempty"`
}

func Run(ctx context.Context, spec Spec, options RunOptions) (result Result, returnErr error) {
	if err := Validate(spec, options.Policy); err != nil {
		return Result{}, fmt.Errorf("validate execution spec: %w", err)
	}
	if options.DataDirectory == "" {
		return Result{}, errors.New("data directory is required")
	}

	workRoot := filepath.Join(options.DataDirectory, "work")
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return Result{}, fmt.Errorf("prepare work root: %w", err)
	}
	workspace, err := os.MkdirTemp(workRoot, spec.AttemptID+"-")
	if err != nil {
		return Result{}, fmt.Errorf("create attempt workspace: %w", err)
	}
	defer func() {
		if options.KeepWorkspace {
			return
		}
		if cleanupErr := os.RemoveAll(workspace); cleanupErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove attempt workspace: %w", cleanupErr))
		}
	}()

	workingDirectory, err := prepareWorkingDirectory(workspace, spec.Command.CwdRelative)
	if err != nil {
		return Result{}, err
	}
	command := exec.Command(spec.Command.Executable, spec.Command.Args...)
	command.Dir = workingDirectory
	command.Env = commandEnvironment(spec.Environment)
	configureProcessGroup(command)

	budget := newLogBudget(spec.Limits.MaxLogBytes)
	stdout := &boundedBuffer{budget: budget}
	stderr := &boundedBuffer{budget: budget}
	command.Stdout = stdout
	command.Stderr = stderr

	startedAt := time.Now().UTC()
	if err := command.Start(); err != nil {
		return Result{}, fmt.Errorf("start executable %q: %w", spec.Command.Executable, err)
	}

	executionContext, cancel := context.WithTimeout(ctx, time.Duration(spec.Limits.TimeoutMs)*time.Millisecond)
	defer cancel()
	waitErr, termination := waitForProcess(executionContext, command, terminationGracePeriod(spec.Limits))
	finishedAt := time.Now().UTC()

	result = Result{
		AttemptID:     spec.AttemptID,
		ExitCode:      exitCode(command, waitErr),
		Termination:   termination,
		StartedAt:     startedAt.Format(time.RFC3339Nano),
		FinishedAt:    finishedAt.Format(time.RFC3339Nano),
		DurationMs:    finishedAt.Sub(startedAt).Milliseconds(),
		Stdout:        strings.ToValidUTF8(stdout.String(), "�"),
		Stderr:        strings.ToValidUTF8(stderr.String(), "�"),
		LogsTruncated: budget.wasTruncated(),
	}
	if options.KeepWorkspace {
		result.WorkspacePath = workspace
	}
	return result, nil
}

func prepareWorkingDirectory(workspace, relative string) (string, error) {
	if relative == "" {
		return workspace, nil
	}
	if !filepath.IsLocal(relative) {
		return "", errors.New("working directory escapes the attempt workspace")
	}
	workingDirectory := filepath.Join(workspace, relative)
	if err := os.MkdirAll(workingDirectory, 0o700); err != nil {
		return "", fmt.Errorf("prepare command working directory: %w", err)
	}
	return workingDirectory, nil
}

func commandEnvironment(overrides map[string]string) []string {
	values := make(map[string]string)
	for _, name := range []string{"LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"} {
		if value, exists := os.LookupEnv(name); exists {
			values[name] = value
		}
	}
	for name, value := range overrides {
		values[name] = value
	}

	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+values[name])
	}
	return result
}

func waitForProcess(ctx context.Context, command *exec.Cmd, gracePeriod time.Duration) (error, string) {
	wait := make(chan error, 1)
	go func() {
		wait <- command.Wait()
	}()

	select {
	case err := <-wait:
		return err, "completed"
	case <-ctx.Done():
		termination := "cancelled"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			termination = "timeout"
		}
		terminateProcessGroup(command.Process.Pid)
		timer := time.NewTimer(gracePeriod)
		defer timer.Stop()
		select {
		case err := <-wait:
			return err, termination
		case <-timer.C:
			killProcessGroup(command.Process.Pid)
			return <-wait, termination
		}
	}
}

func exitCode(command *exec.Cmd, waitErr error) int {
	if command.ProcessState != nil {
		return command.ProcessState.ExitCode()
	}
	if waitErr == nil {
		return 0
	}
	return -1
}
