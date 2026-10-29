package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkerLeaseRejectsExpiredMissingOrChangedParent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease")
	now := time.Now()
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := workerLeaseStatus(path, os.Getppid(), now); err != nil {
		t.Fatal(err)
	}
	if err := workerLeaseStatus(path, os.Getppid()+123, now); err == nil {
		t.Fatal("wrong parent accepted")
	}
	if err := workerLeaseStatus(path, 0, now.Add(time.Minute)); err == nil {
		t.Fatal("expired lease accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := workerLeaseStatus(path, 0, now); err == nil {
		t.Fatal("missing lease accepted")
	}
}
