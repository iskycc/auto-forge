package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

func TestArtifactSpoolSharesQuotaAndRemovesConfirmedPayload(t *testing.T) {
	dataDirectory := t.TempDir()
	budget, err := newSpoolBudget(dataDirectory, 64, 0)
	if err != nil {
		t.Fatal(err)
	}
	spool, err := newArtifactSpool(dataDirectory, budget)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("artifact")
	digest := sha256.Sum256(content)
	declaration := artifactDeclaration{
		ArtifactID: "artifact-1", RelativePath: "reports/result.xml",
		MediaType: "application/xml", SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]),
	}
	source := filepath.Join(t.TempDir(), "result.xml")
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := spool.stage("attempt-1", declaration, source); err != nil {
		t.Fatal(err)
	}
	if err := spool.verify("attempt-1", declaration); err != nil {
		t.Fatal(err)
	}
	if err := spool.stage("attempt-1", declaration, source); err != nil {
		t.Fatalf("idempotent stage failed: %v", err)
	}
	if err := spool.removeAttempt("attempt-1"); err != nil {
		t.Fatal(err)
	}
	if budget.usedBytes != 0 {
		t.Fatalf("used spool bytes = %d, want 0", budget.usedBytes)
	}

	oversized := declaration
	oversized.ArtifactID = "artifact-2"
	oversized.SizeBytes = 65
	if err := spool.stage("attempt-1", oversized, source); !errors.Is(err, errSpoolQuotaExceeded) {
		t.Fatalf("quota error = %v", err)
	}
}

func TestReconcileResumesSpooledArtifactBeforeCompletion(t *testing.T) {
	artifactContent := []byte("persisted artifact")
	digest := sha256.Sum256(artifactContent)
	declaration := artifactDeclaration{
		ArtifactID: "artifact-1", RelativePath: "reports/result.xml",
		MediaType: "application/xml", SizeBytes: int64(len(artifactContent)), SHA256: hex.EncodeToString(digest[:]), Required: true,
	}
	var uploaded bytes.Buffer
	completionReceived := false
	var failUpload atomic.Bool
	failUpload.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/runner-1/reconcile":
			_ = json.NewEncoder(writer).Encode(ReconcileResponse{
				SchemaVersion: 1,
				Decisions:     []ReconcileDecision{{AttemptID: "attempt-1", Action: "retransmit"}},
			})
		case "/api/v1/run-attempts/attempt-1/artifacts":
			_ = json.NewEncoder(writer).Encode(declareArtifactsResponse{
				SchemaVersion: 1,
				Artifacts: []declaredArtifact{{
					artifactDeclaration: declaration,
					UploadMethod:        "control-plane",
					UploadPath:          "/api/v1/run-attempts/attempt-1/artifacts/artifact-1/content",
					Status:              "pending",
				}},
			})
		case "/api/v1/run-attempts/attempt-1/artifacts/artifact-1/content":
			if failUpload.Load() {
				http.Error(writer, "object store unavailable", http.StatusServiceUnavailable)
				return
			}
			_, _ = uploaded.ReadFrom(request.Body)
			_ = json.NewEncoder(writer).Encode(uploadArtifactResponse{ArtifactID: "artifact-1", Status: "uploaded"})
		case "/api/v1/run-attempts/attempt-1/complete":
			completionReceived = true
			var completion completeAttemptRequest
			if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
				t.Error(err)
			}
			if completion.Result.ResultCode != "TESTNG_SUCCEEDED" {
				t.Errorf("completion result = %#v", completion.Result)
			}
			_ = json.NewEncoder(writer).Encode(CompleteAttemptResponse{
				SchemaVersion: 1, CompletionID: completion.CompletionID,
				AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano), Disposition: "accepted",
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	dataDirectory := t.TempDir()
	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: dataDirectory,
		Spool: config.SpoolConfig{MaximumBytes: 1 << 20, Retention: time.Hour, UploadBatch: 10},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	supervisor := newAttemptSupervisor(
		client,
		Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"},
		configuration,
		os.Stderr,
	)
	logSpool, err := newLogSpool(dataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	supervisor.logSpool = logSpool
	supervisor.store.budget = logSpool.budget
	supervisor.artifactSpool, err = newArtifactSpool(dataDirectory, logSpool.budget)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "result.xml")
	if err := os.WriteFile(source, artifactContent, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.artifactSpool.stage("attempt-1", declaration, source); err != nil {
		t.Fatal(err)
	}
	state := attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "uploading",
		CompletionID:  "completion-1",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{
				AttemptID:     "attempt-1",
				ExecutionSpec: ExecutionSpec{UploadTimeoutMs: 100},
			},
			Lease: Lease{
				LeaseID: "lease-1", Token: "lease-token-with-more-than-thirty-two-bytes", Version: 1,
				ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
			},
		},
		Result: &completionResult{
			Status: "succeeded", ResultCode: "TESTNG_SUCCEEDED", Summary: "passed", DurationMs: 10,
			Artifacts: []artifactDeclaration{declaration},
		},
		ArtifactUploads: []artifactUploadState{{Artifact: declaration}},
	}
	if err := supervisor.store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.reconcile(context.Background()); err == nil {
		t.Fatal("reconcile succeeded while the object store was unavailable")
	}
	states, err := supervisor.store.list()
	if err != nil || len(states) != 1 {
		t.Fatalf("state was not retained after upload failure: %#v, error = %v", states, err)
	}
	failUpload.Store(false)
	if err := supervisor.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if uploaded.String() != string(artifactContent) || !completionReceived {
		t.Fatalf("uploaded = %q, completionReceived = %v", uploaded.String(), completionReceived)
	}
	states, err = supervisor.store.list()
	if err != nil || len(states) != 0 {
		t.Fatalf("remaining states = %#v, error = %v", states, err)
	}
	if _, err := os.Stat(supervisor.artifactSpool.path("attempt-1", "artifact-1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("confirmed artifact spool was not removed: %v", err)
	}
}

