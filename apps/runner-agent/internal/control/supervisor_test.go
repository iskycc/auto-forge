package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

func TestSupervisorClaimsDownloadsExecutesAndCompletesAssignment(t *testing.T) {
	inputContent := []byte("jar")
	digest := sha256.Sum256(inputContent)
	completed := make(chan completeAttemptRequest, 1)
	var claims atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/runner-1/claims":
			var claim claimRequest
			if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			assignments := []ClaimedAssignment(nil)
			if claims.Add(1) == 1 {
				assignments = []ClaimedAssignment{testClaimedAssignment(hex.EncodeToString(digest[:]))}
			}
			_ = json.NewEncoder(writer).Encode(ClaimResponse{SchemaVersion: 1, RequestID: claim.RequestID, Assignments: assignments, RetryAfterMs: 100})
		case "/api/v1/run-attempts/attempt-1/inputs/source-1":
			writer.Header().Set("Content-Length", "3")
			_, _ = writer.Write(inputContent)
		case "/api/v1/run-attempts/attempt-1/complete":
			var completion completeAttemptRequest
			if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			completed <- completion
			_ = json.NewEncoder(writer).Encode(CompleteAttemptResponse{SchemaVersion: 1, CompletionID: completion.CompletionID, AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano), Disposition: "accepted"})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	dataDirectory, err := os.MkdirTemp("/dev/shm", "autoforge-agent-test-")
	if err != nil {
		t.Skipf("temporary filesystem with free capacity is unavailable: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dataDirectory) })
	classpathEntry := filepath.Join(dataDirectory, "testng.jar")
	if err := os.WriteFile(classpathEntry, []byte("offline-test-fixture"), 0o600); err != nil {
		t.Fatalf("write classpath fixture: %v", err)
	}
	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: dataDirectory, Name: "runner-1",
		MaxConcurrent: 1,
		Toolchain: config.ToolchainConfig{
			JavaExecutable: "/bin/true", Classpath: []string{classpathEntry}, JavaVersion: "test", TestNGVersion: "test",
		},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	defer client.Close()
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes", ServerURL: server.URL}
	supervisor := newAttemptSupervisor(client, identity, configuration, os.Stderr)
	ctx, cancel := context.WithCancel(context.Background())
	if err := supervisor.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	select {
	case completion := <-completed:
		if completion.Result.Status != "succeeded" || completion.Result.ResultCode != "TESTNG_SUCCEEDED" {
			t.Fatalf("completion result = %#v", completion.Result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for completed assignment")
	}
	cancel()
	supervisor.Close()
}

func TestPermanentLeaseRejectionStopsExecutionAuthority(t *testing.T) {
	if !isPermanentLeaseRejection(&APIError{StatusCode: http.StatusConflict, Code: "LEASE_VERSION_CONFLICT"}) {
		t.Fatal("lease version conflict was treated as transient")
	}
	if isPermanentLeaseRejection(&APIError{StatusCode: http.StatusTooManyRequests, Code: "RATE_LIMITED"}) {
		t.Fatal("rate limiting was treated as permanent lease rejection")
	}
}

func testClaimedAssignment(inputDigest string) ClaimedAssignment {
	specification := testExecutionSpec()
	specification.Inputs[0].SHA256 = inputDigest
	return ClaimedAssignment{
		Assignment: Assignment{
			SchemaVersion: 1, AssignmentID: "assignment-1", AttemptID: "attempt-1", RunnerID: "runner-1",
			ExecutionSpec: specification,
		},
		Lease: Lease{
			LeaseID: "lease-1", Token: "lease-token-with-more-than-thirty-two-bytes", Version: 1,
			ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		},
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	return parsed
}
