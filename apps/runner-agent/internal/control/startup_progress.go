package control

import (
	"fmt"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

// Keep preparation and process creation distinct: a claimed attempt can still
// be downloading inputs, extracting its JDK or waiting for process startup.
func recordAttemptStartupStage(collector *attemptLogCollector, stage string, startedAt time.Time) error {
	now := time.Now()
	if err := collector.Write(executor.LogChunk{
		Stream:     "agent",
		Content:    fmt.Sprintf("Execution startup: phase=%s elapsedMs=%d\n", stage, now.Sub(startedAt).Milliseconds()),
		RecordedAt: now.UTC(),
	}); err != nil {
		return fmt.Errorf("record execution startup stage %s: %w", stage, err)
	}
	return nil
}
