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
	DataDirectory    string
	KeepWorkspace    bool
	Policy           Policy
	ResourcePolicy   ResourcePolicy
	PrepareWorkspace func(string) error
	ProcessStarted   func(ProcessIdentity) error
	LogSink          func(LogChunk) error
}

// ProcessIdentity combines the process-group leader PID with its kernel start
// time. A restarted Agent verifies both values before signalling the group, so
// PID reuse cannot terminate an unrelated process.
type ProcessIdentity struct {
	ProcessID      int    `json:"processId"`
	StartTimeTicks uint64 `json:"startTimeTicks"`
}

type LogChunk struct {
	Stream     string
	Sequence   int64
	Content    string
	RecordedAt time.Time
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
	ResourceLimit string `json:"resourceLimit,omitempty"`
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
		if options.KeepWorkspace && returnErr == nil {
			return
		}
		if cleanupErr := os.RemoveAll(workspace); cleanupErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove attempt workspace: %w", cleanupErr))
		}
	}()
	if options.PrepareWorkspace != nil {
		if err := options.PrepareWorkspace(workspace); err != nil {
			return Result{}, fmt.Errorf("prepare attempt workspace: %w", err)
		}
	}

	workingDirectory, err := prepareWorkingDirectory(workspace, spec.Command.CwdRelative)
	if err != nil {
		return Result{}, err
	}
	resourceScope, err := prepareResourceScope(
		options.ResourcePolicy,
		resourceScopeName(workspace),
		spec.Limits,
	)
	if err != nil {
		return Result{}, err
	}
	defer func() {
		if cleanupErr := resourceScope.close(); cleanupErr != nil {
			returnErr = errors.Join(returnErr, cleanupErr)
		}
	}()
	effectiveCommand := spec.Command
	effectiveEnvironment := commandEnvironment(spec.Environment)
	containerCleanup := func() error { return nil }
	if spec.Isolation == "container" {
		effectiveCommand, effectiveEnvironment, containerCleanup, err = containerCommand(
			spec,
			workspace,
			options.Policy.Container,
		)
		if err != nil {
			return Result{}, err
		}
		workingDirectory = workspace
	}
	defer func() {
		if cleanupErr := containerCleanup(); cleanupErr != nil {
			returnErr = errors.Join(returnErr, cleanupErr)
		}
	}()
	command, handshake, err := resourceCommand(
		effectiveCommand,
		effectiveEnvironment,
		resourceScope,
		spec.Limits,
		options.ResourcePolicy.ApplyRlimits || options.ResourcePolicy.RequireCgroup,
	)
	if err != nil {
		return Result{}, err
	}
	defer handshake.close()
	command.Dir = workingDirectory
	configureProcessGroup(command)

	budget := newLogBudget(spec.Limits.MaxLogBytes)
	stdout := newStreamBuffer("stdout", budget, options.LogSink)
	stderr := newStreamBuffer("stderr", budget, options.LogSink)
	command.Stdout = stdout
	command.Stderr = stderr

	startedAt := time.Now().UTC()
	if err := command.Start(); err != nil {
		return Result{}, fmt.Errorf("start executable %q: %w", effectiveCommand.Executable, err)
	}
	if options.ProcessStarted != nil {
		identity, identityErr := captureProcessIdentity(command.Process.Pid)
		if identityErr == nil {
			identityErr = options.ProcessStarted(identity)
		} else if errors.Is(identityErr, os.ErrNotExist) {
			// The command exited before /proc could be sampled. There is no
			// surviving process group for a future Agent restart to recover.
			identityErr = nil
		}
		if identityErr != nil {
			killProcessGroup(command.Process.Pid)
			resourceScope.forceKill()
			_ = command.Wait()
			return Result{}, errors.Join(
				fmt.Errorf("persist started process identity: %w", identityErr),
				stdout.Close(),
				stderr.Close(),
			)
		}
	}
	if err := handshake.afterStart(); err != nil {
		killProcessGroup(command.Process.Pid)
		resourceScope.forceKill()
		_ = command.Wait()
		return Result{}, errors.Join(err, stdout.Close(), stderr.Close())
	}

	executionContext, cancel := context.WithTimeout(ctx, time.Duration(spec.Limits.TimeoutMs)*time.Millisecond)
	defer cancel()
	processContext, resourceCancel := context.WithCancel(executionContext)
	monitorContext, stopMonitor := context.WithCancel(context.Background())
	resourceViolations := make(chan workspaceViolation, 1)
	if resourceScope != nil {
		go func() {
			violation, exists := <-monitorWorkspace(monitorContext, workspace, spec.Limits)
			if exists {
				resourceViolations <- violation
				resourceScope.forceKill()
				resourceCancel()
			}
		}()
	}
	waitErr, termination := waitForProcess(processContext, command, terminationGracePeriod(spec.Limits), resourceScope)
	stopMonitor()
	resourceCancel()
	finishedAt := time.Now().UTC()
	logErr := errors.Join(stdout.Close(), stderr.Close())
	if logErr != nil {
		return Result{}, fmt.Errorf("persist execution logs: %w", logErr)
	}

	resourceLimit := resourceScope.violation()
	select {
	case violation := <-resourceViolations:
		resourceLimit = violation.resource
	default:
	}
	if resourceLimit == "" {
		resourceLimit = signalResourceViolation(waitErr)
	}
	if resourceLimit != "" {
		termination = "resource_exceeded"
	}
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
		ResourceLimit: resourceLimit,
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

func waitForProcess(ctx context.Context, command *exec.Cmd, gracePeriod time.Duration, resourceScope *resourceScope) (error, string) {
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
			resourceScope.forceKill()
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
