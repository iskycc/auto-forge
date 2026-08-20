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

type executionInputDiskLimitError struct {
	requiredBytes int64
	limitBytes    int64
}

func (failure *executionInputDiskLimitError) Error() string {
	return fmt.Sprintf(
		"execution inputs require %d bytes and exceed the attempt disk limit of %d bytes",
		failure.requiredBytes,
		failure.limitBytes,
	)
}

type workspaceCapacityError struct {
	requiredBytes  int64
	availableBytes int64
}

func (failure *workspaceCapacityError) Error() string {
	return fmt.Sprintf(
		"Runner workspace disk requires %d bytes for execution inputs but only %d bytes are available",
		failure.requiredBytes,
		failure.availableBytes,
	)
}

func downloadAttemptInputs(
	ctx context.Context,
	client *Client,
	identity Identity,
	claimed ClaimedAssignment,
	inputs []ExecutionInput,
	workspace string,
) error {
	var totalBytes int64
	for _, input := range inputs {
		if input.SizeBytes <= 0 || totalBytes > claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes-input.SizeBytes {
			return &executionInputDiskLimitError{
				requiredBytes: totalBytes + max(input.SizeBytes, 0),
				limitBytes:    claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes,
			}
		}
		totalBytes += input.SizeBytes
	}
	available, err := availableBytes(workspace)
	if err != nil {
		return fmt.Errorf("inspect available workspace capacity: %w", err)
	}
	if totalBytes > available {
		return &workspaceCapacityError{requiredBytes: totalBytes, availableBytes: available}
	}
	for _, input := range inputs {
		if err := downloadAttemptInput(ctx, client, identity, claimed, input, workspace); err != nil {
			return fmt.Errorf("download execution input %s: %w", input.InputID, err)
		}
	}
	return nil
}

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
		return &executionInputDiskLimitError{
			requiredBytes: input.SizeBytes,
			limitBytes:    claimed.Assignment.ExecutionSpec.ResourceLimits.DiskBytes,
		}
	}
	available, err := availableBytes(workspace)
	if err != nil {
		return fmt.Errorf("inspect available workspace capacity: %w", err)
	}
	if input.SizeBytes > available {
		return &workspaceCapacityError{requiredBytes: input.SizeBytes, availableBytes: available}
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
	var downloadErr error
	if input.DownloadURL != "" {
		downloadErr = client.DownloadExternalResource(
			ctx,
			input.DownloadURL,
			input.SizeBytes,
			io.MultiWriter(temporary, digest),
		)
	} else {
		downloadErr = client.DownloadInput(
			ctx,
			identity,
			claimed.Assignment.AttemptID,
			claimed.Lease,
			input,
			io.MultiWriter(temporary, digest),
		)
	}
	if downloadErr != nil {
		temporary.Close()
		return downloadErr
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
