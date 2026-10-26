//go:build linux

package metrics

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Snapshot struct {
	CPUUtilizationPercent      float64 `json:"cpuUtilizationPercent"`
	MemoryUtilizationPercent   float64 `json:"memoryUtilizationPercent"`
	MemoryTotalBytes           uint64  `json:"memoryTotalBytes"`
	MemoryExecutionCreditBytes uint64  `json:"memoryExecutionCreditBytes"`
	MemoryAvailableBytes       uint64  `json:"memoryAvailableBytes"`
	LoadAverage1m              float64 `json:"loadAverage1m"`
	LogicalCPUCount            int     `json:"logicalCpuCount"`
	ObservedAt                 string  `json:"observedAt"`
}

type Collector struct {
	executionCgroupRoot string
	executionScopeNames func() []string
	mu                  sync.Mutex
	previousCPU         cpuTimes
	hasPrevious         bool
}

type cpuTimes struct {
	total uint64
	idle  uint64
}

func NewCollector(executionCgroupRoot string, executionScopeNames func() []string) *Collector {
	return &Collector{executionCgroupRoot: executionCgroupRoot, executionScopeNames: executionScopeNames}
}

func (collector *Collector) Collect() (Snapshot, error) {
	cpuContent, err := os.ReadFile("/proc/stat")
	if err != nil {
		return Snapshot{}, fmt.Errorf("read CPU statistics: %w", err)
	}
	execution, err := collectExecutionMemory(collector.executionCgroupRoot, collector.executionScopeNames(), os.ReadFile)
	if err != nil {
		return Snapshot{}, err
	}
	memoryContent, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return Snapshot{}, fmt.Errorf("read memory statistics: %w", err)
	}
	loadContent, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return Snapshot{}, fmt.Errorf("read load average: %w", err)
	}

	currentCPU, err := parseCPUTimes(string(cpuContent))
	if err != nil {
		return Snapshot{}, err
	}
	memory, err := parseMemoryCapacity(string(memoryContent))
	if err != nil {
		return Snapshot{}, err
	}
	// Read the controlled scopes on both sides of the host sample. Using the
	// smaller observation avoids crediting a burst or a process that just exited.
	after, err := collectExecutionMemory(collector.executionCgroupRoot, collector.executionScopeNames(), os.ReadFile)
	if err != nil {
		return Snapshot{}, err
	}
	execution = intersectExecutionMemory(execution, after)
	memory.executionCredit = min(execution.anonymousBytes, memory.total-memory.available)
	membership, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return Snapshot{}, fmt.Errorf("read memory cgroup membership: %w", err)
	}
	memberships := []string{string(membership)}
	if collector.executionCgroupRoot != "" {
		relative, pathErr := filepath.Rel("/sys/fs/cgroup", collector.executionCgroupRoot)
		if pathErr != nil || (relative != "." && !filepath.IsLocal(relative)) {
			return Snapshot{}, errors.New("execution memory cgroup escapes /sys/fs/cgroup")
		}
		memberships = append(memberships, "0::/"+relative)
	}
	memory, err = effectiveRunnerMemoryCapacity(memory, memberships, "/sys/fs/cgroup", execution, os.ReadFile)
	if err != nil {
		return Snapshot{}, err
	}
	loadAverage, err := parseLoadAverage(string(loadContent))
	if err != nil {
		return Snapshot{}, err
	}

	collector.mu.Lock()
	if !collector.hasPrevious {
		collector.previousCPU = currentCPU
		collector.hasPrevious = true
		collector.mu.Unlock()
		return Snapshot{}, errors.New("CPU utilization baseline initialized; retry after the next heartbeat interval")
	}
	cpuUtilization, err := calculateCPUUtilization(currentCPU, collector.previousCPU)
	collector.previousCPU = currentCPU
	collector.mu.Unlock()
	if err != nil {
		return Snapshot{}, err
	}

	return Snapshot{
		CPUUtilizationPercent:      roundedPercent(cpuUtilization),
		MemoryUtilizationPercent:   roundedPercent(memory.utilizationPercent()),
		MemoryTotalBytes:           memory.total,
		MemoryAvailableBytes:       memory.available,
		MemoryExecutionCreditBytes: memory.executionCredit,
		LoadAverage1m:              loadAverage,
		LogicalCPUCount:            runtime.NumCPU(),
		ObservedAt:                 time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func parseCPUTimes(content string) (cpuTimes, error) {
	line, _, found := strings.Cut(content, "\n")
	fields := strings.Fields(line)
	if !found || len(fields) < 5 || fields[0] != "cpu" {
		return cpuTimes{}, errors.New("parse CPU statistics: aggregate row is missing")
	}
	var values []uint64
	for _, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuTimes{}, fmt.Errorf("parse CPU statistics: %w", err)
		}
		values = append(values, value)
	}
	var total uint64
	for _, value := range values {
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	if total == 0 {
		return cpuTimes{}, errors.New("parse CPU statistics: total time is zero")
	}
	return cpuTimes{total: total, idle: idle}, nil
}

func parseLoadAverage(content string) (float64, error) {
	fields := strings.Fields(content)
	if len(fields) == 0 {
		return 0, errors.New("parse load average: value is missing")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || value < 0 {
		return 0, errors.New("parse load average: value is invalid")
	}
	return value, nil
}

func calculateCPUUtilization(current, previous cpuTimes) (float64, error) {
	if current.total <= previous.total || current.idle < previous.idle {
		return 0, errors.New("calculate CPU utilization: counters did not advance monotonically")
	}
	total := current.total - previous.total
	idle := current.idle - previous.idle
	if total == 0 || idle > total {
		return 0, errors.New("calculate CPU utilization: delta is invalid")
	}
	return float64(total-idle) / float64(total) * 100, nil
}

func roundedPercent(value float64) float64 {
	return float64(int(value*100+0.5)) / 100
}
