package main

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// Background workers can be forcibly terminated independently of the Node process.
// A short-lived file lease prevents an orphaned compressor from surviving its worker.
func workerLeaseStatus(path string, parent int, now time.Time) error {
	if parent > 0 && os.Getppid() != parent {
		return errors.New("archive worker parent exited")
	}
	metadata, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("archive worker lease: %w", err)
	}
	if !metadata.Mode().IsRegular() || now.Sub(metadata.ModTime()) > 45*time.Second {
		return errors.New("archive worker lease expired")
	}
	return nil
}
func watchWorkerLease(path string, parent int) func() {
	if path == "" {
		return func() {}
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				if err := workerLeaseStatus(path, parent, now); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
			}
		}
	}()
	return func() { close(stop) }
}
