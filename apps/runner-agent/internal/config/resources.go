package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const cgroupFilesystemRoot = "/sys/fs/cgroup"

func resourceConfig(lookup LookupEnvironment) (ResourceConfig, error) {
	raw := environmentValue(lookup, "AUTOFORGE_AGENT_CGROUP_ROOT")
	if raw == "" {
		return ResourceConfig{}, nil
	}
	if raw == "auto" {
		resolved, err := currentCgroupRoot()
		if err != nil {
			return ResourceConfig{}, fmt.Errorf("AUTOFORGE_AGENT_CGROUP_ROOT auto-discovery failed: %w", err)
		}
		return ResourceConfig{CgroupRoot: resolved}, nil
	}
	cleaned := filepath.Clean(raw)
	if !filepath.IsAbs(cleaned) || !pathInside(cgroupFilesystemRoot, cleaned) {
		return ResourceConfig{}, errors.New("AUTOFORGE_AGENT_CGROUP_ROOT must be auto or an absolute path below /sys/fs/cgroup")
	}
	return ResourceConfig{CgroupRoot: cleaned}, nil
}

func currentCgroupRoot() (string, error) {
	file, err := os.Open("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4_096), 64<<10)
	for scanner.Scan() {
		fields := strings.SplitN(scanner.Text(), ":", 3)
		if len(fields) == 3 && fields[0] == "0" && fields[1] == "" && strings.HasPrefix(fields[2], "/") {
			resolved := filepath.Join(cgroupFilesystemRoot, filepath.Clean(fields[2]))
			if !pathInside(cgroupFilesystemRoot, resolved) {
				return "", errors.New("unified cgroup path escapes /sys/fs/cgroup")
			}
			return resolved, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("unified cgroup v2 membership was not found")
}

func pathInside(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && (relative == "." || filepath.IsLocal(relative))
}
