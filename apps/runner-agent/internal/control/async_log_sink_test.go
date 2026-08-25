package control

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func TestAsynchronousLogSinkBuffersAProcessWriteWhilePersistenceIsBusy(t *testing.T) {
	persistenceStarted := make(chan struct{})
	releasePersistence := make(chan struct{})
	var startOnce sync.Once
	persisted := make([]string, 0, 2)
	sink := newAsynchronousLogSink(func(chunk executor.LogChunk) error {
		startOnce.Do(func() { close(persistenceStarted) })
		<-releasePersistence
		persisted = append(persisted, chunk.Content)
		return nil
	})

	if err := sink.Write(executor.LogChunk{Stream: "stdout", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	<-persistenceStarted
	writeCompleted := make(chan error, 1)
	go func() {
		writeCompleted <- sink.Write(executor.LogChunk{Stream: "stdout", Content: "second"})
	}()
	select {
	case err := <-writeCompleted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("process log write waited for filesystem persistence")
	}

	close(releasePersistence)
	if err := sink.Close(); err != nil {
		t.Fatal(err)
	}
	if len(persisted) != 2 || persisted[0] != "first" || persisted[1] != "second" {
		t.Fatalf("persisted logs = %#v", persisted)
	}
}

func TestAsynchronousLogSinkNeverBackpressuresTheProcessWithinItsLogBudget(t *testing.T) {
	persistenceStarted := make(chan struct{})
	releasePersistence := make(chan struct{})
	var startOnce sync.Once
	persisted := 0
	sink := newAsynchronousLogSink(func(executor.LogChunk) error {
		startOnce.Do(func() { close(persistenceStarted) })
		<-releasePersistence
		persisted++
		return nil
	})

	if err := sink.Write(executor.LogChunk{Stream: "stdout", Content: "first"}); err != nil {
		t.Fatal(err)
	}
	<-persistenceStarted
	writesCompleted := make(chan error, 1)
	go func() {
		for index := 0; index < 26; index++ {
			if err := sink.Write(executor.LogChunk{Stream: "stdout", Content: "queued"}); err != nil {
				writesCompleted <- err
				return
			}
		}
		writesCompleted <- nil
	}()
	select {
	case err := <-writesCompleted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("process output was backpressured after the persistence queue filled")
	}

	close(releasePersistence)
	if err := sink.Close(); err != nil {
		t.Fatal(err)
	}
	if persisted != 27 {
		t.Fatalf("persisted chunks = %d", persisted)
	}
}

func TestAsynchronousLogSinkReportsPersistenceFailureOnClose(t *testing.T) {
	persistenceFailure := errors.New("disk unavailable")
	sink := newAsynchronousLogSink(func(executor.LogChunk) error { return persistenceFailure })
	if err := sink.Write(executor.LogChunk{Stream: "stderr", Content: "failure"}); err != nil {
		t.Fatal(err)
	}
	if err := sink.Close(); !errors.Is(err, persistenceFailure) {
		t.Fatalf("close error = %v, want persistence failure", err)
	}
}
