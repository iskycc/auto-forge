package executor

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

func TestWaitForProcessPrefersTotalDeadlineAfterOutputMovesSilencePastIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		watch := &logSilenceWatch{interval: time.Second}
		go func() {
			time.Sleep(750 * time.Millisecond)
			watch.observeOutput()
		}()
		_, termination := awaitProcessStop(ctx, nil, watch, started)
		if termination != "timeout" || time.Since(started) != 1500*time.Millisecond {
			t.Fatalf("got %s after %v; expected the total deadline", termination, time.Since(started))
		}
	})
}

func TestWaitForProcessUsesTotalDeadlineWhenSilenceTiesIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		ctx, cancel := context.WithDeadline(context.Background(), started.Add(time.Second))
		defer cancel()
		_, termination := awaitProcessStop(ctx, nil, &logSilenceWatch{interval: time.Second}, started)
		if termination != "timeout" {
			t.Fatalf("got %s; expected the total deadline", termination)
		}
	})
}

func TestWaitForProcessRemainsCancellableWithSilenceEnabled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			time.Sleep(250 * time.Millisecond)
			cancel()
		}()
		_, termination := awaitProcessStop(ctx, nil, &logSilenceWatch{interval: time.Second}, started)
		if termination != "cancelled" {
			t.Fatalf("got %s; expected cancellation", termination)
		}
	})
}
