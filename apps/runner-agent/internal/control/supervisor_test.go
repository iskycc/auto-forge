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
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestExecutionSecretsStayOutOfPersistedClaimAndEnterOnlyLocalSpec(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var acquisition acquireSecretsRequest
		if err := json.NewDecoder(request.Body).Decode(&acquisition); err != nil {
			t.Errorf("decode acquisition: %v", err)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(acquireSecretsResponse{
			SchemaVersion: protocolVersion,
			RequestID:     acquisition.RequestID,
			Secrets:       []EnvironmentEntry{{Name: "API_TOKEN", Value: "execution-secret"}},
		})
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.SecretReferences = []SecretReference{{
		Name: "API_TOKEN", SecretID: "secret-1", SecretVersionID: "secret-version-1",
	}}
	supervisor := &attemptSupervisor{
		client:   client,
		identity: Identity{RunnerID: "runner-1", Credential: "runner-credential"},
	}
	localSpec, err := supervisor.executionSpecWithSecrets(context.Background(), claimed)
	if err != nil {
		t.Fatal(err)
	}
	if len(localSpec.Environment) != 1 || localSpec.Environment[0].Value != "execution-secret" {
		t.Fatalf("local environment = %#v", localSpec.Environment)
	}
	if len(claimed.Assignment.ExecutionSpec.Environment) != 0 {
		t.Fatalf("persisted claim was mutated: %#v", claimed.Assignment.ExecutionSpec.Environment)
	}
}

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
		case "/api/v1/run-attempts/attempt-1/logs":
			var upload uploadLogChunksRequest
			if err := json.NewDecoder(request.Body).Decode(&upload); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{
				SchemaVersion:        1,
				AcknowledgedSequence: logWatermark{Stdout: -1, Stderr: -1, Agent: 0},
			})
		case "/api/v1/run-attempts/attempt-1/artifacts":
			var declaration declareArtifactsRequest
			if err := json.NewDecoder(request.Body).Decode(&declaration); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(writer).Encode(declareArtifactsResponse{
				SchemaVersion: 1,
				Artifacts:     []declaredArtifact{},
			})
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
			JavaExecutable: "/bin/true", Classpath: []string{classpathEntry}, JavaVersion: "21.0.8", TestNGVersion: "7.11.0",
		},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	defer client.Close()
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes", ServerURL: server.URL}
	supervisor := newAttemptSupervisor(client, identity, configuration, os.Stderr)
	supervisor.runExecution = func(
		ctx context.Context,
		specification executor.Spec,
		options executor.RunOptions,
	) (executor.Result, error) {
		options.ResourcePolicy = executor.ResourcePolicy{}
		return executor.Run(ctx, specification, options)
	}
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

func TestResourceLimitResultUsesStableCodes(t *testing.T) {
	for resource, expected := range map[string]string{
		"memory":    "RESOURCE_MEMORY_EXCEEDED",
		"processes": "RESOURCE_PROCESS_LIMIT_EXCEEDED",
		"disk":      "RESOURCE_DISK_EXCEEDED",
		"files":     "RESOURCE_FILE_LIMIT_EXCEEDED",
		"monitor":   "RESOURCE_MONITOR_FAILED",
	} {
		code, _ := resourceLimitResult(resource)
		if code != expected {
			t.Fatalf("resourceLimitResult(%q) = %q, want %q", resource, code, expected)
		}
	}
}

func TestClaimedAssignmentRejectsIncompatiblePlatformAndToolchain(t *testing.T) {
	configuration := config.Config{Toolchain: config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21.0.8",
		TestNGVersion:  "7.11.0",
	}}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.RuntimeRequirements.Architectures = []string{"unsupported"}
	if err := validateClaimedAssignment(claimed, "runner-1", configuration); err == nil {
		t.Fatal("validateClaimedAssignment accepted an incompatible architecture")
	}

	claimed = testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.RuntimeRequirements.TestNGVersion = "7.10.2"
	if err := validateClaimedAssignment(claimed, "runner-1", configuration); err == nil {
		t.Fatal("validateClaimedAssignment accepted an incompatible TestNG toolchain")
	}
}

func TestClaimedAssignmentAcceptsConfiguredContainerExecutor(t *testing.T) {
	configuration := config.Config{
		Toolchain: config.ToolchainConfig{
			JavaExecutable: "/opt/jdk/bin/java",
			Classpath:      []string{"/opt/testng/testng.jar"},
			JavaVersion:    "21.0.8",
			TestNGVersion:  "7.11.0",
		},
		Container: config.ContainerConfig{
			RuntimeExecutable: "/usr/bin/docker",
			ImageReference:    "registry.local/testng@sha256:" + strings.Repeat("a", 64),
			SeccompProfile:    "/etc/autoforge/seccomp.json",
			User:              "10001:10001",
			JavaExecutable:    "/opt/java/openjdk/bin/java",
			Classpath:         []string{"/opt/autoforge/testng/testng.jar"},
		},
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.Executor = "testng-container"
	claimed.Assignment.ExecutionSpec.RequiredCapabilities = []string{
		"executor:testng-container-v1",
	}

	if err := validateClaimedAssignment(claimed, "runner-1", configuration); err != nil {
		t.Fatalf("validateClaimedAssignment rejected a configured container executor: %v", err)
	}
}

func testClaimedAssignment(inputDigest string) ClaimedAssignment {
	specification := testExecutionSpec()
	specification.Inputs[0].SHA256 = inputDigest
	specification.ResourceLimits = ResourceLimits{
		CPUMillicores: 1_000,
		MemoryBytes:   256 << 20,
		DiskBytes:     1 << 20,
		ProcessCount:  64,
		FileCount:     1_024,
		LogBytes:      1 << 20,
		ArtifactBytes: 1 << 20,
	}
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
