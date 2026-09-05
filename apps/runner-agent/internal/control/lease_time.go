package control

import (
	"fmt"
	"time"
)

// Subtract the entire request time conservatively. The resulting deadline retains
// Go's monotonic reading, so later host clock changes cannot extend execution rights.
func leaseDeadline(expiresAt, serverTime string, requestedAt time.Time) (time.Time, error) {
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid lease expiration: %w", err)
	}
	if serverTime == "" {
		return expires, nil
	}
	authority, err := time.Parse(time.RFC3339Nano, serverTime)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid lease server time: %w", err)
	}
	remaining := expires.Sub(authority)
	if remaining > 5*time.Minute {
		return time.Time{}, fmt.Errorf("lease remaining lifetime exceeds five minutes: %s", remaining)
	}
	return requestedAt.Add(remaining), nil
}

func (lease Lease) deadline() (time.Time, error) {
	if !lease.LocalDeadline.IsZero() {
		return lease.LocalDeadline, nil
	}
	// Adjacent old control planes omit serverTime; retain their original behavior.
	return time.Parse(time.RFC3339Nano, lease.ExpiresAt)
}
