package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
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

func TestSupervisorResumesClaimsAfterDrainIsCleared(t *testing.T) {
	claims := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/runner-agents/runner-1/claims" {
			http.NotFound(writer, request)
			return
		}
		var claim claimRequest
		if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		claims <- struct{}{}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(ClaimResponse{
			SchemaVersion: 1,
			RequestID:     claim.RequestID,
			RetryAfterMs:  100,
		})
	}))
	defer server.Close()

	configuration := config.Config{
		ServerURL:     mustParseURL(t, server.URL),
		DataDirectory: t.TempDir(),
		MaxConcurrent: 1,
		Toolchain: config.ToolchainConfig{
			JavaExecutable: "/bin/true",
			Classpath:      []string{"testng.jar"},
		},
		Claim: config.ClaimConfig{MaximumBackoff: time.Second},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var diagnostics bytes.Buffer
	supervisor := newAttemptSupervisor(
		client,
		Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"},
		configuration,
		&diagnostics,
	)
	supervisor.SetDraining(true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		supervisor.claimLoop(ctx)
		close(done)
	}()

	select {
	case <-claims:
		cancel()
		t.Fatal("drained supervisor claimed an assignment")
	case <-time.After(drainPollInterval + 100*time.Millisecond):
	}
	if !supervisor.SetDraining(false) {
		cancel()
		t.Fatal("clearing drain state did not report a lifecycle transition")
	}
	select {
	case <-claims:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("supervisor did not resume assignment claims")
	}
	// The next request can only begin after the first successful response was
	// parsed and the one-time readiness diagnostic was emitted.
	select {
	case <-claims:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("supervisor did not continue assignment claim polling")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("claim loop did not stop after cancellation")
	}
	if !strings.Contains(diagnostics.String(), "assignment claiming active") {
		t.Fatalf("successful claim polling was not diagnosed: %q", diagnostics.String())
	}
}

