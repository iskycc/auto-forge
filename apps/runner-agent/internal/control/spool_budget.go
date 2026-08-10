package control

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var errSpoolQuotaExceeded = errors.New("Agent spool quota exceeded")

type spoolBudget struct {
	root            string
	maximumBytes    int64
	metadataReserve int64
	mu              sync.Mutex
	usedBytes       int64
}

func newSpoolBudget(dataDirectory string, maximumBytes, metadataReserve int64) (*spoolBudget, error) {
	if maximumBytes <= 0 {
		maximumBytes = 512 << 20
	}
	root := filepath.Join(dataDirectory, "spool")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create Agent spool: %w", err)
	}
	usedBytes, err := directorySize(root)
	if err != nil {
		return nil, fmt.Errorf("measure Agent spool: %w", err)
	}
	metadataReserve = min(max(0, metadataReserve), maximumBytes/2)
	return &spoolBudget{
		root: root, maximumBytes: maximumBytes, metadataReserve: metadataReserve, usedBytes: usedBytes,
	}, nil
}

func (budget *spoolBudget) reserve(bytes int64) error {
	if budget == nil || bytes <= 0 {
		return nil
	}
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.usedBytes > budget.maximumBytes-bytes {
		return errSpoolQuotaExceeded
	}
	budget.usedBytes += bytes
	return nil
}

func (budget *spoolBudget) reservePayload(bytes int64) error {
	if budget == nil || bytes <= 0 {
		return nil
	}
	budget.mu.Lock()
	defer budget.mu.Unlock()
	payloadLimit := budget.maximumBytes - budget.metadataReserve
	if budget.usedBytes > payloadLimit-bytes {
		return errSpoolQuotaExceeded
	}
	budget.usedBytes += bytes
	return nil
}

func (budget *spoolBudget) release(bytes int64) {
	if budget == nil || bytes <= 0 {
		return
	}
	budget.mu.Lock()
	budget.usedBytes = max(0, budget.usedBytes-bytes)
	budget.mu.Unlock()
}
