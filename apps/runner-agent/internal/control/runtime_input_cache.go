package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const runtimeInputRetention = 24 * time.Hour
const runtimeInputCacheMaximumBytes int64 = 32 << 30
const runtimeInputCacheMaximumEntries = 10_000

// Only compressed runtime inputs survive a batch. They are copied, not linked,
// into workspaces so a test cannot change the persistent cache via a hardlink.
type runtimeInputCache struct {
	root           string
	now            func() time.Time
	initialization sync.Mutex
	initialized    bool
	mutex          sync.Mutex
	busy           map[string]chan struct{}
	sizes          map[string]int64
	usedBytes      int64
}

type runtimeInputUsage struct {
	SchemaVersion int       `json:"schemaVersion"`
	LastUsedAt    time.Time `json:"lastUsedAt"`
}

func newRuntimeInputCache(dataDirectory string) *runtimeInputCache {
	return &runtimeInputCache{
		root:  filepath.Join(dataDirectory, "cache", "runtime-inputs", "v1"),
		now:   time.Now,
		busy:  make(map[string]chan struct{}),
		sizes: make(map[string]int64),
	}
}

func cacheableRuntimeInput(input ExecutionInput) bool {
	return input.Kind == "jdk-archive" || input.Kind == "jar-bundle"
}

func (cache *runtimeInputCache) key(input ExecutionInput) string {
	return fmt.Sprintf("%s-%d", input.SHA256, input.SizeBytes)
}

func (cache *runtimeInputCache) ready() error {
	cache.initialization.Lock()
	defer cache.initialization.Unlock()
	if cache.initialized {
		return nil
	}
	if err := os.MkdirAll(cache.root, 0o700); err != nil {
		return err
	}
	sizes := make(map[string]int64)
	var usedBytes int64
	if err := cache.walk(func(entry os.DirEntry) error {
		if !entry.IsDir() {
			return nil
		}
		stat, err := os.Lstat(filepath.Join(cache.root, entry.Name(), "archive"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if stat.Mode().IsRegular() {
			sizes[entry.Name()] = stat.Size()
			usedBytes += stat.Size()
		}
		return nil
	}); err != nil {
		return err
	}
	cache.sizes = sizes
	cache.usedBytes = usedBytes
	cache.initialized = true
	return nil
}

// A channel per active digest lets cancellation interrupt a waiter. Different
// archives download concurrently and completed lock entries are discarded.
func (cache *runtimeInputCache) acquire(ctx context.Context, key string) (func(), error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cache.mutex.Lock()
		wait, exists := cache.busy[key]
		if !exists {
			wait = make(chan struct{})
			cache.busy[key] = wait
			cache.mutex.Unlock()
			return func() {
				cache.mutex.Lock()
				delete(cache.busy, key)
				close(wait)
				cache.mutex.Unlock()
			}, nil
		}
		cache.mutex.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait:
		}
	}
}

