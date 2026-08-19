//go:build linux

package executor

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const recoveredProcessExitTimeout = 5 * time.Second

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcessGroup(processID int) {
	_ = syscall.Kill(-processID, syscall.SIGTERM)
}

func killProcessGroup(processID int) {
	_ = syscall.Kill(-processID, syscall.SIGKILL)
}

// KillPersistedProcessGroup kills only the process group whose leader still
// has the persisted kernel start time. The start-time check protects unrelated
// processes if Linux reused a PID while the Agent was stopped.
func KillPersistedProcessGroup(identity ProcessIdentity) (bool, error) {
	if identity.ProcessID <= 0 || identity.StartTimeTicks == 0 {
		return false, errors.New("persisted process identity is invalid")
	}
	current, err := captureProcessIdentity(identity.ProcessID)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect persisted process %d: %w", identity.ProcessID, err)
	}
	if current.StartTimeTicks != identity.StartTimeTicks {
		return false, nil
	}
	if err := syscall.Kill(-identity.ProcessID, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return false, nil
		}
		return false, fmt.Errorf("kill persisted process group %d: %w", identity.ProcessID, err)
	}
	deadline := time.Now().Add(recoveredProcessExitTimeout)
	for time.Now().Before(deadline) {
		observed, state, inspectErr := readProcessStat(identity.ProcessID)
		if errors.Is(inspectErr, os.ErrNotExist) {
			return true, nil
		}
		if inspectErr != nil {
			return true, fmt.Errorf("verify persisted process group %d exit: %w", identity.ProcessID, inspectErr)
		}
		if observed.StartTimeTicks != identity.StartTimeTicks {
			return true, nil
		}
		// A zombie cannot write or create workspace files. SIGKILL was sent to
		// the whole group, so descendants have received the same terminal signal.
		if state == "Z" || state == "X" {
			return true, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true, fmt.Errorf("persisted process group %d did not exit after SIGKILL", identity.ProcessID)
}

func captureProcessIdentity(processID int) (ProcessIdentity, error) {
	identity, _, err := readProcessStat(processID)
	return identity, err
}

func readProcessStat(processID int) (ProcessIdentity, string, error) {
	payload, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", processID))
	if err != nil {
		return ProcessIdentity{}, "", err
	}
	commandEnd := bytes.LastIndexByte(payload, ')')
	if commandEnd < 0 || commandEnd+1 >= len(payload) {
		return ProcessIdentity{}, "", errors.New("process stat is malformed")
	}
	// /proc/<pid>/stat fields after comm start with field 3 (state); starttime
	// is field 22 and therefore index 19 in this suffix.
	fields := strings.Fields(string(payload[commandEnd+1:]))
	if len(fields) <= 19 {
		return ProcessIdentity{}, "", errors.New("process stat omits start time")
	}
	startTimeTicks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || startTimeTicks == 0 {
		return ProcessIdentity{}, "", errors.New("process stat has invalid start time")
	}
	return ProcessIdentity{ProcessID: processID, StartTimeTicks: startTimeTicks}, fields[0], nil
}