func TestStreamAttemptLogsUploadsWhileAttemptIsRunning(t *testing.T) {
	uploaded := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var upload uploadLogChunksRequest
		if err := json.NewDecoder(request.Body).Decode(&upload); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		uploaded <- struct{}{}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{
			SchemaVersion:        1,
			AcknowledgedSequence: logWatermark{Stdout: 0, Stderr: -1, Agent: -1},
		})
	}))
	defer server.Close()
	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: t.TempDir(), MaxConcurrent: 1,
		Spool: config.SpoolConfig{MaximumBytes: 8 << 20, UploadBatch: 16},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	spool, err := newLogSpool(configuration.DataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := spool.append("attempt-1", logChunk{
		Stream: "stdout", Sequence: 0, Content: "live output\n", RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	supervisor := &attemptSupervisor{
		client: client,
		identity: Identity{
			RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes",
		},
		configuration: configuration,
		logSpool:      spool,
		diagnostics:   os.Stderr,
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	ctx, cancel := context.WithCancel(context.Background())
	completed := make(chan logWatermark, 1)
	go func() { completed <- supervisor.streamAttemptLogs(ctx, claimed, 10*time.Millisecond) }()
	select {
	case <-uploaded:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("timed out waiting for a live log upload")
	}
	deadline := time.Now().Add(time.Second)
	for {
		remaining, listErr := spool.list("attempt-1", 16)
		if listErr != nil {
			cancel()
			t.Fatal(listErr)
		}
		if len(remaining) == 0 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("live log upload was not acknowledged")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	watermark := <-completed
	if watermark.Stdout != 0 {
		t.Fatalf("stdout watermark = %d, want 0", watermark.Stdout)
	}
}

func TestFlushAttemptLogsKeepsEachRequestWithinTheControlPlaneLimit(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		requestCount.Add(1)
		if len(payload) > maximumLogUploadRequestBytes {
			http.Error(writer, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		var upload uploadLogChunksRequest
		if err := json.Unmarshal(payload, &upload); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		watermark := logWatermark{Stdout: -1, Stderr: -1, Agent: -1}
		for _, chunk := range upload.Chunks {
			if chunk.Stream == "stdout" {
				watermark.Stdout = max(watermark.Stdout, chunk.Sequence)
			}
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{
			SchemaVersion: protocolVersion, AcknowledgedSequence: watermark,
		})
	}))
	defer server.Close()

	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: t.TempDir(), MaxConcurrent: 1,
		Spool: config.SpoolConfig{MaximumBytes: 64 << 20, UploadBatch: 128},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	spool, err := newLogSpool(configuration.DataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	for sequence := int64(0); sequence < 10; sequence++ {
		if err := spool.append("attempt-1", logChunk{
			Stream: "stdout", Sequence: sequence, Content: strings.Repeat("<", 80<<10),
			RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			t.Fatal(err)
		}
	}
	supervisor := &attemptSupervisor{
		client: client,
		identity: Identity{
			RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes",
		},
		configuration: configuration,
		logSpool:      spool,
		diagnostics:   io.Discard,
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))

	if _, err := supervisor.flushAttemptLogs(context.Background(), claimed, 5*time.Second); err != nil {
		t.Fatalf("flushAttemptLogs() error = %v", err)
	}
	if requestCount.Load() < 2 {
		t.Fatalf("request count = %d, want multiple bounded requests", requestCount.Load())
	}
	remaining, err := spool.list("attempt-1", 128)
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 0 {
		t.Fatalf("remaining log chunks = %d, want 0", len(remaining))
	}
}

func TestFlushAttemptLogsRetriesTransientUploadFailure(t *testing.T) {
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if requestCount.Add(1) == 1 {
			http.Error(writer, "temporary outage", http.StatusServiceUnavailable)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(uploadLogChunksResponse{
			SchemaVersion:        protocolVersion,
			AcknowledgedSequence: logWatermark{Stdout: 0, Stderr: -1, Agent: -1},
		})
	}))
	defer server.Close()

	configuration := config.Config{
		ServerURL: mustParseURL(t, server.URL), DataDirectory: t.TempDir(), MaxConcurrent: 1,
		Spool: config.SpoolConfig{MaximumBytes: 1 << 20, UploadBatch: 16},
	}
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	spool, err := newLogSpool(configuration.DataDirectory, configuration.Spool, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := spool.append("attempt-1", logChunk{
		Stream: "stdout", Sequence: 0, Content: "retry me", RecordedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	supervisor := &attemptSupervisor{
		client: client,
		identity: Identity{
			RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes",
		},
		configuration: configuration,
		logSpool:      spool,
		diagnostics:   io.Discard,
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))

	if _, err := supervisor.flushAttemptLogs(context.Background(), claimed, 3*time.Second); err != nil {
		t.Fatalf("flushAttemptLogs() error = %v", err)
	}
	if requestCount.Load() != 2 {
		t.Fatalf("request count = %d, want 2", requestCount.Load())
	}
}

func TestProcessPreparationFailureDistinguishesWorkspaceDiskCapacity(t *testing.T) {
	failure := processStartFailure(&workspaceCapacityError{requiredBytes: 459129517, availableBytes: 450891776})
	if failure.ResultCode != "WORKSPACE_DISK_INSUFFICIENT" {
		t.Fatalf("result code = %q, want WORKSPACE_DISK_INSUFFICIENT", failure.ResultCode)
	}
	if !strings.Contains(failure.Summary, "disk") || strings.Contains(strings.ToLower(failure.Summary), "memory") {
		t.Fatalf("summary = %q, want an explicit disk-capacity description", failure.Summary)
	}
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

func TestClaimedAssignmentRejectsRetiredExecutionEnvironmentFields(t *testing.T) {
	configuration := config.Config{Toolchain: config.ToolchainConfig{
		JavaExecutable: "/opt/jdk/bin/java",
		Classpath:      []string{"/opt/testng/testng.jar"},
		JavaVersion:    "21.0.8",
		TestNGVersion:  "7.11.0",
	}}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	claimed.Assignment.ExecutionSpec.Environment = []EnvironmentEntry{{Name: "LEGACY", Value: "value"}}
	if err := validateClaimedAssignment(claimed, "runner-1", configuration); err == nil ||
		!strings.Contains(err.Error(), "retired execution environment") {
		t.Fatalf("validateClaimedAssignment() error = %v", err)
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

func TestMapExecutionResultTreatsAdapterTimeoutExitCodeAsTimedOut(t *testing.T) {
	mapped := mapExecutionResult(executor.Result{
		Termination: "completed",
		ExitCode:    adapterCaseTimeoutExitCode,
		DurationMs:  600_000,
	})
	if mapped.Status != "timed_out" || mapped.ResultCode != "ADAPTER_CASE_TIMEOUT" {
		t.Fatalf("mapExecutionResult() = %+v", mapped)
	}
}

func TestMapTestNGReportKeepsAdapterTimeoutAuthoritative(t *testing.T) {
	mapped := mapExecutionResult(executor.Result{
		Termination: "completed",
		ExitCode:    adapterCaseTimeoutExitCode,
	})
	mapTestNGReport(&mapped, executor.Result{
		Termination: "completed",
		ExitCode:    adapterCaseTimeoutExitCode,
	}, executor.TestNGReportSummary{
		TestNGResultCounts: executor.TestNGResultCounts{Failed: 1, ConfigurationFailures: 1},
	})
	if mapped.Status != "timed_out" || mapped.ResultCode != "ADAPTER_CASE_TIMEOUT" {
		t.Fatalf("mapTestNGReport() overrode the timeout result: %+v", mapped)
	}
	if mapped.TestNG == nil {
		t.Fatal("mapTestNGReport() must keep the parsed report summary")
	}
}
