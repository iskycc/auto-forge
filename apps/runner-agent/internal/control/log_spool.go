package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

var errLogSpoolQuotaExceeded = errSpoolQuotaExceeded

const logSpoolLockShardCount = 256

type logSpool struct {
	root         string
	retention    time.Duration
	attemptLocks [logSpoolLockShardCount]sync.Mutex
	budget       *spoolBudget
}

func newLogSpool(dataDirectory string, policy config.SpoolConfig, maximumConcurrent int) (*logSpool, error) {
	if policy.MaximumBytes == 0 {
		policy.MaximumBytes = 512 << 20
	}
	if policy.Retention == 0 {
		policy.Retention = 7 * 24 * time.Hour
	}
	root := filepath.Join(dataDirectory, "spool", "logs")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create log spool: %w", err)
	}
	if err := removeIncompleteLogChunks(root); err != nil {
		return nil, err
	}
	spool := &logSpool{root: root, retention: policy.Retention}
	if err := spool.removeExpired(time.Now().UTC()); err != nil {
		return nil, err
	}
	metadataReserve := int64(maximumConcurrent) * (2 << 20)
	budget, err := newSpoolBudget(dataDirectory, policy.MaximumBytes, metadataReserve)
	if err != nil {
		return nil, fmt.Errorf("measure log spool: %w", err)
	}
	spool.budget = budget
	return spool, nil
}

func removeIncompleteLogChunks(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) == ".json" {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove incomplete log chunk: %w", err)
		}
		return nil
	})
}

func (spool *logSpool) append(attemptID string, chunk logChunk) error {
	if !localIdentifierPattern.MatchString(attemptID) {
		return errors.New("log spool attempt identifier is invalid")
	}
	if chunk.Stream != "stdout" && chunk.Stream != "stderr" && chunk.Stream != "agent" {
		return errors.New("log spool stream is invalid")
	}
	if chunk.Sequence < 0 {
		return errors.New("log spool sequence is invalid")
	}
	payload, err := json.Marshal(chunk)
	if err != nil {
		return fmt.Errorf("encode log chunk: %w", err)
	}
	unlock := spool.lockAttempt(attemptID)
	defer unlock()
	directory := filepath.Join(spool.root, attemptID, chunk.Stream)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create log stream spool: %w", err)
	}
	path := filepath.Join(directory, fmt.Sprintf("%020d.json", chunk.Sequence))
	if existing, readErr := os.ReadFile(path); readErr == nil {
		if string(existing) != string(payload) {
			return errors.New("log spool sequence already contains different content")
		}
		return nil
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return fmt.Errorf("read existing log chunk: %w", readErr)
	}
	if err := spool.budget.reservePayload(int64(len(payload))); err != nil {
		return err
	}
	reserved := true
	defer func() {
		if reserved {
			spool.budget.release(int64(len(payload)))
		}
	}()
	temporary, err := os.CreateTemp(directory, ".chunk-*")
	if err != nil {
		return fmt.Errorf("create temporary log chunk: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect temporary log chunk: %w", err)
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return fmt.Errorf("write temporary log chunk: %w", err)
	}
	// Log chunks are atomically published for Agent-process restart recovery,
	// but deliberately do not fsync every chunk. Per-chunk durable flushes make
	// child stdout latency proportional to shared-disk latency under large
	// batches. Authoritative attempt/completion metadata keeps its stronger
	// fsync boundary; an operating-system or storage-device loss may omit only
	// the last unflushed log chunks.
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary log chunk: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish log chunk: %w", err)
	}
	reserved = false
	return nil
}

func (spool *logSpool) list(attemptID string, limit int) ([]logChunk, error) {
	if !localIdentifierPattern.MatchString(attemptID) || limit < 1 {
		return nil, errors.New("log spool list request is invalid")
	}
	unlock := spool.lockAttempt(attemptID)
	defer unlock()
	paths, err := filepath.Glob(filepath.Join(spool.root, attemptID, "*", "*.json"))
	if err != nil {
		return nil, fmt.Errorf("list log spool: %w", err)
	}
	sort.Strings(paths)
	if len(paths) > limit {
		paths = paths[:limit]
	}
	chunks := make([]logChunk, 0, len(paths))
	for _, path := range paths {
		payload, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read spooled log chunk: %w", err)
		}
		var chunk logChunk
		if err := json.Unmarshal(payload, &chunk); err != nil {
			return nil, fmt.Errorf("decode spooled log chunk: %w", err)
		}
		chunks = append(chunks, chunk)
	}
	return chunks, nil
}

func (spool *logSpool) acknowledge(attemptID string, watermark logWatermark) error {
	if !localIdentifierPattern.MatchString(attemptID) {
		return errors.New("log spool acknowledgement attempt identifier is invalid")
	}
	unlock := spool.lockAttempt(attemptID)
	defer unlock()
	for stream, sequence := range map[string]int64{
		"stdout": watermark.Stdout,
		"stderr": watermark.Stderr,
		"agent":  watermark.Agent,
	} {
		paths, err := filepath.Glob(filepath.Join(spool.root, attemptID, stream, "*.json"))
		if err != nil {
			return fmt.Errorf("list acknowledged log chunks: %w", err)
		}
		for _, path := range paths {
			var storedSequence int64
			if _, err := fmt.Sscanf(filepath.Base(path), "%d.json", &storedSequence); err != nil {
				return fmt.Errorf("parse spooled log sequence: %w", err)
			}
			if storedSequence > sequence {
				continue
			}
			info, err := os.Stat(path)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("stat acknowledged log chunk: %w", err)
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove acknowledged log chunk: %w", err)
			}
			if info != nil {
				spool.budget.release(info.Size())
			}
		}
		_ = os.Remove(filepath.Join(spool.root, attemptID, stream))
	}
	_ = os.Remove(filepath.Join(spool.root, attemptID))
	return nil
}

func (spool *logSpool) lockAttempt(attemptID string) func() {
	lock := &spool.attemptLocks[logSpoolLockIndex(attemptID)]
	lock.Lock()
	return lock.Unlock
}

func logSpoolLockIndex(attemptID string) uint32 {
	// FNV-1a provides a stable, allocation-free spread across the fixed shard
	// set. Attempts on different shards persist independently, while operations
	// for one attempt remain serialized with acknowledgement and upload reads.
	hash := uint32(2_166_136_261)
	for index := 0; index < len(attemptID); index++ {
		hash ^= uint32(attemptID[index])
		hash *= 16_777_619
	}
	return hash % logSpoolLockShardCount
}

func (spool *logSpool) removeExpired(now time.Time) error {
	return filepath.WalkDir(spool.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().Before(now.Add(-spool.retention)) {
			relative, err := filepath.Rel(spool.root, path)
			if err != nil {
				return err
			}
			parts := strings.Split(filepath.ToSlash(relative), "/")
			if len(parts) > 0 {
				attemptStatePath := filepath.Join(filepath.Dir(spool.root), "attempts", parts[0]+".json")
				if _, err := os.Stat(attemptStatePath); err == nil {
					return nil
				} else if !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
			return os.Remove(path)
		}
		return nil
	})
}

func directorySize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}
