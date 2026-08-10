package executor

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"time"
)

const workspaceInspectionInterval = 100 * time.Millisecond

type workspaceViolation struct {
	resource string
	err      error
}

func monitorWorkspace(ctx context.Context, workspace string, limits Limits) <-chan workspaceViolation {
	violations := make(chan workspaceViolation, 1)
	go func() {
		defer close(violations)
		ticker := time.NewTicker(workspaceInspectionInterval)
		defer ticker.Stop()
		for {
			usage, err := inspectWorkspace(workspace)
			if err != nil {
				violations <- workspaceViolation{resource: "monitor", err: err}
				return
			}
			if usage.bytes > limits.DiskBytes {
				violations <- workspaceViolation{resource: "disk", err: fmt.Errorf("workspace uses %d bytes, limit is %d", usage.bytes, limits.DiskBytes)}
				return
			}
			if usage.entries > limits.FileCount {
				violations <- workspaceViolation{resource: "files", err: fmt.Errorf("workspace contains %d entries, limit is %d", usage.entries, limits.FileCount)}
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return violations
}

type workspaceUsage struct {
	bytes   int64
	entries int64
}

func inspectWorkspace(workspace string) (workspaceUsage, error) {
	usage := workspaceUsage{}
	err := filepath.WalkDir(workspace, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if path == workspace {
			return nil
		}
		usage.entries++
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if info.Size() > 0 && usage.bytes > int64(^uint64(0)>>1)-info.Size() {
			return errors.New("workspace size overflow")
		}
		usage.bytes += info.Size()
		return nil
	})
	if err != nil {
		return workspaceUsage{}, fmt.Errorf("inspect attempt workspace: %w", err)
	}
	return usage, nil
}
