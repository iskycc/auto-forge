package control

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

const (
	maximumLogChunkBytes = 256 << 10
	credentialCarryBytes = 512
)

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}`),
	regexp.MustCompile(`(?i)\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+`),
	regexp.MustCompile(`\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`),
}

type attemptLogCollector struct {
	attemptID string
	spool     *logSpool
	secrets   []string
	carrySize int
	mu        sync.Mutex
	pending   map[string]string
	sequence  map[string]int64
}

func newAttemptLogCollector(attemptID string, spool *logSpool, environment []EnvironmentEntry) *attemptLogCollector {
	secrets := make([]string, 0)
	carrySize := credentialCarryBytes
	for _, entry := range environment {
		if !entry.Secret || entry.Value == "" {
			continue
		}
		secrets = append(secrets, entry.Value)
		carrySize = max(carrySize, len(entry.Value)-1)
	}
	sort.Slice(secrets, func(left, right int) bool { return len(secrets[left]) > len(secrets[right]) })
	return &attemptLogCollector{
		attemptID: attemptID,
		spool:     spool,
		secrets:   secrets,
		carrySize: carrySize,
		pending:   make(map[string]string),
		sequence:  map[string]int64{"stdout": 0, "stderr": 0, "agent": 0},
	}
}

func (collector *attemptLogCollector) Write(chunk executor.LogChunk) error {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	collector.pending[chunk.Stream] += chunk.Content
	return collector.flushStream(chunk.Stream, chunk.RecordedAt.UTC().Format(time.RFC3339Nano), false)
}

func (collector *attemptLogCollector) Close(recordedAt string) error {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	for _, stream := range []string{"stdout", "stderr", "agent"} {
		if err := collector.flushStream(stream, recordedAt, true); err != nil {
			return err
		}
	}
	return nil
}

func (collector *attemptLogCollector) flushStream(stream, recordedAt string, final bool) error {
	content := collector.pending[stream]
	readyBytes := len(content)
	if !final {
		readyBytes = max(0, readyBytes-collector.carrySize)
		readyBytes = safeRedactionBoundary(content, readyBytes, collector.secrets)
	}
	for readyBytes > 0 {
		chunkBytes := min(readyBytes, maximumLogChunkBytes)
		chunkBytes = safeRedactionBoundary(content, chunkBytes, collector.secrets)
		for chunkBytes > 0 && chunkBytes < len(content) && (content[chunkBytes]&0xC0) == 0x80 {
			chunkBytes--
		}
		if chunkBytes == 0 {
			break
		}
		plain := content[:chunkBytes]
		content = content[chunkBytes:]
		readyBytes -= chunkBytes
		chunk := logChunk{
			Stream:     stream,
			Sequence:   collector.sequence[stream],
			Content:    redactAgentLog(plain, collector.secrets),
			RecordedAt: recordedAt,
		}
		if err := collector.spool.append(collector.attemptID, chunk); err != nil {
			return err
		}
		collector.sequence[stream]++
	}
	collector.pending[stream] = content
	return nil
}

func safeRedactionBoundary(content string, boundary int, secrets []string) int {
	if boundary <= 0 || boundary >= len(content) {
		return boundary
	}
	safe := boundary
	for _, secret := range secrets {
		firstStart := max(0, boundary-len(secret)+1)
		for start := firstStart; start < boundary; start++ {
			available := min(len(secret), len(content)-start)
			if available > 0 && strings.HasPrefix(secret, content[start:start+available]) {
				safe = min(safe, start)
			}
		}
	}
	markerWindowStart := max(0, boundary-credentialCarryBytes)
	lower := strings.ToLower(content[markerWindowStart:boundary])
	for _, marker := range []string{"bearer ", "password=", "password:", "token=", "token:", "secret=", "secret:", "api_key=", "api-key="} {
		if index := strings.LastIndex(lower, marker); index >= 0 {
			absolute := markerWindowStart + index
			if absolute < boundary && !strings.ContainsAny(content[absolute:boundary], "\r\n,;") {
				safe = min(safe, absolute)
			}
		}
	}
	return safe
}

func redactAgentLog(content string, secrets []string) string {
	redacted := content
	for _, secret := range secrets {
		redacted = strings.ReplaceAll(redacted, secret, "[REDACTED]")
	}
	for _, pattern := range credentialPatterns {
		redacted = pattern.ReplaceAllString(redacted, "[REDACTED]")
	}
	return redacted
}