func (cache *runtimeInputCache) materialize(ctx context.Context, client *Client, identity Identity, claimed ClaimedAssignment, input ExecutionInput, workspace string) (resultErr error) {
	if !cacheableRuntimeInput(input) {
		return downloadAttemptInput(ctx, client, identity, claimed, input, workspace)
	}
	if !sha256Pattern.MatchString(input.SHA256) || !filepath.IsLocal(input.TargetPath) || input.SizeBytes <= 0 {
		return errors.New("runtime cache input metadata is invalid")
	}
	if input.SizeBytes > claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes {
		return &executionInputDiskLimitError{requiredBytes: input.SizeBytes, limitBytes: claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes}
	}
	if err := cache.ready(); err != nil {
		return fmt.Errorf("initialize runtime input cache: %w", err)
	}
	key := cache.key(input)
	release, err := cache.acquire(ctx, key)
	if err != nil {
		return err
	}
	defer release()
	directory := filepath.Join(cache.root, key)
	cachedInput := input
	cachedInput.TargetPath = "archive"
	valid, err := cache.valid(directory, cachedInput)
	if err != nil {
		return err
	}
	if !valid {
		if err := cache.remove(key); err != nil {
			return err
		}
		available, err := availableBytes(workspace)
		if err != nil {
			return err
		}
		if input.SizeBytes > available/2 {
			return downloadAttemptInput(ctx, client, identity, claimed, input, workspace)
		}
		if !cache.reserve(key, input.SizeBytes) {
			// Capacity is a cache admission limit, never a reason to reject an execution.
			return downloadAttemptInput(ctx, client, identity, claimed, input, workspace)
		}
		published := false
		defer func() {
			if !published {
				resultErr = errors.Join(resultErr, cache.remove(key))
			}
		}()
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		if err := downloadAttemptInput(ctx, client, identity, claimed, cachedInput, directory); err != nil {
			return fmt.Errorf("download cached runtime input: %w", err)
		}
		if err := cache.touch(directory); err != nil {
			return err
		}
		published = true
	}
	available, err := availableBytes(workspace)
	if err != nil {
		return err
	}
	if input.SizeBytes > available {
		return &workspaceCapacityError{requiredBytes: input.SizeBytes, availableBytes: available}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := copyCachedArchive(ctx, filepath.Join(directory, "archive"), filepath.Join(workspace, input.TargetPath), input.SizeBytes); err != nil {
		return fmt.Errorf("copy cached runtime input: %w", err)
	}
	return cache.touch(directory)
}

func copyCachedArchive(ctx context.Context, source, destination string, size int64) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.CreateTemp(filepath.Dir(destination), ".cached-input-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	defer output.Close()
	reader := &cacheContextReader{ctx: ctx, source: io.LimitReader(input, size+1)}
	written, err := io.Copy(output, reader)
	if err != nil {
		return err
	}
	if written != size {
		return errors.New("cached runtime input size changed while copying")
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	return os.Rename(output.Name(), destination)
}

type cacheContextReader struct {
	ctx    context.Context
	source io.Reader
}

func (reader *cacheContextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(buffer)
}

func (cache *runtimeInputCache) valid(directory string, input ExecutionInput) (bool, error) {
	usage, err := cache.usage(directory)
	if err != nil {
		return false, err
	}
	if usage == nil || !cache.now().Before(usage.LastUsedAt.Add(runtimeInputRetention)) {
		return false, nil
	}
	stat, err := os.Lstat(filepath.Join(directory, "archive"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !stat.Mode().IsRegular() || stat.Size() != input.SizeBytes {
		return false, nil
	}
	return existingInputMatches(directory, input)
}

func (cache *runtimeInputCache) usage(directory string) (*runtimeInputUsage, error) {
	file, err := os.Open(filepath.Join(directory, "usage.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var usage runtimeInputUsage
	if err := json.NewDecoder(io.LimitReader(file, 1_024)).Decode(&usage); err != nil || usage.SchemaVersion != 1 || usage.LastUsedAt.IsZero() {
		return nil, nil
	}
	return &usage, nil
}

func (cache *runtimeInputCache) touch(directory string) error {
	file, err := os.CreateTemp(directory, ".usage-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(runtimeInputUsage{SchemaVersion: 1, LastUsedAt: cache.now().UTC()}); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(directory, "usage.json")); err != nil {
		return err
	}
	parent, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func (cache *runtimeInputCache) rememberUse(ctx context.Context, input ExecutionInput) error {
	if !cacheableRuntimeInput(input) {
		return nil
	}
	if err := cache.ready(); err != nil {
		return err
	}
	release, err := cache.acquire(ctx, cache.key(input))
	if err != nil {
		return err
	}
	defer release()
	directory := filepath.Join(cache.root, cache.key(input))
	usage, err := cache.usage(directory)
	if err != nil || usage == nil {
		return err
	}
	return cache.touch(directory)
}

func (cache *runtimeInputCache) reserve(key string, size int64) bool {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if size > runtimeInputCacheMaximumBytes-cache.usedBytes || len(cache.sizes) >= runtimeInputCacheMaximumEntries {
		return false
	}
	cache.sizes[key] = size
	cache.usedBytes += size
	return true
}

func (cache *runtimeInputCache) unreserve(key string) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	cache.usedBytes -= cache.sizes[key]
	delete(cache.sizes, key)
}

func (cache *runtimeInputCache) remove(key string) error {
	if err := os.RemoveAll(filepath.Join(cache.root, key)); err != nil {
		return fmt.Errorf("remove runtime cache entry: %w", err)
	}
	cache.unreserve(key)
	return nil
}

func (cache *runtimeInputCache) walk(visit func(os.DirEntry) error) error {
	directory, err := os.Open(cache.root)
	if err != nil {
		return err
	}
	defer directory.Close()
	for {
		entries, err := directory.ReadDir(64)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, entry := range entries {
			if err := visit(entry); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

func (cache *runtimeInputCache) prune(ctx context.Context) error {
	if err := cache.ready(); err != nil {
		return err
	}
	return cache.walk(func(entry os.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		// A non-blocking reservation prevents cleanup from waiting on a download.
		cache.mutex.Lock()
		if _, busy := cache.busy[entry.Name()]; busy {
			cache.mutex.Unlock()
			return nil
		}
		wait := make(chan struct{})
		cache.busy[entry.Name()] = wait
		cache.mutex.Unlock()
		defer func() {
			cache.mutex.Lock()
			delete(cache.busy, entry.Name())
			close(wait)
			cache.mutex.Unlock()
		}()
		usage, err := cache.usage(filepath.Join(cache.root, entry.Name()))
		if err != nil {
			return err
		}
		if usage == nil || !cache.now().Before(usage.LastUsedAt.Add(runtimeInputRetention)) {
			return cache.remove(entry.Name())
		}
		return nil
	})
}

func (cache *runtimeInputCache) maintain(ctx context.Context, diagnostics io.Writer) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		if err := cache.prune(ctx); err != nil && ctx.Err() == nil && diagnostics != nil {
			fmt.Fprintf(diagnostics, "prune runtime input cache: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
