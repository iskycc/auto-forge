package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"syscall"
)

func downloadAttemptInput(
	ctx context.Context,
	client *Client,
	identity Identity,
	claimed ClaimedAssignment,
	input ExecutionInput,
	workspace string,
) error {
	if !filepath.IsLocal(input.TargetPath) || input.SizeBytes <= 0 {
		return errors.New("execution input path or size is invalid")
	}
	if input.SizeBytes > claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes {
		return errors.New("execution input exceeds the attempt disk limit")
	}
	available, err := availableBytes(workspace)
	if err != nil {
		return fmt.Errorf("inspect available workspace capacity: %w", err)
	}
	if input.SizeBytes > available {
		return fmt.Errorf("execution input requires %d bytes but only %d bytes are available", input.SizeBytes, available)
	}
	destination := filepath.Join(workspace, filepath.Clean(input.TargetPath))
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("prepare input directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".input-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary input: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary input: %w", err)
	}
	digest := sha256.New()
	if err := client.DownloadInput(ctx, identity, claimed.Assignment.AttemptID, claimed.Lease, input, io.MultiWriter(temporary, digest)); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync execution input: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close execution input: %w", err)
	}
	actualDigest := hex.EncodeToString(digest.Sum(nil))
	if actualDigest != input.SHA256 {
		return fmt.Errorf("execution input SHA-256 mismatch: received %s", actualDigest)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("publish execution input: %w", err)
	}
	return nil
}

func availableBytes(path string) (int64, error) {
	var statistics syscall.Statfs_t
	if err := syscall.Statfs(path, &statistics); err != nil {
		return 0, err
	}
	availableBlocks := uint64(statistics.Bavail)
	blockSize := uint64(statistics.Bsize)
	if blockSize == 0 {
		return 0, errors.New("filesystem reported a zero block size")
	}
	if availableBlocks > uint64(math.MaxInt64)/blockSize {
		return math.MaxInt64, nil
	}
	return int64(availableBlocks * blockSize), nil
}
