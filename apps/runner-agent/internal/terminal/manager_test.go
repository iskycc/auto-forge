package terminal

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestManagerRunsInteractiveShellAndCleansWorkDirectory(t *testing.T) {
	workDirectory := t.TempDir()
	manager := NewManager(context.Background(), Configuration{
		Shell:           "/bin/sh",
		WorkDirectory:   workDirectory,
		MaxSessions:     1,
		MaximumDuration: time.Minute,
	})
	var output bytes.Buffer
	var outputMu sync.Mutex
	exited := make(chan Exit, 1)
	err := manager.Open("session-1", 100, 30, Events{
		Output: func(chunk []byte) error {
			outputMu.Lock()
			defer outputMu.Unlock()
			_, writeErr := output.Write(chunk)
			return writeErr
		},
		Exited: func(result Exit) { exited <- result },
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if err := manager.Input("session-1", []byte("printf 'terminal-ready\\n'\nexit\n")); err != nil {
		t.Fatalf("Input() error = %v", err)
	}
	select {
	case result := <-exited:
		if result.Code == nil || *result.Code != 0 {
			t.Fatalf("exit result = %#v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("terminal session did not exit")
	}
	outputMu.Lock()
	defer outputMu.Unlock()
	if !bytes.Contains(output.Bytes(), []byte("terminal-ready")) {
		t.Fatalf("output = %q", output.String())
	}
}

func TestManagerEnforcesSessionLimit(t *testing.T) {
	manager := NewManager(context.Background(), Configuration{
		Shell:           "/bin/sh",
		WorkDirectory:   t.TempDir(),
		MaxSessions:     1,
		MaximumDuration: time.Minute,
	})
	events := Events{Output: func([]byte) error { return nil }, Exited: func(Exit) {}}
	if err := manager.Open("session-1", 80, 24, events); err != nil {
		t.Fatalf("first Open() error = %v", err)
	}
	defer manager.CloseAll()
	if err := manager.Open("session-2", 80, 24, events); err == nil {
		t.Fatal("second Open() error = nil, want session limit error")
	}
}

func TestManagerCloseTerminatesBackgroundProcessGroups(t *testing.T) {
	workDirectory := t.TempDir()
	manager := NewManager(context.Background(), Configuration{
		Shell:           "/bin/sh",
		WorkDirectory:   workDirectory,
		MaxSessions:     1,
		MaximumDuration: time.Minute,
	})
	exited := make(chan Exit, 1)
	if err := manager.Open("background-session", 80, 24, Events{
		Output: func([]byte) error { return nil },
		Exited: func(result Exit) { exited <- result },
	}); err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	childPIDPath := filepath.Join(workDirectory, "background-session", "child.pid")
	if err := manager.Input(
		"background-session",
		[]byte("sh -c 'trap \"\" TERM; while :; do sleep 1; done' & printf '%s' \"$!\" > child.pid\n"),
	); err != nil {
		t.Fatalf("Input() error = %v", err)
	}

	childPID := waitForChildPID(t, childPIDPath)
	manager.Close("background-session")
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal shell did not exit after Close()")
	}
	waitForProcessExit(t, childPID)
}

func waitForChildPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		content, err := os.ReadFile(path)
		if err == nil {
			processID, parseErr := strconv.Atoi(strings.TrimSpace(string(content)))
			if parseErr == nil && processID > 0 {
				return processID
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("background process ID was not written")
	return 0
}

func waitForProcessExit(t *testing.T, processID int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(processID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("background process %d remained alive", processID)
}
