package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientAnchorsClaimAndRenewalToPlatformTime(t *testing.T) {
	for _, offset := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
		t.Run(offset.String(), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				serverTime := time.Now().Add(offset)
				expiresAt := serverTime.Add(45 * time.Second).Format(time.RFC3339Nano)
				writer.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(request.URL.Path, "/claims") {
					var claim claimRequest
					if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
						t.Error(err)
						return
					}
					_ = json.NewEncoder(writer).Encode(ClaimResponse{SchemaVersion: 1, RequestID: claim.RequestID, RetryAfterMs: 100, Assignments: []ClaimedAssignment{{Lease: Lease{LeaseID: "lease-1", Token: "lease-token", Version: 1, ExpiresAt: expiresAt, ServerTime: serverTime.Format(time.RFC3339Nano)}}}})
					return
				}
				_ = json.NewEncoder(writer).Encode(RenewLeaseResponse{SchemaVersion: 1, AcceptedAt: serverTime.Format(time.RFC3339Nano), ServerTime: serverTime.Format(time.RFC3339Nano), LeaseVersion: 2, ExpiresAt: expiresAt, Instruction: "continue"})
			}))
			defer server.Close()
			configuration := testConfiguration(t, server.URL)
			client, err := NewClient(configuration)
			if err != nil {
				t.Fatal(err)
			}
			identity := Identity{RunnerID: "runner-1", Credential: "runner-credential"}
			before := time.Now()
			claimed, err := client.Claim(context.Background(), identity, configuration, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			lease := claimed.Assignments[0].Lease
			if lease.LocalDeadline.Before(before.Add(45*time.Second)) || lease.LocalDeadline.After(time.Now().Add(45*time.Second)) {
				t.Fatal("claim used the agent's wall clock")
			}
			before = time.Now()
			renewed, err := client.RenewLease(context.Background(), identity, lease)
			if err != nil {
				t.Fatal(err)
			}
			if renewed.LocalDeadline.Before(before.Add(45*time.Second)) || renewed.LocalDeadline.After(time.Now().Add(45*time.Second)) {
				t.Fatal("renewal used the agent's wall clock")
			}
		})
	}
}

func TestLeaseDeadlineUsesServerTimeDespiteTenMinuteHostSkew(t *testing.T) {
	for _, skew := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
		requestedAt := time.Now()
		serverTime := requestedAt.Add(skew)
		deadline, err := leaseDeadline(serverTime.Add(45*time.Second).Format(time.RFC3339Nano), serverTime.Format(time.RFC3339Nano), requestedAt)
		if err != nil || deadline.Sub(requestedAt) != 45*time.Second {
			t.Fatalf("skew %s: deadline = %s, err = %v", skew, deadline, err)
		}
		if deadline.Sub(requestedAt.Add(3*time.Second)) != 42*time.Second {
			t.Fatal("network delay extended the lease")
		}
	}
}

func TestLeaseDeadlineRejectsInvalidAuthorityAndDoesNotPersistMonotonicState(t *testing.T) {
	now := time.Now()
	if _, err := leaseDeadline(now.Format(time.RFC3339Nano), "invalid", now); err == nil {
		t.Fatal("accepted malformed server time")
	}
	deadline, err := leaseDeadline(now.Add(time.Minute).Format(time.RFC3339Nano), "", now)
	if err != nil || !deadline.Equal(now.Add(time.Minute)) {
		t.Fatal("old server fallback failed")
	}
	encoded, err := json.Marshal(Lease{ExpiresAt: now.Format(time.RFC3339Nano), LocalDeadline: now.Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	var restored Lease
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	if !restored.LocalDeadline.IsZero() {
		t.Fatal("restart reused a stale monotonic deadline")
	}
}
