package control

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestRejectedDiagnosticDoesNotPoisonBusinessLogsOrCreateASequenceGap(t *testing.T) {
	spool, err := newLogSpool(t.TempDir(), config.SpoolConfig{MaximumBytes: 4 << 20}, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Leave room for ordinary short output, but not a thread snapshot.
	reserved := spool.budget.maximumBytes - spool.budget.metadataReserve - 1024
	if err := spool.budget.reservePayload(reserved); err != nil {
		t.Fatal(err)
	}
	collector := newAttemptLogCollector("diagnostic-quota", spool, nil)
	now := time.Now().UTC()
	if err := collector.WriteDiagnostic(strings.Repeat("snapshot", 1024), now); !errors.Is(err, errLogSpoolQuotaExceeded) {
		t.Fatalf("diagnostic error = %v, want the payload quota", err)
	}
	if err := collector.Write(executor.LogChunk{Stream: "stdout", Content: "original case result\n", RecordedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := collector.Close(now.Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("optional diagnostic contaminated business-log finalization: %v", err)
	}
	spool.budget.release(reserved)
	if err := collector.WriteDiagnostic("snapshot password=private-value\n", now); err != nil {
		t.Fatal(err)
	}
	chunks, err := spool.list("diagnostic-quota", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected only the original stdout and the accepted diagnostic, got %#v", chunks)
	}
	for _, chunk := range chunks {
		if chunk.Sequence != 0 || strings.Contains(chunk.Content, "private-value") {
			t.Fatalf("diagnostic lost sequence or redaction guarantees: %#v", chunk)
		}
	}
}
