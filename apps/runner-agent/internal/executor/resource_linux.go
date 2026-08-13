//go:build linux

package executor

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	resourceWrapperArgument = "__autoforge_resource_exec"
	resourceReadyFD         = 3
	resourceStartFD         = 4
	resourceSetupTimeout    = 5 * time.Second
	cpuPeriodMicros         = int64(1_000_000)
)

var ErrResourceIsolationUnavailable = errors.New("resource isolation unavailable")
var cgroupInitialization sync.Mutex

type ResourcePolicy struct {
	CgroupRoot    string
	RequireCgroup bool
}

type resourceScope struct {
	path string
}

type resourceHandshake struct {
	readyRead  *os.File
	readyWrite *os.File
	startRead  *os.File
	startWrite *os.File
}

func resourceScopeName(workspace string) string {
	digest := sha256.Sum256([]byte(filepath.Base(workspace)))
	return "attempt-" + hex.EncodeToString(digest[:12])
}

func prepareResourceScope(policy ResourcePolicy, scopeName string, limits Limits) (*resourceScope, error) {
	if !policy.RequireCgroup {
		return nil, nil
	}
	if policy.CgroupRoot == "" || !filepath.IsAbs(policy.CgroupRoot) {
		return nil, fmt.Errorf("%w: an absolute delegated cgroup v2 root is required", ErrResourceIsolationUnavailable)
	}
	if !completeResourceLimits(limits) {
		return nil, fmt.Errorf("%w: the execution specification has incomplete resource limits", ErrResourceIsolationUnavailable)
	}
	controllers, err := os.ReadFile(filepath.Join(policy.CgroupRoot, "cgroup.controllers"))
	if err != nil {
		return nil, fmt.Errorf("%w: read delegated controllers: %v", ErrResourceIsolationUnavailable, err)
	}
	for _, required := range []string{"cpu", "memory", "pids"} {
		if !hasController(controllers, required) {
			return nil, fmt.Errorf("%w: delegated cgroup does not expose %s", ErrResourceIsolationUnavailable, required)
		}
	}
	if err := initializeDelegatedCgroup(policy.CgroupRoot); err != nil {
		return nil, fmt.Errorf("%w: initialize delegated cgroup: %v", ErrResourceIsolationUnavailable, err)
	}
	if !attemptIDPattern.MatchString(scopeName) {
		return nil, fmt.Errorf("%w: invalid cgroup scope name", ErrResourceIsolationUnavailable)
	}
	scope := &resourceScope{path: filepath.Join(policy.CgroupRoot, scopeName)}
	if err := os.Mkdir(scope.path, 0o700); err != nil {
		return nil, fmt.Errorf("%w: create attempt cgroup: %v", ErrResourceIsolationUnavailable, err)
	}
	configured := false
	defer func() {
		if !configured {
			_ = os.Remove(scope.path)
		}
	}()
	controls := []struct {
		name  string
		value string
	}{
		{name: "cpu.max", value: cpuMaximum(limits.CPUMillicores)},
		{name: "memory.max", value: strconv.FormatInt(limits.MemoryBytes, 10)},
		{name: "memory.swap.max", value: "0"},
		{name: "memory.oom.group", value: "1"},
		{name: "pids.max", value: strconv.FormatInt(limits.ProcessCount, 10)},
	}
	for _, control := range controls {
		if err := writeControl(scope.path, control.name, control.value); err != nil {
			return nil, fmt.Errorf("%w: configure %s: %v", ErrResourceIsolationUnavailable, control.name, err)
		}
	}
	configured = true
	return scope, nil
}

func hasController(controllers []byte, required string) bool {
	for _, controller := range strings.Fields(string(controllers)) {
		if controller == required {
			return true
		}
	}
	return false
}

