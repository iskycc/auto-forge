package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

// batchTestInput 构造一个合法的 test-jar 输入及对应内容。
func batchTestInput(content []byte) (ExecutionInput, string) {
	digest := sha256.Sum256(content)
	return ExecutionInput{
		InputID:    "input-1",
		Kind:       "test-jar",
		TargetPath: "libs/case.jar",
		MediaType:  "application/java-archive",
		SizeBytes:  int64(len(content)),
		SHA256:     hex.EncodeToString(digest[:]),
	}, hex.EncodeToString(digest[:])
}

// batchClaimedAssignment 构造 ensureBatchInputs 所需的最小 assignment。
func batchClaimedAssignment(attemptID, batchID string, input ExecutionInput) ClaimedAssignment {
	return ClaimedAssignment{
		Assignment: Assignment{
			SchemaVersion: protocolVersion,
			AssignmentID:  "assignment-" + attemptID,
			AttemptID:     attemptID,
			RunnerID:      "runner-1",
			ExecutionSpec: ExecutionSpec{
				SchemaVersion:  protocolVersion,
				AttemptID:      attemptID,
				BatchID:        batchID,
				Inputs:         []ExecutionInput{input},
				ResourceLimits: ResourceLimits{DiskBytes: 1 << 20, FileCount: 1_024},
			},
		},
		Lease: Lease{LeaseID: "lease-" + attemptID, Token: "lease-token-with-more-than-thirty-two-bytes", Version: 1},
	}
}

// batchDownloadServer 返回计数下载次数的 httptest 服务器与计数器。
func batchDownloadServer(t *testing.T, content []byte) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.URL.Path, "/api/v1/run-attempts/") || !strings.Contains(request.URL.Path, "/inputs/") {
			http.NotFound(writer, request)
			return
		}
		downloads.Add(1)
		writer.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
		_, _ = writer.Write(content)
	}))
	t.Cleanup(server.Close)
	return server, &downloads
}

func TestBatchRegistrySharesDownloadsAcrossConcurrentAttempts(t *testing.T) {
	content := []byte("shared-test-jar")
	input, _ := batchTestInput(content)
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	registry := newBatchRegistry(t.TempDir())
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential"}

	// 注册同批次两个在途 attempt，然后并发确保共享输入。
	for _, attemptID := range []string{"attempt-1", "attempt-2"} {
		if err := registry.acquire("batch-1"); err != nil {
			t.Fatalf("acquire(%s) error = %v", attemptID, err)
		}
	}
	var waitGroup sync.WaitGroup
	errorsChannel := make(chan error, 2)
	for _, attemptID := range []string{"attempt-1", "attempt-2"} {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, err := registry.ensureBatchInputs(
				context.Background(),
				client,
				identity,
				batchClaimedAssignment(attemptID, "batch-1", input),
				[]ExecutionInput{input},
				false,
			)
			errorsChannel <- err
		}()
	}
	waitGroup.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			t.Fatalf("ensureBatchInputs() error = %v", err)
		}
	}
	if got := downloads.Load(); got != 1 {
		t.Fatalf("downloads = %d, want 1", got)
	}
	shared := filepath.Join(registry.directory("batch-1"), filepath.FromSlash(input.TargetPath))
	sharedContent, err := os.ReadFile(shared)
	if err != nil || string(sharedContent) != string(content) {
		t.Fatalf("shared input = %q, %v", sharedContent, err)
	}

	// 两个 attempt 工作目录都通过硬链接获得输入。
	for _, attemptID := range []string{"attempt-1", "attempt-2"} {
		workspace := t.TempDir()
		if err := linkBatchInputsIntoWorkspace(registry.directory("batch-1"), workspace, []ExecutionInput{input}); err != nil {
			t.Fatalf("linkBatchInputsIntoWorkspace(%s) error = %v", attemptID, err)
		}
		linked, err := os.ReadFile(filepath.Join(workspace, filepath.FromSlash(input.TargetPath)))
		if err != nil || string(linked) != string(content) {
			t.Fatalf("linked input = %q, %v", linked, err)
		}
	}
}

