//go:build linux

package metrics

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const maximumJSONInteger = uint64(1<<53 - 1)

type memoryCapacity struct {
	total     uint64
	available uint64
}

func (capacity memoryCapacity) utilizationPercent() float64 {
	return float64(capacity.total-capacity.available) / float64(capacity.total) * 100
}

func parseMemoryCapacity(content string) (memoryCapacity, error) {
	values := make(map[string]uint64, 2)
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		if key != "MemTotal" && key != "MemAvailable" {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" {
			return memoryCapacity{}, fmt.Errorf("parse memory statistics: %s has invalid units", key)
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return memoryCapacity{}, fmt.Errorf("parse memory statistics %s: %w", key, err)
		}
		if value > maximumJSONInteger/1024 {
			return memoryCapacity{}, fmt.Errorf("parse memory statistics: %s exceeds the safe JSON integer range", key)
		}
		values[key] = value * 1024
	}
	total, hasTotal := values["MemTotal"]
	available, hasAvailable := values["MemAvailable"]
	if !hasTotal || !hasAvailable || total == 0 || available > total {
		return memoryCapacity{}, errors.New("parse memory statistics: MemTotal or MemAvailable is invalid")
	}
	return memoryCapacity{total: total, available: available}, nil
}

type memoryCgroupHierarchy struct {
	root      string
	path      string
	limitFile string
	usageFile string
}

// Account for all ancestors, since a service/container limit can be smaller than
// the physical host. No process scan or allocation probe is needed on a heartbeat.
func effectiveMemoryCapacity(host memoryCapacity, membership, cgroupRoot string, readFile func(string) ([]byte, error)) (memoryCapacity, error) {
	hierarchy, err := memoryHierarchy(membership, cgroupRoot)
	if err != nil {
		return memoryCapacity{}, err
	}
	if hierarchy.path == "" {
		return host, nil
	}
	capacity := host
	for directory := hierarchy.path; ; directory = filepath.Dir(directory) {
		capacity, err = constrainCgroupMemory(capacity, host.total, hierarchy, directory, readFile)
		if err != nil {
			return memoryCapacity{}, err
		}
		if directory == hierarchy.root {
			break
		}
	}
	if capacity.total == 0 {
		return memoryCapacity{}, errors.New("effective memory cgroup capacity is zero")
	}
	return capacity, nil
}

func memoryHierarchy(membership, cgroupRoot string) (memoryCgroupHierarchy, error) {
	var unifiedPath, legacyPath string
	for _, line := range strings.Split(membership, "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 {
			continue
		}
		if fields[0] == "0" && fields[1] == "" {
			unifiedPath = fields[2]
		}
		for _, controller := range strings.Split(fields[1], ",") {
			if controller == "memory" {
				legacyPath = fields[2]
			}
		}
	}
	hierarchy := memoryCgroupHierarchy{root: cgroupRoot, limitFile: "memory.max", usageFile: "memory.current"}
	path := unifiedPath
	if path == "" {
		if legacyPath == "" {
			return memoryCgroupHierarchy{}, nil
		}
		path = legacyPath
		hierarchy.root = filepath.Join(cgroupRoot, "memory")
		hierarchy.limitFile, hierarchy.usageFile = "memory.limit_in_bytes", "memory.usage_in_bytes"
	}
	if !strings.HasPrefix(path, "/") {
		return memoryCgroupHierarchy{}, errors.New("memory cgroup membership must be absolute")
	}
	hierarchy.path = filepath.Join(hierarchy.root, filepath.Clean(path))
	relative, err := filepath.Rel(hierarchy.root, hierarchy.path)
	if err != nil || (relative != "." && !filepath.IsLocal(relative)) {
		return memoryCgroupHierarchy{}, errors.New("memory cgroup membership escapes its root")
	}
	return hierarchy, nil
}

func constrainCgroupMemory(capacity memoryCapacity, hostTotal uint64, hierarchy memoryCgroupHierarchy, directory string, readFile func(string) ([]byte, error)) (memoryCapacity, error) {
	content, err := readFile(filepath.Join(directory, hierarchy.limitFile))
	if errors.Is(err, os.ErrNotExist) {
		return capacity, nil
	}
	if err != nil {
		return memoryCapacity{}, fmt.Errorf("read memory cgroup limit %s: %w", directory, err)
	}
	if strings.TrimSpace(string(content)) == "max" {
		return capacity, nil
	}
	limit, err := strconv.ParseUint(strings.TrimSpace(string(content)), 10, 64)
	if err != nil {
		return memoryCapacity{}, fmt.Errorf("parse memory cgroup limit %s: %w", directory, err)
	}
	// cgroup v1 represents unlimited capacity as a very large integer.
	if limit > hostTotal {
		return capacity, nil
	}
	usageContent, err := readFile(filepath.Join(directory, hierarchy.usageFile))
	if err != nil {
		return memoryCapacity{}, fmt.Errorf("read memory cgroup usage %s: %w", directory, err)
	}
	usage, err := strconv.ParseUint(strings.TrimSpace(string(usageContent)), 10, 64)
	if err != nil {
		return memoryCapacity{}, fmt.Errorf("parse memory cgroup usage %s: %w", directory, err)
	}
	available := uint64(0)
	if usage < limit {
		available = limit - usage
	}
	return memoryCapacity{total: min(capacity.total, limit), available: min(capacity.available, available)}, nil
}
