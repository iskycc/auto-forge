package executor

import (
	"bytes"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
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

type streamBuffer struct {
	content  bytes.Buffer
	budget   *logBudget
	stream   string
	sink     func(LogChunk) error
	pending  []byte
	sequence int64
	err      error
}

func newStreamBuffer(stream string, budget *logBudget, sink func(LogChunk) error) *streamBuffer {
	return &streamBuffer{budget: budget, stream: stream, sink: sink}
}

func (buffer *streamBuffer) Write(content []byte) (int, error) {
	if buffer.err != nil {
		return 0, buffer.err
	}
	accepted := buffer.budget.claim(len(content))
	if accepted > 0 {
		_, _ = buffer.content.Write(content[:accepted])
		buffer.pending = append(buffer.pending, content[:accepted]...)
		if err := buffer.emitCompleteRunes(false); err != nil {
			buffer.err = err
			return 0, err
		}
	}
	return len(content), nil
}

func (buffer *streamBuffer) Close() error {
	if buffer.err != nil {
		return buffer.err
	}
	if err := buffer.emitCompleteRunes(true); err != nil {
		buffer.err = err
	}
	return buffer.err
}

func (buffer *streamBuffer) String() string {
	return buffer.content.String()
}

func (buffer *streamBuffer) emitCompleteRunes(final bool) error {
	if buffer.sink == nil || len(buffer.pending) == 0 {
		if final {
			buffer.pending = nil
		}
		return nil
	}
	consumed := 0
	for consumed < len(buffer.pending) {
		remaining := buffer.pending[consumed:]
		if !final && !utf8.FullRune(remaining) {
			break
		}
		_, size := utf8.DecodeRune(remaining)
		if size == 0 {
			break
		}
		consumed += size
	}
	if consumed == 0 {
		return nil
	}
	decoded := strings.ToValidUTF8(string(buffer.pending[:consumed]), "\uFFFD")
	buffer.pending = append(buffer.pending[:0], buffer.pending[consumed:]...)
	if decoded == "" {
		return nil
	}
	err := buffer.sink(LogChunk{
		Stream:     buffer.stream,
		Sequence:   buffer.sequence,
		Content:    decoded,
		RecordedAt: time.Now().UTC(),
	})
	if err == nil {
		buffer.sequence++
	}
	return err
}
