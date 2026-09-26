package control

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRuntimeCacheOutlivesClosedBatches(t *testing.T) {
	input, _ := batchTestInput([]byte("bundle"))
	input.Kind = "jar-bundle"
	server, downloads := batchDownloadServer(t, []byte("bundle"))
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	root := t.TempDir()
	for _, batchID := range []string{"first-batch", "rerun-batch"} {
		registry := newBatchRegistry(root)
		if err := registry.acquire(batchID); err != nil {
			t.Fatal(err)
		}
		claimed := batchClaimedAssignment("attempt", batchID, input)
		if _, err := registry.ensureBatchInputs(context.Background(), client, Identity{}, claimed, []ExecutionInput{input}, false); err != nil {
			t.Fatal(err)
		}
		registry.release(batchID, true, nil)
		if _, err := os.Stat(registry.directory(batchID)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("batch workspace retained: %v", err)
		}
	}
	if downloads.Load() != 1 {
		t.Fatalf("downloads across closed batches = %d", downloads.Load())
	}
}

func TestRuntimeCacheCancelledWaiterAndCleanupDoNotInterruptActiveUse(t *testing.T) {
	cache := newRuntimeInputCache(t.TempDir())
	if err := cache.ready(); err != nil {
		t.Fatal(err)
	}
	input, _ := batchTestInput([]byte("bundle"))
	key := cache.key(input)
	if err := os.MkdirAll(filepath.Join(cache.root, key), 0o700); err != nil {
		t.Fatal(err)
	}
	release, err := cache.acquire(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.acquire(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait = %v", err)
	}
	if err := cache.prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cache.root, key)); err != nil {
		t.Fatalf("cleanup removed active download: %v", err)
	}
	release()
	if err := cache.prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cache.root, key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial download retained: %v", err)
	}
}

func TestRuntimeInputCacheSurvivesRestartAndExtendsExpiry(t *testing.T) {
	content := []byte("complete dependency bundle")
	input, _ := batchTestInput(content)
	input.Kind = "jar-bundle"
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	root := t.TempDir()
	now := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	use := func(cache *runtimeInputCache) {
		t.Helper()
		cache.now = func() time.Time { return now }
		workspace := t.TempDir()
		if err := cache.materialize(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, workspace); err != nil {
			t.Fatal(err)
		}
		actual, err := os.ReadFile(filepath.Join(workspace, input.TargetPath))
		if err != nil || string(actual) != string(content) {
			t.Fatalf("materialized %q: %v", actual, err)
		}
		// A test process must not be able to mutate the persistent archive through a hardlink.
		if err := os.WriteFile(filepath.Join(workspace, input.TargetPath), []byte("changed"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	use(newRuntimeInputCache(root))
	now = now.Add(23 * time.Hour)
	use(newRuntimeInputCache(root))
	now = now.Add(23 * time.Hour)
	restarted := newRuntimeInputCache(root)
	use(restarted)
	if downloads.Load() != 1 {
		t.Fatalf("warm downloads = %d", downloads.Load())
	}
	now = now.Add(24 * time.Hour)
	if err := restarted.prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	use(restarted)
	if downloads.Load() != 2 {
		t.Fatalf("expired downloads = %d", downloads.Load())
	}
}

func TestRuntimeInputCacheCoalescesConcurrentBatchesAndRepairsCorruption(t *testing.T) {
	content := []byte("shared runtime")
	input, _ := batchTestInput(content)
	input.Kind = "jdk-archive"
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cache := newRuntimeInputCache(t.TempDir())
	var group sync.WaitGroup
	errors := make(chan error, 8)
	for range 8 {
		workspace := t.TempDir()
		group.Go(func() {
			errors <- cache.materialize(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, workspace)
		})
	}
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if downloads.Load() != 1 {
		t.Fatalf("concurrent downloads = %d", downloads.Load())
	}
	if err := os.WriteFile(filepath.Join(cache.root, cache.key(input), "archive"), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cache.materialize(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 2 {
		t.Fatalf("repair downloads = %d", downloads.Load())
	}
}

func TestDownloadURLInputsUseAuthenticatedControlPlane(t *testing.T) {
	content := []byte("proxied bundle")
	input, _ := batchTestInput(content)
	input.DownloadURL = "http://127.0.0.1:1/must-not-contact"
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := downloadAttemptInput(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 1 {
		t.Fatalf("platform downloads = %d", downloads.Load())
	}
}

func TestRuntimeCacheCapacityDoesNotRejectExecution(t *testing.T) {
	content := []byte("bundle exceeding available cache admission budget")
	input, _ := batchTestInput(content)
	input.Kind = "jar-bundle"
	server, downloads := batchDownloadServer(t, content)
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cache := newRuntimeInputCache(t.TempDir())
	if err := cache.ready(); err != nil {
		t.Fatal(err)
	}
	cache.usedBytes = runtimeInputCacheMaximumBytes
	for range 2 {
		workspace := t.TempDir()
		if err := cache.materialize(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, workspace); err != nil {
			t.Fatal(err)
		}
		actual, err := os.ReadFile(filepath.Join(workspace, input.TargetPath))
		if err != nil || string(actual) != string(content) {
			t.Fatalf("uncached input %q: %v", actual, err)
		}
	}
	if downloads.Load() != 2 {
		t.Fatalf("uncached downloads = %d", downloads.Load())
	}
}

func TestRuntimeCacheDoesNotPublishFailedDownloads(t *testing.T) {
	input, _ := batchTestInput([]byte("expected"))
	input.Kind = "jar-bundle"
	server, _ := batchDownloadServer(t, []byte("corrupt!"))
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cache := newRuntimeInputCache(t.TempDir())
	if err := cache.materialize(context.Background(), client, Identity{}, batchClaimedAssignment("attempt", "batch", input), input, t.TempDir()); err == nil {
		t.Fatal("expected checksum rejection")
	}
	entries, err := os.ReadDir(cache.root)
	if err != nil || len(entries) != 0 || cache.usedBytes != 0 {
		t.Fatalf("failed download retained cache: %v, bytes %d, error %v", entries, cache.usedBytes, err)
	}
}
