//go:build linux

package metrics

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Explicit opt-in, run in a disposable delegated systemd unit. The helper's
// cgroup is capped at 64 MiB and touches 16 MiB; this never probes host OOM.
func TestLiveExecutionMemoryCredit(t *testing.T) {
	if os.Getenv("AUTOFORGE_TEST_LIVE_MEMORY") != "1" {
		t.Skip("requires a disposable delegated cgroup")
	}
	membership, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	hierarchy, err := memoryHierarchy(string(membership), "/sys/fs/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	root := hierarchy.path
	if !strings.Contains(filepath.Base(root), "autoforge-memory-live") {
		t.Fatal("refusing non-test cgroup", root)
	}
	leaf := filepath.Join(root, "agent")
	if err := os.Mkdir(leaf, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(leaf, "cgroup.procs"), []byte(fmt.Sprint(os.Getpid())), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "cgroup.subtree_control"), []byte("+memory"), 0600); err != nil {
		t.Fatal(err)
	}
	scope := filepath.Join(root, "attempt-0123456789abcdef01234567")
	if err := os.Mkdir(scope, 0700); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Remove(scope); err != nil {
			t.Error(err)
		}
	}()
	if err := os.WriteFile(filepath.Join(scope, "memory.max"), []byte("67108864"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scope, "memory.swap.max"), []byte("0"), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(os.Args[0], "-test.run=^TestMemoryAllocationHelper$")
	command.Env = append(os.Environ(), "AUTOFORGE_MEMORY_HELPER=1")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		_ = input.Close()
		if !finished {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	if err := os.WriteFile(filepath.Join(scope, "cgroup.procs"), []byte(fmt.Sprint(command.Process.Pid)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(output).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "ready" {
			err = fmt.Errorf("unexpected helper response %q", line)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("memory helper did not become ready")
	}
	collector := NewCollector(root, func() []string { return []string{filepath.Base(scope)} })
	_, _ = collector.Collect() // Initialize the CPU counter baseline.
	time.Sleep(25 * time.Millisecond)
	sample, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if sample.MemoryExecutionCreditBytes < 16<<20 {
		t.Fatalf("allocated anonymous memory was not credited: %+v", sample)
	}
	if sample.MemoryAvailableBytes+sample.MemoryExecutionCreditBytes > sample.MemoryTotalBytes {
		t.Fatalf("credit crossed effective limit: %+v", sample)
	}
	t.Logf("live memory: total=%d available=%d already-counted=%d", sample.MemoryTotalBytes, sample.MemoryAvailableBytes, sample.MemoryExecutionCreditBytes)
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	finished = true
	content, err := os.ReadFile(filepath.Join(scope, "memory.events"))
	if err != nil {
		t.Fatal(err)
	}
	kills, err := memoryStatValue(string(content), "oom_kill")
	if err != nil || kills != 0 {
		t.Fatalf("unexpected OOM: %s %v", content, err)
	}
	sample, err = collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if sample.MemoryExecutionCreditBytes != 0 {
		t.Fatalf("finished execution retained credit: %+v", sample)
	}
}

func TestMemoryAllocationHelper(t *testing.T) {
	if os.Getenv("AUTOFORGE_MEMORY_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	token := make([]byte, 1)
	if _, err := os.Stdin.Read(token); err != nil {
		t.Fatal(err)
	}
	allocation := make([]byte, 16<<20)
	for index := 0; index < len(allocation); index += 4096 {
		allocation[index] = 1
	}
	fmt.Println("ready")
	_, _ = os.Stdin.Read(token)
	runtime.KeepAlive(allocation)
}
