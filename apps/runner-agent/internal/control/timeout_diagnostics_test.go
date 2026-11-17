package control

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestTimeoutDiagnosticsDistinguishesOutputFromUploadThrottling(t *testing.T) {
	diagnostics := &attemptTimeoutDiagnostics{}
	observed := time.Date(2026, 11, 13, 14, 0, 0, 0, time.UTC)
	diagnostics.observeOutput(executor.LogChunk{Stream: "stdout", Content: "still running", RecordedAt: observed})
	diagnostics.observeUpload(&APIError{StatusCode: 429, Code: "RATE_LIMITED"})
	summary := diagnostics.describe(600000)
	for _, expected := range []string{"600.0 秒", "2026-11-13T14:00:00Z", "13 字节", "429 限流 1 次", "不能据此认定 Java"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("summary missing %q: %s", expected, summary)
		}
	}
}

func TestThreadDumpSummaryPrefersTheBusinessThreadOverTheAdapterWaiter(t *testing.T) {
	dump := `"main" #1
   java.lang.Thread.State: WAITING
        at java.util.concurrent.FutureTask.get(FutureTask.java:1)

"adapter-case-execution" #22
   java.lang.Thread.State: RUNNABLE
        at sun.nio.ch.SocketDispatcher.read0(Native Method)
        at fixture.PaymentsTest.send(PaymentsTest.java:42)
`
	summary := summarizeJavaThreadDump(dump, "fixture.PaymentsTest")
	if !strings.Contains(summary, "网络读取") || !strings.Contains(summary, "PaymentsTest.java:42") {
		t.Fatalf("business evidence missing: %s", summary)
	}
}

func TestDiagnosticOutputHasAnIndependentFiniteBudget(t *testing.T) {
	output := &boundedDiagnosticOutput{}
	payload := []byte(strings.Repeat("x", maximumThreadDumpBytes*2))
	if n, err := output.Write(payload); err != nil || n != len(payload) {
		t.Fatalf("write: %d %v", n, err)
	}
	if output.text.Len() != maximumThreadDumpBytes || !output.truncated {
		t.Fatal("diagnostic budget was not enforced")
	}
}

func TestThreadDiagnosticsRejectsAChangedProcessIdentity(t *testing.T) {
	identity, err := executor.ReadProcessIdentity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	identity.StartTimeTicks++
	dump, summary := captureJavaThreadDump(context.Background(), identity, "unused")
	if dump != "" || !strings.Contains(summary, "不采集其他进程") {
		t.Fatalf("PID reuse guard was not enforced: %s %s", dump, summary)
	}
}

func TestTimeoutDiagnosticWatcherStopsBeforeACompletedProcessIsReused(t *testing.T) {
	supervisor := &attemptSupervisor{diagnostics: io.Discard}
	diagnostics := &attemptTimeoutDiagnostics{}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.TimeoutMs = 600000
	// The cancelled watcher must not touch this nil collector or an unrelated PID.
	supervisor.startTimeoutDiagnostics(diagnostics, executor.ProcessIdentity{ProcessID: 1}, claimed, nil, time.Now())
	diagnostics.close()
}

func TestCapturesARealJavaLockWaitWithoutStoppingTheProcess(t *testing.T) {
	java, err := exec.LookPath("java")
	if err != nil {
		t.Skip("A local JDK is required for the real JVM diagnostic integration test")
	}
	resolved, err := filepath.EvalSymlinks(java)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(resolved), "jstack")); err != nil {
		t.Skip("The local Java installation does not include jstack")
	}
	directory := t.TempDir()
	source := filepath.Join(directory, "TimeoutDiagnosticFixture.java")
	// JVMs enumerate threads differently. Give the lock holder a separate class
	// so only the blocked entry point matches the business class under inspection.
	program := `import java.util.concurrent.CountDownLatch;
public class TimeoutDiagnosticFixture {
    public static void main(String[] args) throws Exception {
        Object lock = new Object();
        CountDownLatch held = new CountDownLatch(1);
        new Thread(new DiagnosticLockHolder(lock, held)).start();
        held.await();
        System.out.println("READY");
        synchronized (lock) {
            System.out.println("unexpected completion");
        }
    }
}`
	lockHolderSource := filepath.Join(directory, "DiagnosticLockHolder.java")
	lockHolderProgram := `import java.util.concurrent.CountDownLatch;
class DiagnosticLockHolder implements Runnable {
    private final Object lock;
    private final CountDownLatch held;
    DiagnosticLockHolder(Object lock, CountDownLatch held) {
        this.lock = lock;
        this.held = held;
    }
    public void run() {
        synchronized (lock) {
            held.countDown();
            try {
                System.in.read();
            } catch (java.io.IOException failure) {
                throw new RuntimeException(failure);
            }
        }
    }
}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockHolderSource, []byte(lockHolderProgram), 0600); err != nil {
		t.Fatal(err)
	}
	javac := exec.Command(filepath.Join(filepath.Dir(resolved), "javac"), source, lockHolderSource)
	if output, err := javac.CombinedOutput(); err != nil {
		t.Fatalf("compile JVM fixture: %v %s", err, output)
	}
	process := exec.Command(java, "-Xms16m", "-Xmx32m", "-cp", directory, "TimeoutDiagnosticFixture")
	input, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait() })
	ready := make(chan bool, 1)
	go func() { scanner := bufio.NewScanner(stdout); ready <- scanner.Scan() && scanner.Text() == "READY" }()
	select {
	case success := <-ready:
		if !success {
			t.Fatal("JVM fixture did not become ready")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("JVM fixture startup timed out")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	identity, err := executor.ReadProcessIdentity(process.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	dump, summary := captureJavaThreadDump(ctx, identity, "TimeoutDiagnosticFixture")
	if !strings.Contains(dump, "TimeoutDiagnosticFixture.java") || !strings.Contains(summary, "等待 Java 锁") {
		t.Fatalf("missing real lock evidence: %s\n%s", summary, dump)
	}
	// Release the lock and require the inspected JVM itself to finish normally.
	// Merely checking an un-awaited ProcessState would not prove it survived.
	if _, err := input.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() { completed <- process.Wait() }()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("diagnosed JVM did not finish normally: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("diagnosed JVM did not resume after the lock was released")
	}
}
