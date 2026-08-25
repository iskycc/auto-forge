package control

import (
	"errors"
	"sync"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

var errAsynchronousLogSinkClosed = errors.New("asynchronous log sink is closed")

// asynchronousLogSink keeps filesystem and network latency out of the child
// process stdout/stderr copy goroutines. executor.Run already enforces the
// attempt log byte budget before invoking Write, so this queue is bounded by
// that authoritative limit without ever feeding disk latency back into Java.
type asynchronousLogSink struct {
	write func(executor.LogChunk) error
	done  chan struct{}

	closeOnce sync.Once
	condition *sync.Cond
	queue     []executor.LogChunk
	closed    bool
	err       error
}

func newAsynchronousLogSink(write func(executor.LogChunk) error) *asynchronousLogSink {
	sink := &asynchronousLogSink{
		write: write,
		done:  make(chan struct{}),
		queue: make([]executor.LogChunk, 0, 16),
	}
	sink.condition = sync.NewCond(&sync.Mutex{})
	go sink.persist()
	return sink
}

func (sink *asynchronousLogSink) Write(chunk executor.LogChunk) error {
	sink.condition.L.Lock()
	defer sink.condition.L.Unlock()
	if sink.closed {
		return errAsynchronousLogSinkClosed
	}
	sink.queue = append(sink.queue, chunk)
	sink.condition.Signal()
	return nil
}

func (sink *asynchronousLogSink) Close() error {
	sink.closeOnce.Do(func() {
		sink.condition.L.Lock()
		sink.closed = true
		sink.condition.Broadcast()
		sink.condition.L.Unlock()
	})
	<-sink.done
	sink.condition.L.Lock()
	defer sink.condition.L.Unlock()
	return sink.err
}

func (sink *asynchronousLogSink) persist() {
	defer close(sink.done)
	for {
		sink.condition.L.Lock()
		for len(sink.queue) == 0 && !sink.closed {
			sink.condition.Wait()
		}
		if len(sink.queue) == 0 {
			sink.condition.L.Unlock()
			return
		}
		chunk := sink.queue[0]
		sink.queue[0] = executor.LogChunk{}
		sink.queue = sink.queue[1:]
		persistenceFailed := sink.err != nil
		sink.condition.L.Unlock()

		if persistenceFailed {
			continue
		}
		if err := sink.write(chunk); err != nil {
			sink.condition.L.Lock()
			sink.err = err
			sink.condition.L.Unlock()
		}
	}
}
