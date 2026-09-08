package io.autoforge.jenkins.execution;

import java.io.Serial;
import java.io.Serializable;
import java.util.concurrent.TimeUnit;

/** Wakes polling without interrupting an in-flight batch creation or termination request. */
final class AutoForgeRunCancellation implements Serializable {
    @Serial private static final long serialVersionUID = 1L;
    private boolean requested;

    synchronized void request() {
        requested = true;
        notifyAll();
    }

    synchronized boolean isRequested() { return requested; }

    synchronized void awaitNextPoll(long millis) throws InterruptedException {
        long remainingNanos = TimeUnit.MILLISECONDS.toNanos(millis);
        long started = System.nanoTime();
        while (!requested && remainingNanos > 0) {
            TimeUnit.NANOSECONDS.timedWait(this, remainingNanos);
            remainingNanos = TimeUnit.MILLISECONDS.toNanos(millis) - (System.nanoTime() - started);
        }
    }
}