func TestReconcileUploadsOnlyLogsAboveTheConfirmedWatermark(t *testing.T) {
	uploadedSequences := make([]int64, 0)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/runner-1/reconcile":
			_ = json.NewEncoder(writer).Encode(ReconcileResponse{
				SchemaVersion: 1,
				Decisions: []ReconcileDecision{{
					AttemptID: "attempt-1", Action: "retransmit",
					AcknowledgedLogSequence: &logWatermark{Stdout: 0, Stderr: -1, Agent: -1},
				}},
			})
		case "/api/v1/run-attempts/attempt-1/logs":
			var upload uploadLogChunksRequest
			if err := json.NewDecoder(request.Body).Decode(&upload); err != nil {
				t.Error(err)
			}
			for _, chunk := range upload.Chunks {
				uploadedSequences = append(uploadedSequences, chunk.Sequence)
			}
			_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{
				SchemaVersion:        1,
				AcknowledgedSequence: logWatermark{Stdout: 1, Stderr: -1, Agent: -1},
			})
		case "/api/v1/run-attempts/attempt-1/complete":
			var completion completeAttemptRequest
			if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
				t.Error(err)
			}
			_ = json.NewEncoder(writer).Encode(CompleteAttemptResponse{
				SchemaVersion: 1, CompletionID: completion.CompletionID,
				AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano), Disposition: "accepted",
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	dataDirectory := t.TempDir()
	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: dataDirectory,
		Spool: config.SpoolConfig{MaximumBytes: 1 << 20, Retention: time.Hour, UploadBatch: 10},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	supervisor := newAttemptSupervisor(
		client,
		Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"},
		configuration,
		os.Stderr,
	)
	supervisor.logSpool, err = newLogSpool(dataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	supervisor.store.budget = supervisor.logSpool.budget
	supervisor.artifactSpool, err = newArtifactSpool(dataDirectory, supervisor.logSpool.budget)
	if err != nil {
		t.Fatal(err)
	}
	for _, sequence := range []int64{0, 1} {
		if err := supervisor.logSpool.append("attempt-1", logChunk{
			Stream: "stdout", Sequence: sequence, Content: "chunk", RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			t.Fatal(err)
		}
	}
	state := attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "finishing",
		CompletionID:  "completion-1",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{
				AttemptID:     "attempt-1",
				ExecutionSpec: ExecutionSpec{UploadTimeoutMs: 2_000},
			},
			Lease: Lease{
				LeaseID: "lease-1", Token: "lease-token-with-more-than-thirty-two-bytes", Version: 1,
				ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
			},
		},
		Result: &completionResult{
			Status: "succeeded", ResultCode: "TESTNG_SUCCEEDED", Summary: "passed", DurationMs: 10,
		},
	}
	if err := supervisor.store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(uploadedSequences) != 1 || uploadedSequences[0] != 1 {
		t.Fatalf("uploaded sequences = %#v, want only unconfirmed sequence 1", uploadedSequences)
	}
	states, err := supervisor.store.list()
	if err != nil || len(states) != 0 {
		t.Fatalf("remaining states = %#v, error = %v", states, err)
	}
}

func TestReconcileRemovesCrashedWorkspaceAfterLeaseExpiry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/runner-1/reconcile":
			_ = json.NewEncoder(writer).Encode(ReconcileResponse{
				SchemaVersion: 1,
				Decisions: []ReconcileDecision{{
					AttemptID: "attempt-expired", Action: "continue",
				}},
			})
		case "/api/v1/run-attempts/attempt-expired/complete":
			t.Error("expired lease must not send a completion request")
			http.Error(writer, "expired", http.StatusConflict)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	dataDirectory := t.TempDir()
	configuration.DataDirectory = dataDirectory
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	supervisor := newAttemptSupervisor(
		client,
		Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"},
		configuration,
		os.Stderr,
	)
	supervisor.logSpool, err = newLogSpool(dataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	supervisor.store.budget = supervisor.logSpool.budget
	supervisor.artifactSpool, err = newArtifactSpool(dataDirectory, supervisor.logSpool.budget)
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(dataDirectory, "work", "attempt-expired-1234567890")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	state := attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "running",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{
				AttemptID: "attempt-expired",
				ExecutionSpec: ExecutionSpec{
					AttemptID: "attempt-expired", UploadTimeoutMs: 1_000,
				},
			},
			Lease: Lease{
				LeaseID: "lease-expired", Token: "lease-token-with-more-than-thirty-two-bytes", Version: 1,
				ExpiresAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
			},
		},
	}
	if err := supervisor.store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(workspace); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired attempt workspace still exists: %v", err)
	}
	states, err := supervisor.store.list()
	if err != nil || len(states) != 1 || states[0].Result == nil {
		t.Fatalf("completion state was not retained for retry: %#v, error = %v", states, err)
	}
}