func TestBatchRegistryRedownloadsWhenDigestMismatch(t *testing.T) {
	content := []byte("shared-test-jar")
	input, _ := batchTestInput(content)
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	registry := newBatchRegistry(t.TempDir())
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential"}
	claimed := batchClaimedAssignment("attempt-1", "batch-1", input)
	if err := registry.acquire("batch-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ensureBatchInputs(context.Background(), client, identity, claimed, []ExecutionInput{input}, false); err != nil {
		t.Fatalf("first ensureBatchInputs() error = %v", err)
	}

	// 篡改共享目录内容后，流式重算的 SHA-256 不匹配，必须重新下载。
	shared := filepath.Join(registry.directory("batch-1"), filepath.FromSlash(input.TargetPath))
	if err := os.WriteFile(shared, []byte("corrupted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ensureBatchInputs(context.Background(), client, identity, claimed, []ExecutionInput{input}, false); err != nil {
		t.Fatalf("second ensureBatchInputs() error = %v", err)
	}
	if got := downloads.Load(); got != 2 {
		t.Fatalf("downloads = %d, want 2", got)
	}
	restored, err := os.ReadFile(shared)
	if err != nil || string(restored) != string(content) {
		t.Fatalf("restored input = %q, %v", restored, err)
	}
}

func TestBatchRegistryMaterializesAdapterDependenciesOnce(t *testing.T) {
	fixtureRoot := t.TempDir()
	bundlePath := filepath.Join(fixtureRoot, "dependencies.zip")
	writeZipFixture(t, bundlePath, map[string]string{
		"nested/project.jar": "project-dependency",
	})
	bundle, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}
	testJAR := []byte("test-jar")
	inputs := []ExecutionInput{
		executionInputFixture("test-jar", "test-jar", "inputs/tests.jar", testJAR),
		executionInputFixture("bundle", "jar-bundle", "runtime-inputs/dependencies.zip", bundle),
	}
	contents := map[string][]byte{"test-jar": testJAR, "bundle": bundle}
	var downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		for inputID, content := range contents {
			if strings.HasSuffix(request.URL.Path, "/inputs/"+inputID) {
				downloads.Add(1)
				writer.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
				_, _ = writer.Write(content)
				return
			}
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	registry := newBatchRegistry(t.TempDir())
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential"}
	for range 2 {
		if err := registry.acquire("batch-1"); err != nil {
			t.Fatal(err)
		}
	}

	var waitGroup sync.WaitGroup
	errorsChannel := make(chan error, 2)
	for _, attemptID := range []string{"attempt-1", "attempt-2"} {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			claimed := batchClaimedAssignment(attemptID, "batch-1", inputs[0])
			claimed.Assignment.ExecutionSpec.Inputs = inputs
			claimed.Assignment.ExecutionSpec.ResourceLimits = ResourceLimits{
				DiskBytes: 1 << 20,
				FileCount: 1_024,
			}
			_, ensureErr := registry.ensureBatchInputs(
				context.Background(),
				client,
				identity,
				claimed,
				inputs,
				true,
			)
			errorsChannel <- ensureErr
		}()
	}
	waitGroup.Wait()
	close(errorsChannel)
	for ensureErr := range errorsChannel {
		if ensureErr != nil {
			t.Fatalf("ensureBatchInputs() error = %v", ensureErr)
		}
	}
	if got := downloads.Load(); got != int32(len(inputs)) {
		t.Fatalf("downloads = %d, want %d", got, len(inputs))
	}

	// 前两个并发 attempt 已结束后再启动同批次的后续 attempt，原始输入和
	// 已解压依赖仍必须复用，不能把“共享”限制成单次并发波次。
	registry.release("batch-1", false, nil)
	registry.release("batch-1", false, nil)
	if err := registry.acquire("batch-1"); err != nil {
		t.Fatal(err)
	}
	laterClaim := batchClaimedAssignment("attempt-3", "batch-1", inputs[0])
	laterClaim.Assignment.ExecutionSpec.Inputs = inputs
	laterClaim.Assignment.ExecutionSpec.ResourceLimits = ResourceLimits{
		DiskBytes: 1 << 20,
		FileCount: 1_024,
	}
	if _, err := registry.ensureBatchInputs(
		context.Background(),
		client,
		identity,
		laterClaim,
		inputs,
		true,
	); err != nil {
		t.Fatalf("later ensureBatchInputs() error = %v", err)
	}
	if got := downloads.Load(); got != int32(len(inputs)) {
		t.Fatalf("downloads after later attempt = %d, want %d", got, len(inputs))
	}

	sharedDependency := filepath.Join(
		registry.directory("batch-1"),
		"runtime",
		"cotest",
		"test-jars",
		"nested",
		"project.jar",
	)
	sharedStat, err := os.Stat(sharedDependency)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		workspace := t.TempDir()
		if err := linkSharedCotestRuntime(registry.directory("batch-1"), workspace, inputs); err != nil {
			t.Fatal(err)
		}
		jarDirectory, err := os.Lstat(filepath.Join(workspace, "test-jars"))
		if err != nil || !jarDirectory.IsDir() || jarDirectory.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("shared test-jars directory = %v, %v", jarDirectory, err)
		}
		dependencyStat, err := os.Stat(filepath.Join(workspace, "test-jars", "nested", "project.jar"))
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(sharedStat, dependencyStat) {
			t.Fatal("attempt did not reuse the batch-level extracted dependency")
		}
	}
}

