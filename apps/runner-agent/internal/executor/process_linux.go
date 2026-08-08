//go:build linux

package executor

import (
	"os/exec"
	"syscall"
)

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcessGroup(processID int) {
	_ = syscall.Kill(-processID, syscall.SIGTERM)
}

func killProcessGroup(processID int) {
	_ = syscall.Kill(-processID, syscall.SIGKILL)
}