func initializeDelegatedCgroup(root string) error {
	cgroupInitialization.Lock()
	defer cgroupInitialization.Unlock()
	agentLeaf := filepath.Join(root, ".autoforge-agent")
	if err := os.Mkdir(agentLeaf, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create Agent leaf cgroup: %w", err)
	}
	if err := writeControl(agentLeaf, "cgroup.procs", strconv.Itoa(os.Getpid())); err != nil {
		return fmt.Errorf("move Agent into leaf cgroup: %w", err)
	}
	if err := writeControl(root, "cgroup.subtree_control", "+cpu +memory +pids"); err != nil {
		return fmt.Errorf("enable delegated controllers: %w", err)
	}
	return nil
}

func completeResourceLimits(limits Limits) bool {
	return limits.CPUMillicores > 0 && limits.MemoryBytes > 0 && limits.DiskBytes > 0 && limits.ProcessCount > 0 && limits.FileCount > 0
}

func cpuMaximum(millicores int64) string {
	quota := millicores * cpuPeriodMicros / 1_000
	if quota < 1_000 {
		quota = 1_000
	}
	return fmt.Sprintf("%d %d", quota, cpuPeriodMicros)
}

func writeControl(directory, name, value string) error {
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(file, value); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func (scope *resourceScope) forceKill() {
	if scope == nil {
		return
	}
	if err := writeControl(scope.path, "cgroup.kill", "1"); err == nil {
		return
	}
	for attempt := 0; attempt < 10; attempt++ {
		content, err := os.ReadFile(filepath.Join(scope.path, "cgroup.procs"))
		if err != nil || len(strings.TrimSpace(string(content))) == 0 {
			return
		}
		for _, line := range strings.Fields(string(content)) {
			processID, parseErr := strconv.Atoi(line)
			if parseErr == nil {
				_ = syscall.Kill(processID, syscall.SIGKILL)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (scope *resourceScope) close() error {
	if scope == nil {
		return nil
	}
	scope.forceKill()
	for attempt := 0; attempt < 20; attempt++ {
		if err := os.Remove(scope.path); err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("remove attempt cgroup %s", scope.path)
}

func (scope *resourceScope) violation() string {
	if scope == nil {
		return ""
	}
	if eventCount(scope.path, "memory.events", "oom_kill") > 0 {
		return "memory"
	}
	if eventCount(scope.path, "pids.events", "max") > 0 {
		return "processes"
	}
	return ""
}

func eventCount(directory, fileName, eventName string) int64 {
	content, err := os.ReadFile(filepath.Join(directory, fileName))
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(content))
	for index := 0; index+1 < len(fields); index += 2 {
		if fields[index] == eventName {
			value, _ := strconv.ParseInt(fields[index+1], 10, 64)
			return value
		}
	}
	return 0
}

func resourceCommand(target Command, environment []string, scope *resourceScope, limits Limits) (*exec.Cmd, *resourceHandshake, error) {
	if scope == nil {
		command := exec.Command(target.Executable, target.Args...)
		command.Env = environment
		return command, nil, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, fmt.Errorf("%w: locate Agent executable: %v", ErrResourceIsolationUnavailable, err)
	}
	readyRead, readyWrite, err := os.Pipe()
	if err != nil {
		return nil, nil, fmt.Errorf("create resource ready pipe: %w", err)
	}
	startRead, startWrite, err := os.Pipe()
	if err != nil {
		readyRead.Close()
		readyWrite.Close()
		return nil, nil, fmt.Errorf("create resource start pipe: %w", err)
	}
	arguments := []string{
		resourceWrapperArgument,
		scope.path,
		strconv.FormatInt(limits.FileCount, 10),
		strconv.FormatInt(limits.DiskBytes, 10),
		target.Executable,
	}
	arguments = append(arguments, target.Args...)
	command := exec.Command(executable, arguments...)
	command.Env = environment
	command.ExtraFiles = []*os.File{readyWrite, startRead}
	return command, &resourceHandshake{
		readyRead: readyRead, readyWrite: readyWrite, startRead: startRead, startWrite: startWrite,
	}, nil
}

func (handshake *resourceHandshake) afterStart() error {
	if handshake == nil {
		return nil
	}
	handshake.readyWrite.Close()
	handshake.startRead.Close()
	ready := make(chan error, 1)
	go func() {
		buffer := []byte{0}
		_, err := io.ReadFull(handshake.readyRead, buffer)
		if err == nil && buffer[0] != 1 {
			err = errors.New("resource wrapper returned an invalid readiness marker")
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			return fmt.Errorf("%w: resource wrapper stopped before setup completed: %v", ErrResourceIsolationUnavailable, err)
		}
	case <-time.After(resourceSetupTimeout):
		return fmt.Errorf("%w: resource wrapper setup timed out", ErrResourceIsolationUnavailable)
	}
	if _, err := handshake.startWrite.Write([]byte{1}); err != nil {
		return fmt.Errorf("%w: release resource wrapper: %v", ErrResourceIsolationUnavailable, err)
	}
	return nil
}

func (handshake *resourceHandshake) close() {
	if handshake == nil {
		return
	}
	for _, file := range []*os.File{handshake.readyRead, handshake.readyWrite, handshake.startRead, handshake.startWrite} {
		_ = file.Close()
	}
}

func IsResourceWrapper(arguments []string) bool {
	return len(arguments) > 0 && arguments[0] == resourceWrapperArgument
}

func RunResourceWrapper(arguments []string) error {
	if len(arguments) < 5 || arguments[0] != resourceWrapperArgument {
		return errors.New("invalid internal resource wrapper arguments")
	}
	fileCount, err := strconv.ParseUint(arguments[2], 10, 64)
	if err != nil || fileCount == 0 {
		return errors.New("invalid internal open-file limit")
	}
	diskBytes, err := strconv.ParseUint(arguments[3], 10, 64)
	if err != nil || diskBytes == 0 {
		return errors.New("invalid internal file-size limit")
	}
	if err := lowerRlimit(syscall.RLIMIT_NOFILE, fileCount); err != nil {
		return fmt.Errorf("set open-file limit: %w", err)
	}
	if err := lowerRlimit(syscall.RLIMIT_FSIZE, diskBytes); err != nil {
		return fmt.Errorf("set file-size limit: %w", err)
	}
	if err := lowerRlimit(syscall.RLIMIT_CORE, 0); err != nil {
		return fmt.Errorf("disable core dumps: %w", err)
	}
	if err := writeControl(arguments[1], "cgroup.procs", strconv.Itoa(os.Getpid())); err != nil {
		return fmt.Errorf("attach process to attempt cgroup: %w", err)
	}
	ready := os.NewFile(resourceReadyFD, "resource-ready")
	start := os.NewFile(resourceStartFD, "resource-start")
	if ready == nil || start == nil {
		return errors.New("resource wrapper handshake descriptors are unavailable")
	}
	if _, err := ready.Write([]byte{1}); err != nil {
		return fmt.Errorf("report resource readiness: %w", err)
	}
	_ = ready.Close()
	marker := []byte{0}
	if _, err := io.ReadFull(start, marker); err != nil || marker[0] != 1 {
		return errors.New("resource wrapper did not receive a valid start marker")
	}
	_ = start.Close()
	target := arguments[4]
	return syscall.Exec(target, append([]string{target}, arguments[5:]...), os.Environ())
}

func lowerRlimit(resource int, requested uint64) error {
	var current syscall.Rlimit
	if err := syscall.Getrlimit(resource, &current); err != nil {
		return err
	}
	if requested > current.Max {
		requested = current.Max
	}
	current.Cur = requested
	current.Max = requested
	return syscall.Setrlimit(resource, &current)
}

func signalResourceViolation(waitErr error) string {
	var exitError *exec.ExitError
	if !errors.As(waitErr, &exitError) {
		return ""
	}
	status, ok := exitError.Sys().(syscall.WaitStatus)
	if ok && status.Signaled() && status.Signal() == syscall.SIGXFSZ {
		return "disk"
	}
	return ""
}
