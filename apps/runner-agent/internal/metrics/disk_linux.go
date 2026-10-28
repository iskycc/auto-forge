//go:build linux

package metrics

import (
	"errors"
	"fmt"
	"syscall"
)

// DiskCapacity describes the filesystem holding Agent work, cache and spool.
type DiskCapacity struct {
	Path           string `json:"path"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
}

func CollectDiskCapacity(dataDirectory string) (DiskCapacity, error) {
	var statistics syscall.Statfs_t
	if err := syscall.Statfs(dataDirectory, &statistics); err != nil {
		return DiskCapacity{}, fmt.Errorf("read Agent data filesystem capacity %q: %w", dataDirectory, err)
	}
	return diskCapacityFromStatfs(dataDirectory, statistics)
}

func diskCapacityFromStatfs(path string, statistics syscall.Statfs_t) (DiskCapacity, error) {
	if statistics.Bsize <= 0 || statistics.Blocks == 0 || statistics.Bavail > statistics.Blocks {
		return DiskCapacity{}, errors.New("Agent data filesystem reported invalid capacity")
	}
	// Heartbeat numbers must round-trip exactly through JavaScript. Check before
	// multiplication so a corrupt or oversized filesystem cannot overflow.
	const maximumSafeInteger = uint64(1<<53 - 1)
	blockSize := uint64(statistics.Bsize)
	if statistics.Blocks > maximumSafeInteger/blockSize {
		return DiskCapacity{}, errors.New("Agent data filesystem capacity exceeds protocol safe integer range")
	}
	return DiskCapacity{
		Path:       path,
		TotalBytes: statistics.Blocks * blockSize,
		// Bavail excludes blocks reserved for other users; Bfree can overstate
		// the space the Agent service account may actually write.
		AvailableBytes: statistics.Bavail * blockSize,
	}, nil
}