func TestEnsureBatchJDKAcceptsJDK8EmbeddedJRE(t *testing.T) {
	batchDir := t.TempDir()
	archivePath := filepath.Join(batchDir, "runtime-inputs", "jdk8.tar.gz")
	writeTarGzipFixture(t, archivePath, []tarFixtureEntry{
		{name: "jdk8/bin/java", content: "jdk-java"},
		{name: "jdk8/jre/bin/java", content: "embedded-jre-java"},
	})
	input := ExecutionInput{
		Kind:       "jdk-archive",
		TargetPath: "runtime-inputs/jdk8.tar.gz",
		SizeBytes:  fileSize(t, archivePath),
	}

	if err := ensureBatchJDK(batchDir, []ExecutionInput{input}, ResourceLimits{
		DiskBytes: 1 << 20,
		FileCount: 100,
	}); err != nil {
		t.Fatal(err)
	}
	for relative, expected := range map[string]string{
		"runtime/jdk/bin/java":     "jdk-java",
		"runtime/jdk/jre/bin/java": "embedded-jre-java",
	} {
		content, err := os.ReadFile(filepath.Join(batchDir, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatalf("read %s: %v", relative, err)
		}
		if string(content) != expected {
			t.Fatalf("%s content = %q, want %q", relative, content, expected)
		}
	}
}

func TestLinkSharedRegularTreeRejectsSymbolicLinks(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "case.jar"), []byte("jar"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("case.jar", filepath.Join(source, "linked.jar")); err != nil {
		t.Fatal(err)
	}
	err := linkSharedRegularTree(source, filepath.Join(t.TempDir(), "test-jars"))
	if err == nil || !strings.Contains(err.Error(), "is not a regular file") {
		t.Fatalf("linkSharedRegularTree() error = %v", err)
	}
}

func executionInputFixture(inputID, kind, targetPath string, content []byte) ExecutionInput {
	digest := sha256.Sum256(content)
	return ExecutionInput{
		InputID:    inputID,
		Kind:       kind,
		TargetPath: targetPath,
		SizeBytes:  int64(len(content)),
		SHA256:     hex.EncodeToString(digest[:]),
	}
}

func TestBatchRegistryRemovesDirectoryOnlyWhenBatchClosedAndIdle(t *testing.T) {
	tests := []struct {
		name           string
		activeAttempts int
		releases       []bool // 每次 release 携带的 batchClosed 标记
		expectRemoved  bool
	}{
		{"批次未关闭时保留目录", 1, []bool{false}, false},
		{"批次关闭通知早于最后一个 attempt 收尾仍会删除目录", 2, []bool{true, false}, true},
		{"批次关闭且最后一个 attempt 收尾时删除目录", 2, []bool{true, true}, true},
		{"单 attempt 批次关闭即删除目录", 1, []bool{true}, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := newBatchRegistry(t.TempDir())
			batchDir := registry.directory("batch-1")
			if err := os.MkdirAll(batchDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(batchDir, "case.jar"), []byte("jar"), 0o600); err != nil {
				t.Fatal(err)
			}
			for index := 0; index < test.activeAttempts; index++ {
				if err := registry.acquire("batch-1"); err != nil {
					t.Fatal(err)
				}
			}
			for _, batchClosed := range test.releases {
				registry.release("batch-1", batchClosed, nil)
			}
			_, err := os.Stat(batchDir)
			removed := os.IsNotExist(err)
			if removed != test.expectRemoved {
				t.Fatalf("batch directory removed = %v, want %v", removed, test.expectRemoved)
			}
		})
	}
}

