package control

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestFinishedJavaEntersUploadPhaseBeforeWaitingForLogFlush(t *testing.T) {
	assertFinishedJavaEntersUploadPhase(t, "completed", "succeeded", "TESTNG_SUCCEEDED")
}

func TestLogSilenceTimeoutKeepsItsResultWhenEnteringUploadPhase(t *testing.T) {
	assertFinishedJavaEntersUploadPhase(t, executor.LogSilenceTermination, "timed_out", "EXECUTION_LOG_SILENCE_TIMEOUT")
}

func assertFinishedJavaEntersUploadPhase(t *testing.T, termination, expectedStatus, expectedCode string) {
	t.Helper()
	var uploadPhase atomic.Bool
	releasePersistence := make(chan struct{})
	var releaseOnce sync.Once
	releaseLogs := func() { releaseOnce.Do(func() { close(releasePersistence) }) }
	defer releaseLogs()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/upload-phase") {
			uploadPhase.Store(true)
			releaseLogs()
			_, _ = io.WriteString(writer, `{"schemaVersion":1,"artifacts":[]}`)
			return
		}
		if !uploadPhase.Load() {
			writer.WriteHeader(429)
			_, _ = io.WriteString(writer, `{"error":{"code":"RATE_LIMITED","message":"log upload temporarily throttled"}}`)
			return
		}
		var upload uploadLogChunksRequest
		if err := json.NewDecoder(request.Body).Decode(&upload); err != nil {
			t.Error(err)
			writer.WriteHeader(400)
			return
		}
		watermarks := logWatermark{Stdout: -1, Stderr: -1, Agent: -1}
		for _, chunk := range upload.Chunks {
			switch chunk.Stream {
			case "stdout":
				watermarks.Stdout = max(watermarks.Stdout, chunk.Sequence)
			case "agent":
				watermarks.Agent = max(watermarks.Agent, chunk.Sequence)
			}
		}
		_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{SchemaVersion: 1, AcknowledgedSequence: watermarks})
	}))
	defer server.Close()
	configuration := config.Config{ServerURL: mustParseURL(t, server.URL), DataDirectory: t.TempDir(), MaxConcurrent: 1, Toolchain: config.ToolchainConfig{JavaExecutable: "/usr/bin/java", Classpath: []string{"testng.jar"}}, Spool: config.SpoolConfig{MaximumBytes: 8 << 20, UploadBatch: 16}}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	spool, err := newLogSpool(configuration.DataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	supervisor := newAttemptSupervisor(client, Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"}, configuration, io.Discard)
	supervisor.logSpool = spool
	workspace := t.TempDir()
	supervisor.runExecution = func(_ context.Context, _ executor.Spec, options executor.RunOptions) (executor.Result, error) {
		// A finished JVM may still have output buffered behind local persistence.
		// Only declaring upload phase can release this deterministic fixture.
		spool.budget.mu.Lock()
		go func() {
			<-releasePersistence
			spool.budget.mu.Unlock()
		}()
		if err := options.LogSink(executor.LogChunk{Stream: "stdout", Content: "business finished\n", RecordedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
		return executor.Result{Termination: termination, ExitCode: 0, WorkspacePath: workspace, DurationMs: 1}, nil
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.UploadTimeoutMs = 1000
	claimed.Assignment.ExecutionSpec.LogSilenceTimeoutMs = 120_000
	claimed.Assignment.ExecutionSpec.ArtifactRules = []ArtifactRule{{Pattern: "missing-retired-report/**", Required: true}}
	completed := make(chan completionResult, 1)
	go func() {
		completed <- supervisor.runTestNG(context.Background(), claimed, func(completionResult) error { return nil }, func(executor.ProcessIdentity) error { return nil })
	}()
	var result completionResult
	select {
	case result = <-completed:
	case <-time.After(time.Second):
		t.Error("upload phase was not declared before draining buffered local logs")
		releaseLogs()
		select {
		case result = <-completed:
		case <-time.After(3 * time.Second):
			t.Fatal("finished attempt did not settle after local persistence was released")
		}
	}
	if result.Status != expectedStatus || result.ResultCode != expectedCode {
		t.Fatalf("a finished JVM was kept in execution while log flush was throttled: %+v", result)
	}
	if termination == executor.LogSilenceTermination && !strings.Contains(result.Summary, "连续 120 秒") {
		t.Fatalf("missing log silence evidence: %s", result.Summary)
	}
	if !uploadPhase.Load() {
		t.Fatal("upload phase was never declared")
	}
}
