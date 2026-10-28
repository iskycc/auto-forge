//go:build linux

package metrics

import (
	"errors"
	"syscall"
	"testing"
)

func TestDiskCapacityUsesSpaceAvailableToAgent(t *testing.T) {
	capacity, err := diskCapacityFromStatfs("/var/lib/autoforge-agent", syscall.Statfs_t{
		Bsize: 4096, Blocks: 1000, Bfree: 300, Bavail: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Path != "/var/lib/autoforge-agent" || capacity.TotalBytes != 4096000 || capacity.AvailableBytes != 409600 {
		t.Fatalf("unexpected capacity: %+v", capacity)
	}
}

func TestDiskCapacityPreservesFullDisk(t *testing.T) {
	capacity, err := diskCapacityFromStatfs("/data", syscall.Statfs_t{Bsize: 4096, Blocks: 1000})
	if err != nil || capacity.AvailableBytes != 0 {
		t.Fatalf("full disk: %+v, %v", capacity, err)
	}
}

func TestDiskCapacityRejectsInvalidAndUnsafeStatistics(t *testing.T) {
	for _, statistics := range []syscall.Statfs_t{
		{Bsize: 0, Blocks: 100},
		{Bsize: -1, Blocks: 100},
		{Bsize: 4096, Blocks: 0},
		{Bsize: 4096, Blocks: 100, Bavail: 101},
		{Bsize: 4096, Blocks: ^uint64(0)},
	} {
		if _, err := diskCapacityFromStatfs("/data", statistics); err == nil {
			t.Errorf("accepted invalid statistics: %+v", statistics)
		}
	}
}

func TestCollectDiskCapacityReadsDataFilesystemAndReturnsErrors(t *testing.T) {
	directory := t.TempDir()
	capacity, err := CollectDiskCapacity(directory)
	if err != nil || capacity.Path != directory || capacity.TotalBytes == 0 || capacity.AvailableBytes > capacity.TotalBytes {
		t.Fatalf("filesystem capacity: %+v, %v", capacity, err)
	}
	_, err = CollectDiskCapacity(directory + "/missing")
	if !errors.Is(err, syscall.ENOENT) {
		t.Fatalf("expected original filesystem error, got %v", err)
	}
}