func TestBatchRegistryRemovesIdleWorkspaceAfterClaimConfirmsClosure(t *testing.T) {
	registry := newBatchRegistry(t.TempDir())
	if err := registry.acquire("batch-1"); err != nil {
		t.Fatal(err)
	}
	batchDir := registry.directory("batch-1")
	if err := os.MkdirAll(batchDir, 0o700); err != nil {
		t.Fatal(err)
	}
	registry.release("batch-1", false, nil)
	if got := registry.idleBatchIDs(); len(got) != 1 || got[0] != "batch-1" {
		t.Fatalf("idleBatchIDs() = %v, want [batch-1]", got)
	}
	registry.close("batch-1", nil)
	if _, err := os.Stat(batchDir); !os.IsNotExist(err) {
		t.Fatalf("closed idle batch workspace still exists: %v", err)
	}
}

func TestBatchRegistryRetriesFailedTerminalRemoval(t *testing.T) {
	registry := newBatchRegistry(t.TempDir())
	if err := registry.acquire("batch-1"); err != nil {
		t.Fatal(err)
	}
	batchDir := registry.directory("batch-1")
	if err := os.MkdirAll(batchDir, 0o700); err != nil {
		t.Fatal(err)
	}
	removeCalls := 0
	registry.removeAll = func(path string) error {
		removeCalls++
		if removeCalls == 1 {
			return fmt.Errorf("injected removal failure")
		}
		return os.RemoveAll(path)
	}

	registry.release("batch-1", true, nil)
	if _, err := os.Stat(batchDir); err != nil {
		t.Fatalf("workspace should remain after injected failure: %v", err)
	}
	if got := registry.idleBatchIDs(); len(got) != 1 || got[0] != "batch-1" {
		t.Fatalf("idleBatchIDs() after failed removal = %v, want [batch-1]", got)
	}

	registry.close("batch-1", nil)
	if _, err := os.Stat(batchDir); !os.IsNotExist(err) {
		t.Fatalf("workspace still exists after removal retry: %v", err)
	}
}

