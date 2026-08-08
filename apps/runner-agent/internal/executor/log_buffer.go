package executor

import (
	"bytes"
	"sync"
)

type logBudget struct {
	mu        sync.Mutex
	remaining int64
	truncated bool
}

func newLogBudget(maximumBytes int64) *logBudget {
	return &logBudget{remaining: maximumBytes}
}

func (budget *logBudget) claim(requested int) int {
	budget.mu.Lock()
	defer budget.mu.Unlock()

	if budget.remaining <= 0 {
		budget.truncated = true
		return 0
	}
	accepted := requested
	if int64(accepted) > budget.remaining {
		accepted = int(budget.remaining)
		budget.truncated = true
	}
	budget.remaining -= int64(accepted)
	return accepted
}

func (budget *logBudget) wasTruncated() bool {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.truncated
}

type boundedBuffer struct {
	content bytes.Buffer
	budget  *logBudget
}

func (buffer *boundedBuffer) Write(content []byte) (int, error) {
	accepted := buffer.budget.claim(len(content))
	if accepted > 0 {
		_, _ = buffer.content.Write(content[:accepted])
	}
	return len(content), nil
}

func (buffer *boundedBuffer) String() string {
	return buffer.content.String()
}
