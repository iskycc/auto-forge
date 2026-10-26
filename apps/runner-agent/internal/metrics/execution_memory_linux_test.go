//go:build linux

package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExecutionCreditOnlyCountsControlledAnonymousMemory(t *testing.T) {
	root := t.TempDir()
	scope := "attempt-0123456789abcdef01234567"
	for _, name := range []string{scope, "agent", "attempt-invalid", "attempt-2223456789abcdef01234567"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, name, "memory.stat"), []byte("anon 2000\nfile 8000\nshmem 5000\ninactive_file 3000\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, scope), filepath.Join(root, "attempt-1123456789abcdef01234567")); err != nil {
		t.Fatal(err)
	}
	snapshot, err := collectExecutionMemory(root, []string{scope, scope, "attempt-invalid", "../agent"}, os.ReadFile)
	if err != nil || snapshot.anonymousBytes != 2000 {
		t.Fatalf("execution credit = %+v %v", snapshot, err)
	}
	after := executionMemory{root: root, anonymousByScope: map[string]uint64{scope: 1000, "another-scope": 4000}}
	if got := intersectExecutionMemory(snapshot, after); got.anonymousBytes != 1000 {
		t.Fatalf("scope churn inflated credit: %+v", got)
	}
	if err := os.Remove(filepath.Join(root, scope, "memory.stat")); err != nil {
		t.Fatal(err)
	}
	snapshot, err = collectExecutionMemory(root, []string{scope, scope, "attempt-invalid", "../agent"}, os.ReadFile)
	if err != nil || snapshot.anonymousBytes != 0 {
		t.Fatalf("completed scope: %+v %v", snapshot, err)
	}
}

func TestCgroupBudgetReclaimsOnlyInactiveFilesAndCreditsOnlyContainingBoundaries(t *testing.T) {
	cases := []struct {
		name, membership string
		files            map[string]string
		want             memoryCapacity
	}{
		{"common ancestor", "0::/service/agent", map[string]string{
			"/cgroup/service/memory.max": "10000", "/cgroup/service/memory.current": "8000", "/cgroup/service/memory.stat": "inactive_file 2000\nfile 6000\nshmem 3000\n",
		}, memoryCapacity{total: 10000, available: 4000, executionCredit: 3000}},
		{"agent leaf excludes sibling executions", "0::/service/agent", map[string]string{
			"/cgroup/service/agent/memory.max": "4000", "/cgroup/service/agent/memory.current": "3000",
			"/cgroup/service/memory.max": "10000", "/cgroup/service/memory.current": "8000",
		}, memoryCapacity{total: 4000, available: 1000, executionCredit: 0}},
		{"execution boundary", "0::/service", map[string]string{
			"/cgroup/service/memory.max": "8000", "/cgroup/service/memory.current": "7000",
		}, memoryCapacity{total: 8000, available: 1000, executionCredit: 3000}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := effectiveMemoryCapacity(memoryCapacity{total: 16000, available: 8000, executionCredit: 3000}, test.membership, "/cgroup", executionMemory{root: "/cgroup/service", anonymousBytes: 3000}, func(path string) ([]byte, error) {
				value, ok := test.files[path]
				if !ok {
					return nil, os.ErrNotExist
				}
				return []byte(value), nil
			})
			if err != nil || got != test.want {
				t.Fatalf("budget = %+v %v; want %+v", got, err, test.want)
			}
		})
	}
}

func TestExecutionMemoryRejectsInvalidStatsAndBoundsScopeReads(t *testing.T) {
	for _, content := range []string{"anon invalid", "anon -1", "anon 9007199254740992", "anon 1 extra"} {
		if _, err := memoryStatValue(content, "anon"); err == nil {
			t.Fatalf("invalid statistic accepted: %s", content)
		}
	}
	names := make([]string, maximumMemoryScopes+1)
	result, err := collectExecutionMemory(t.TempDir(), names, func(string) ([]byte, error) { t.Fatal("oversized scope list must not read memory"); return nil, nil })

	if err != nil || result.anonymousBytes != 0 {
		t.Fatalf("oversized root credit = %+v %v", result, err)
	}
}

func TestDirtyPagesAndTighterExecutionAncestorsRetainTheirBudgets(t *testing.T) {
	files := map[string]string{
		"/cgroup/agent/memory.max": "4000", "/cgroup/agent/memory.current": "1000",
		"/cgroup/executions/memory.max": "8000", "/cgroup/executions/memory.current": "7500",
		"/cgroup/executions/memory.stat": "inactive_file 1000\nfile_dirty 600\nfile_writeback 200\n",
	}
	got, err := effectiveRunnerMemoryCapacity(memoryCapacity{total: 16000, available: 12000, executionCredit: 1000}, []string{"0::/agent", "0::/executions"}, "/cgroup", executionMemory{root: "/cgroup/executions", anonymousBytes: 1000}, func(path string) ([]byte, error) {
		value, ok := files[path]
		if !ok {
			return nil, os.ErrNotExist
		}
		return []byte(value), nil
	})
	// The 8,000-byte boundary still applies after the Agent's 4,000-byte limit.
	// Only 200 clean inactive bytes are reclaimable; the Agent-only limit grants no credit.
	if err != nil || got != (memoryCapacity{total: 4000, available: 700, executionCredit: 1000}) {
		t.Fatalf("boundary budget = %+v %v", got, err)
	}
}