func TestCleanOrphanedWorkspacesRestoresReusableBatchDirectories(t *testing.T) {
	dataDirectory := t.TempDir()
	store := newAttemptStore(dataDirectory)
	// 本地仍有状态记录的 attempt 视为活跃，其工作目录必须保留。
	if err := store.save(attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "running",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{AttemptID: "attempt-1"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	workRoot := filepath.Join(dataDirectory, "work")
	for _, directory := range []string{
		"attempt-1-1000001",                    // 有本地状态，保留
		"attempt-9-2000002",                    // 崩溃残留，删除
		filepath.Join("batches", "batch-1"),    // 重启后恢复并向控制面核对
		filepath.Join("batches", "invalid id"), // 非法批次路径，删除
	} {
		if err := os.MkdirAll(filepath.Join(workRoot, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	supervisor := &attemptSupervisor{
		store:         store,
		configuration: config.Config{DataDirectory: dataDirectory},
		batches:       newBatchRegistry(dataDirectory),
	}
	if err := supervisor.cleanOrphanedWorkspaces(); err != nil {
		t.Fatal(err)
	}
	assertExists := func(relative string, want bool) {
		t.Helper()
		_, err := os.Stat(filepath.Join(workRoot, relative))
		if got := err == nil; got != want {
			t.Fatalf("%s exists = %v, want %v", relative, got, want)
		}
	}
	assertExists("attempt-1-1000001", true)
	assertExists("attempt-9-2000002", false)
	assertExists(filepath.Join("batches", "batch-1"), true)
	assertExists(filepath.Join("batches", "invalid id"), false)
	// 启动 reconcile 确认结果后会删除本地状态；第二次孤儿扫描必须回收首次
	// 因状态仍存在而保留的工作目录。
	if err := store.remove("attempt-1"); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.cleanOrphanedWorkspaces(); err != nil {
		t.Fatal(err)
	}
	assertExists("attempt-1-1000001", false)
	if got := supervisor.CachedBatchIDs(); len(got) != 1 || got[0] != "batch-1" {
		t.Fatalf("CachedBatchIDs() = %v, want [batch-1]", got)
	}
	supervisor.ApplyClosedBatchIDs([]string{"batch-1"})
	assertExists(filepath.Join("batches", "batch-1"), false)
}

func TestReportCompletionReturnsBatchClosedFromControlPlane(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/run-attempts/attempt-1/complete" {
			http.NotFound(writer, request)
			return
		}
		var completion completeAttemptRequest
		if err := json.NewDecoder(request.Body).Decode(&completion); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(CompleteAttemptResponse{
			SchemaVersion: protocolVersion,
			CompletionID:  completion.CompletionID,
			AcceptedAt:    time.Now().UTC().Format(time.RFC3339Nano),
			Disposition:   "accepted",
			BatchID:       "batch-1",
			BatchClosed:   true,
		})
	}))
	defer server.Close()
	configuration := config.Config{
		ServerURL:     mustParseURL(t, server.URL),
		DataDirectory: t.TempDir(),
		MaxConcurrent: 1,
		Spool:         config.SpoolConfig{MaximumBytes: 8 << 20, UploadBatch: 16},
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
	artifactSpool, err := newArtifactSpool(configuration.DataDirectory, spool.budget)
	if err != nil {
		t.Fatal(err)
	}
	supervisor := &attemptSupervisor{
		client:        client,
		identity:      Identity{RunnerID: "runner-1", Credential: "runner-credential-with-more-than-32-bytes"},
		configuration: configuration,
		store:         newAttemptStore(configuration.DataDirectory),
		logSpool:      spool,
		artifactSpool: artifactSpool,
		batches:       newBatchRegistry(configuration.DataDirectory),
		diagnostics:   os.Stderr,
	}
	claimed := testClaimedAssignment(strings.Repeat("a", 64))
	state := attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		Claimed:       claimed,
		LocalState:    "finishing",
		CompletionID:  "completion-1",
		Result:        &completionResult{Status: "succeeded", ResultCode: "TESTNG_SUCCEEDED", Summary: "passed", DurationMs: 1},
	}
	if closed := supervisor.reportCompletion(context.Background(), state); !closed {
		t.Fatal("reportCompletion() did not propagate batchClosed from the control plane")
	}
}

func TestSupervisorRemovesBatchWorkspaceAfterBatchCloses(t *testing.T) {
	inputContent := []byte("jar")
	digest := sha256.Sum256(inputContent)
	completed := make(chan struct{}, 1)
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
				claimed := testClaimedAssignment(hex.EncodeToString(digest[:]))
				claimed.Assignment.ExecutionSpec.BatchID = "batch-1"
				assignments = []ClaimedAssignment{claimed}
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
			completed <- struct{}{}
			_ = json.NewEncoder(writer).Encode(CompleteAttemptResponse{
				SchemaVersion: 1, CompletionID: completion.CompletionID,
				AcceptedAt:  time.Now().UTC().Format(time.RFC3339Nano),
				Disposition: "accepted", BatchID: "batch-1", BatchClosed: true,
			})
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
			_ = json.NewEncoder(writer).Encode(declareArtifactsResponse{SchemaVersion: 1, Artifacts: []declaredArtifact{}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	dataDirectory, err := os.MkdirTemp("/dev/shm", "autoforge-agent-batch-test-")
	if err != nil {
		t.Skipf("temporary filesystem with free capacity is unavailable: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dataDirectory) })
	classpathEntry := filepath.Join(dataDirectory, "testng.jar")
	if err := os.WriteFile(classpathEntry, []byte("offline-test-fixture"), 0o600); err != nil {
		t.Fatal(err)
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
		t.Fatal(err)
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
	case <-completed:
	case <-time.After(5 * time.Second):
		cancel()
		supervisor.Close()
		t.Fatal("timed out waiting for completed assignment")
	}
	// 批次关闭且本机无其他在途 attempt，共享目录必须在 attempt 收尾时被删除。
	batchDir := filepath.Join(dataDirectory, "work", "batches", "batch-1")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(batchDir); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			supervisor.Close()
			t.Fatalf("batch workspace %s was not removed after batch closure", batchDir)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	supervisor.Close()
}
