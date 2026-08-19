package executor

import (
	"strings"
	"testing"
)

func TestStreamBufferPreservesUTF8AcrossWrites(t *testing.T) {
	budget := newLogBudget(1024)
	chunks := make([]LogChunk, 0)
	buffer := newStreamBuffer("stdout", budget, func(chunk LogChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	content := []byte("日志完成")
	for _, part := range [][]byte{content[:1], content[1:4], content[4:7], content[7:]} {
		if _, err := buffer.Write(part); err != nil {
			t.Fatalf("write stream: %v", err)
		}
	}
	if err := buffer.Close(); err != nil {
		t.Fatalf("close stream: %v", err)
	}
	combined := ""
	for index, chunk := range chunks {
		if chunk.Sequence != int64(index) {
			t.Fatalf("sequence = %d, want %d", chunk.Sequence, index)
		}
		combined += chunk.Content
	}
	if combined != string(content) {
		t.Fatalf("combined content = %q, want %q", combined, content)
	}
}

func TestStreamBufferMarksTruncationAtTheSharedByteLimit(t *testing.T) {
	budget := newLogBudget(5)
	buffer := newStreamBuffer("stderr", budget, nil)
	if _, err := buffer.Write([]byte("123456789")); err != nil {
		t.Fatal(err)
	}
	if !budget.wasTruncated() {
		t.Fatal("log budget did not report truncation")
	}
	if buffer.String() != "12345" {
		t.Fatalf("buffer content = %q, want bounded prefix", buffer.String())
	}
}

func TestStreamBufferSplitsLargeWritesIntoProtocolSizedChunks(t *testing.T) {
	content := strings.Repeat("中文日志", maxLogChunkBytes/4)
	budget := newLogBudget(int64(len(content)))
	chunks := make([]LogChunk, 0)
	buffer := newStreamBuffer("stdout", budget, func(chunk LogChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if _, err := buffer.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := buffer.Close(); err != nil {
		t.Fatal(err)
	}
	if len(chunks) < 2 {
		t.Fatalf("chunk count = %d, want more than one", len(chunks))
	}
	var combined strings.Builder
	for _, chunk := range chunks {
		if len([]byte(chunk.Content)) > maxLogChunkBytes {
			t.Fatalf("chunk bytes = %d, limit = %d", len([]byte(chunk.Content)), maxLogChunkBytes)
		}
		combined.WriteString(chunk.Content)
	}
	if combined.String() != content {
		t.Fatal("split chunks did not preserve the UTF-8 log")
	}
}
