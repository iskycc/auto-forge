//go:build linux

package terminal

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func signalTerminalSession(sessionID int, signal syscall.Signal) {
	processIDs := terminalSessionProcessIDs(sessionID)
	for _, processID := range processIDs {
		if processID != sessionID {
			_ = syscall.Kill(processID, signal)
		}
	}
	_ = syscall.Kill(sessionID, signal)
}

func terminalSessionProcessIDs(sessionID int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	processIDs := make([]int, 0)
	for _, entry := range entries {
		processID, err := strconv.Atoi(entry.Name())
		if err != nil || processID <= 0 {
			continue
		}
		stat, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		observedSessionID, ok := processSessionID(stat)
		if ok && observedSessionID == sessionID {
			processIDs = append(processIDs, processID)
		}
	}
	return processIDs
}

func processSessionID(stat []byte) (int, bool) {
	commandEnd := bytes.LastIndexByte(stat, ')')
	if commandEnd < 0 || commandEnd+1 >= len(stat) {
		return 0, false
	}
	fields := strings.Fields(string(stat[commandEnd+1:]))
	if len(fields) < 4 {
		return 0, false
	}
	sessionID, err := strconv.Atoi(fields[3])
	return sessionID, err == nil && sessionID > 0
}
