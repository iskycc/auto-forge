//go:build linux

package executor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMain(testingMain *testing.M) {
	if IsResourceWrapper(os.Args[1:]) {
		if err := RunResourceWrapper(os.Args[1:]); err != nil {
			os.Exit(125)
		}
		os.Exit(0)
	}
	os.Exit(testingMain.Run())
}

func TestResourceWrapperAppliesLimitsBeforeExec(t *testing.T) {
	cgroup := t.TempDir()
	if err := os.WriteFile(filepath.Join(cgroup, "cgroup.procs"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	scope := &resourceScope{path: cgroup}
	command, handshake, err := resourceCommand(
		Command{Executable: "/bin/true"},
		[]string{"PATH=/usr/bin:/bin"},
		scope,
		Limits{FileCount: 64, DiskBytes: 1 << 20},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer handshake.close()
	configureProcessGroup(command)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	processID := command.Process.Pid
	if err := handshake.afterStart(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	attached, err := os.ReadFile(filepath.Join(cgroup, "cgroup.procs"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(attached)) != strconv.Itoa(processID) {
		t.Fatalf("cgroup.procs = %q, want process %d", attached, processID)
	}
}

func TestPrepareResourceScopeFailsClosedWithoutDelegatedControls(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "cgroup.controllers"), []byte("cpu memory pids\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := prepareResourceScope(ResourcePolicy{CgroupRoot: root, RequireCgroup: true}, "attempt-test", Limits{
		CPUMillicores: 1_000,
		MemoryBytes:   256 << 20,
		DiskBytes:     1 << 20,
		ProcessCount:  32,
		FileCount:     128,
	})
	if !errors.Is(err, ErrResourceIsolationUnavailable) {
		t.Fatalf("prepareResourceScope() error = %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "attempt-test")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed cgroup was not cleaned: %v", statErr)
	}
}

func TestMonitorWorkspaceReportsAggregateByteAndEntryLimits(t *testing.T) {
	for name, limits := range map[string]Limits{
		"disk":  {DiskBytes: 3, FileCount: 10},
		"files": {DiskBytes: 100, FileCount: 1},
	} {
		t.Run(name, func(t *testing.T) {
			workspace := t.TempDir()
			if err := os.WriteFile(filepath.Join(workspace, "one.txt"), []byte("1234"), 0o600); err != nil {
				t.Fatal(err)
			}
			if name == "files" {
				if err := os.WriteFile(filepath.Join(workspace, "two.txt"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			violation, exists := <-monitorWorkspace(ctx, workspace, limits)
			if !exists || violation.resource != name {
				t.Fatalf("workspace violation = %#v, exists = %t", violation, exists)
			}
		})
	}
}

func TestResourceScopeReadsKernelViolationCounters(t *testing.T) {
	for name, fixture := range map[string]struct {
		file    string
		content string
	}{
		"memory":    {file: "memory.events", content: "low 0\noom_kill 1\n"},
		"processes": {file: "pids.events", content: "max 2\n"},
	} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, fixture.file), []byte(fixture.content), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := (&resourceScope{path: directory}).violation(); got != name {
				t.Fatalf("violation() = %q, want %q", got, name)
			}
		})
	}
}

func TestSignalResourceViolationRecognizesFileSizeSignal(t *testing.T) {
	command := exec.Command("/bin/sleep", "5")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(command.Process.Pid, syscall.SIGXFSZ); err != nil {
		t.Fatal(err)
	}
	err := command.Wait()
	if got := signalResourceViolation(err); got != "disk" {
		t.Fatalf("signalResourceViolation() = %q", got)
	}
}

func TestCPUMaximumUsesCgroupV2QuotaFormat(t *testing.T) {
	if got := cpuMaximum(2_000); got != "2000000 1000000" {
		t.Fatalf("cpuMaximum() = %q", got)
	}
	if got := cpuMaximum(1); got != "1000 1000000" {
		t.Fatalf("minimum cpuMaximum() = %q", got)
	}
}
