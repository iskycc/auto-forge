package executor

import (
	"context"
	"errors"
	"sync"
	"time"
)

const LogSilenceTermination = "log_silence_timeout"

type logSilenceWatch struct {
	interval time.Duration
	mutex    sync.Mutex
	last     time.Time
}

func (watch *logSilenceWatch) observeOutput() {
	watch.mutex.Lock()
	watch.last = time.Now()
	watch.mutex.Unlock()
}

func (watch *logSilenceWatch) deadline(started time.Time) time.Time {
	watch.mutex.Lock()
	defer watch.mutex.Unlock()
	if watch.last.After(started) {
		return watch.last.Add(watch.interval)
	}
	return started.Add(watch.interval)
}

func awaitProcessStop(ctx context.Context, wait <-chan error, watch *logSilenceWatch, started time.Time) (error, string) {
	var silence <-chan time.Time
	var timer *time.Timer
	deadline, hasDeadline := ctx.Deadline()
	if watch != nil {
		timer = time.NewTimer(time.Until(watch.deadline(started)))
		defer timer.Stop()
		silence = timer.C
	}
	for {
		select {
		case err := <-wait:
			return err, "completed"
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, "timeout"
			}
			return nil, "cancelled"
		case <-silence:
			// A final write may have advanced the deadline while the timer was queued.
			// Once the total deadline is earlier (or tied), it always owns termination.
			next := watch.deadline(started)
			if ctx.Err() != nil || (hasDeadline && (!next.Before(deadline) || !time.Now().Before(deadline))) {
				silence = nil
				continue
			}
			if remaining := time.Until(next); remaining > 0 {
				timer.Reset(remaining)
				continue
			}
			select {
			case err := <-wait:
				return err, "completed"
			default:
				return nil, LogSilenceTermination
			}
		}
	}
}
