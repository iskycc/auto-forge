package control

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestLogCollectorRedactsCrossChunkSecretBeforeSpooling(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 1 << 20,
		Retention:    time.Hour,
		UploadBatch:  10,
	}, 1)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	collector := newAttemptLogCollector("attempt-1", spool, []EnvironmentEntry{{
		Name: "TOKEN", Value: "cross-boundary-secret", Secret: true,
	}})
	for _, content := range []string{"prefix cross-bound", "ary-secret suffix"} {
		if err := collector.Write(executor.LogChunk{Stream: "stdout", Content: content, RecordedAt: time.Now()}); err != nil {
			t.Fatalf("collect log: %v", err)
		}
	}
	if err := collector.Close(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("close collector: %v", err)
	}
	chunks, err := spool.list("attempt-1", 10)
	if err != nil {
		t.Fatalf("list spool: %v", err)
	}
	combined := ""
	for _, chunk := range chunks {
		combined += chunk.Content
	}
	if strings.Contains(combined, "cross-boundary-secret") || !strings.Contains(combined, "[REDACTED]") {
		t.Fatalf("secret was not redacted: %q", combined)
	}
	if err := spool.acknowledge("attempt-1", logWatermark{
		Stdout: chunks[len(chunks)-1].Sequence, Stderr: -1, Agent: -1,
	}); err != nil {
		t.Fatalf("acknowledge spool: %v", err)
	}
	remaining, err := spool.list("attempt-1", 10)
	if err != nil {
		t.Fatalf("list remaining spool: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("remaining chunks = %d, want 0", len(remaining))
	}
}

func TestLogCollectorFlushesAgentStreamImmediately(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 1 << 20,
		Retention:    time.Hour,
		UploadBatch:  10,
	}, 1)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	collector := newAttemptLogCollector("attempt-agent-immediate", spool, nil)
	if err := collector.Write(executor.LogChunk{
		Stream: "agent", Content: "Agent started.\n", RecordedAt: time.Now(),
	}); err != nil {
		t.Fatalf("collect agent log: %v", err)
	}
	chunks, err := spool.list("attempt-agent-immediate", 10)
	if err != nil {
		t.Fatalf("list spool: %v", err)
	}
	if len(chunks) != 1 || chunks[0].Stream != "agent" || chunks[0].Content != "Agent started.\n" {
		t.Fatalf("agent chunk was not flushed immediately: %#v", chunks)
	}
}

func TestLogCollectorFlushesOrdinaryTestOutputWithoutWaitingForClose(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 1 << 20,
		Retention:    time.Hour,
		UploadBatch:  10,
	}, 1)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	collector := newAttemptLogCollector("attempt-live-tail", spool, nil)
	content := "AfterClass: test.cases.abcdefghijklmnop.qrstuvwxyz.abcd1234\n"
	if err := collector.Write(executor.LogChunk{
		Stream: "stdout", Content: content, RecordedAt: time.Now(),
	}); err != nil {
		t.Fatalf("collect log: %v", err)
	}

	chunks, err := spool.list("attempt-live-tail", 10)
	if err != nil {
		t.Fatalf("list spool: %v", err)
	}
	if len(chunks) != 1 || chunks[0].Content != content {
		t.Fatalf("live test output was withheld or changed: %#v", chunks)
	}
}

func TestLogSpoolRejectsQuotaOverflow(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 32,
		Retention:    time.Hour,
		UploadBatch:  1,
	}, 1)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	err = spool.append("attempt-1", logChunk{
		Stream: "stdout", Sequence: 0, Content: strings.Repeat("x", 64), RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != errLogSpoolQuotaExceeded {
		t.Fatalf("append error = %v, want quota error", err)
	}
}

func TestLogSpoolDoesNotSerializeDifferentAttemptShards(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 1 << 20,
		Retention:    time.Hour,
		UploadBatch:  10,
	}, 2)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	lockedAttempt := "attempt-locked"
	independentAttempt := "attempt-independent"
	if logSpoolLockIndex(lockedAttempt) == logSpoolLockIndex(independentAttempt) {
		t.Fatal("test attempts unexpectedly share a spool lock shard")
	}
	unlock := spool.lockAttempt(lockedAttempt)
	defer unlock()

	completed := make(chan error, 1)
	go func() {
		completed <- spool.append(independentAttempt, logChunk{
			Stream: "stdout", Sequence: 0, Content: "independent",
			RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
		})
	}()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("an unrelated attempt was blocked by another attempt's spool operation")
	}
}

func TestLogSpoolRetentionKeepsUnconfirmedAttemptChunks(t *testing.T) {
	dataDirectory := t.TempDir()
	store := newAttemptStore(dataDirectory)
	if err := store.save(attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "running",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{AttemptID: "attempt-1"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDirectory, "spool", "logs", "attempt-1", "stdout", "00000000000000000000.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"stream":"stdout"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := newLogSpool(dataDirectory, config.SpoolConfig{MaximumBytes: 1 << 20, Retention: time.Hour}, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("unconfirmed log chunk was removed by retention: %v", err)
	}
	if err := store.remove("attempt-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := newLogSpool(dataDirectory, config.SpoolConfig{MaximumBytes: 1 << 20, Retention: time.Hour}, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("orphaned expired log chunk still exists: %v", err)
	}
}

func TestLogSpoolPreservesInterleavedStreamsAndIdempotentSequences(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{
		MaximumBytes: 1 << 20, Retention: time.Hour,
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	collector := newAttemptLogCollector("attempt-1", spool, nil)
	for _, chunk := range []executor.LogChunk{
		{Stream: "stdout", Content: "out-0", RecordedAt: time.Now()},
		{Stream: "stderr", Content: "err-0", RecordedAt: time.Now()},
		{Stream: "stdout", Content: "out-1", RecordedAt: time.Now()},
	} {
		if err := collector.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := collector.Close(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	chunks, err := spool.list("attempt-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	byStream := make(map[string]string)
	for _, chunk := range chunks {
		byStream[chunk.Stream] += chunk.Content
	}
	if byStream["stdout"] != "out-0out-1" || byStream["stderr"] != "err-0" {
		t.Fatalf("interleaved stream content = %#v", byStream)
	}
	duplicate := chunks[0]
	if err := spool.append("attempt-1", duplicate); err != nil {
		t.Fatalf("idempotent duplicate was rejected: %v", err)
	}
	duplicate.Content = "conflict"
	if err := spool.append("attempt-1", duplicate); err == nil {
		t.Fatal("conflicting duplicate sequence was accepted")
	}
}

func TestLogSpoolKeepsASequenceAfterAGapAcrossRestart(t *testing.T) {
	dataDirectory := t.TempDir()
	policy := config.SpoolConfig{MaximumBytes: 1 << 20, Retention: time.Hour}
	spool, err := newLogSpool(dataDirectory, policy, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, sequence := range []int64{0, 2} {
		if err := spool.append("attempt-1", logChunk{
			Stream: "stdout", Sequence: sequence, Content: "chunk", RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := spool.acknowledge("attempt-1", logWatermark{Stdout: 0, Stderr: -1, Agent: -1}); err != nil {
		t.Fatal(err)
	}
	restarted, err := newLogSpool(dataDirectory, policy, 1)
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := restarted.list("attempt-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 1 || chunks[0].Sequence != 2 {
		t.Fatalf("chunks after restart = %#v, want unconfirmed sequence 2", chunks)
	}
}
