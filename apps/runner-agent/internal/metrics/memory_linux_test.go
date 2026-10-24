//go:build linux

package metrics

import (
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestEffectiveMemoryCapacityHonorsEveryAncestorAndHostAvailability(t *testing.T) {
	cases := []struct {
		name       string
		membership string
		files      map[string]string
		expected   memoryCapacity
	}{
		{"host without memory controller", "2:cpu:/service", nil, memoryCapacity{16000, 12000}},
		{"unlimited v2", "0::/service/agent", map[string]string{"/cgroup/service/agent/memory.max": "max"}, memoryCapacity{16000, 12000}},
		{"parent tighter than leaf", "0::/service/agent", map[string]string{
			"/cgroup/service/agent/memory.max": "8000", "/cgroup/service/agent/memory.current": "1000",
			"/cgroup/service/memory.max": "4000", "/cgroup/service/memory.current": "3000",
		}, memoryCapacity{4000, 1000}},
		{"namespace root limit", "0::/", map[string]string{
			"/cgroup/memory.max": "4000", "/cgroup/memory.current": "2000",
		}, memoryCapacity{4000, 2000}},
		{"usage exceeds newly lowered limit", "0::/service", map[string]string{
			"/cgroup/service/memory.max": "4000", "/cgroup/service/memory.current": "5000",
		}, memoryCapacity{4000, 0}},
		{"v1 memory controller", "5:memory:/service", map[string]string{
			"/cgroup/memory/service/memory.limit_in_bytes": "4000", "/cgroup/memory/service/memory.usage_in_bytes": "1000",
		}, memoryCapacity{4000, 3000}},
		{"v1 unlimited sentinel", "5:memory:/service", map[string]string{
			"/cgroup/memory/service/memory.limit_in_bytes": "9223372036854771712",
		}, memoryCapacity{16000, 12000}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := effectiveMemoryCapacity(memoryCapacity{16000, 12000}, test.membership, "/cgroup", func(path string) ([]byte, error) {
				content, ok := test.files[path]
				if !ok {
					return nil, os.ErrNotExist
				}
				return []byte(content), nil
			})
			if err != nil || got != test.expected {
				t.Fatalf("effective capacity = %+v, %v; want %+v", got, err, test.expected)
			}
		})
	}
	got, err := effectiveMemoryCapacity(memoryCapacity{16000, 500}, "0::/service", "/cgroup", func(path string) ([]byte, error) {
		if strings.HasSuffix(path, "memory.max") {
			return []byte("4000"), nil
		}
		return []byte("1000"), nil
	})
	if err != nil || got != (memoryCapacity{4000, 500}) {
		t.Fatalf("host pressure lost: %+v %v", got, err)
	}
}

func TestInvalidMemoryLimitsFailClosed(t *testing.T) {
	for _, files := range []map[string]string{
		{"memory.max": "invalid"}, {"memory.max": "4000"},
		{"memory.max": "4000", "memory.current": "invalid"},
		{"memory.max": "0", "memory.current": "0"},
	} {
		_, err := effectiveMemoryCapacity(memoryCapacity{16000, 12000}, "0::/", "/cgroup", func(path string) ([]byte, error) {
			content, ok := files[strings.TrimPrefix(path, "/cgroup/")]
			if !ok {
				return nil, os.ErrNotExist
			}
			return []byte(content), nil
		})
		if err == nil {
			t.Fatalf("invalid limit accepted: %+v", files)
		}
	}
	_, err := effectiveMemoryCapacity(memoryCapacity{16000, 12000}, "0::/", "/cgroup", func(string) ([]byte, error) { return nil, os.ErrPermission })
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("permission error hidden: %v", err)
	}
}

func TestMemoryStatisticsRejectMissingUnitsOverflowAndImpossibleValues(t *testing.T) {
	for _, content := range []string{
		"MemTotal: 0 kB\nMemAvailable: 0 kB\n", "MemTotal: 100 kB\nMemAvailable: 101 kB\n",
		"MemTotal: 100 B\nMemAvailable: 50 kB\n", "MemTotal: 18446744073709551615 kB\nMemAvailable: 0 kB\n",
		"MemTotal: 100 kB\n",
	} {
		if _, err := parseMemoryCapacity(content); err == nil {
			t.Fatalf("invalid memory statistics accepted: %q", content)
		}
	}
}

func TestSnapshotSerializesZeroAvailableMemory(t *testing.T) {
	content, err := json.Marshal(Snapshot{MemoryTotalBytes: 4000, MemoryAvailableBytes: 0})
	if err != nil || !strings.Contains(string(content), `"memoryAvailableBytes":0`) {
		t.Fatalf("zero memory omitted: %s %v", content, err)
	}
}

func TestMemoryStatisticsKeepTheNumericParseCause(t *testing.T) {
	_, err := parseMemoryCapacity("MemTotal: invalid kB\nMemAvailable: 0 kB\n")
	var numericError *strconv.NumError
	if !errors.As(err, &numericError) {
		t.Fatalf("numeric parse cause was lost: %v", err)
	}
}
