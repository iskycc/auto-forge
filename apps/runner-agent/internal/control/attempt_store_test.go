package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttemptStorePersistsLeaseCredentialsPrivatelyAndRemovesAcknowledgedState(t *testing.T) {
	store := newAttemptStore(t.TempDir())
	state := attemptState{
		SchemaVersion: attemptStateSchemaVersion,
		LocalState:    "running",
		Process:       &attemptProcess{ProcessID: 1234, StartTimeTicks: 5678},
		Claimed: ClaimedAssignment{
			Assignment: Assignment{AttemptID: "attempt-1"},
			Lease:      Lease{LeaseID: "lease-1", Token: "secret"},
		},
		CompletionID: "completion-1",
		Result: &completionResult{
			Status: "succeeded", ResultCode: "TESTNG_SUCCEEDED", Summary: "passed", DurationMs: 1,
		},
		ArtifactUploads: []artifactUploadState{{
			Artifact: artifactDeclaration{ArtifactID: "artifact-1", SizeBytes: 10, SHA256: strings.Repeat("a", 64)},
		}},
	}
	if err := store.save(state); err != nil {
		t.Fatalf("save() error = %v", err)
	}
	info, err := os.Stat(store.path("attempt-1"))
	if err != nil {
		t.Fatalf("stat attempt state: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("attempt state permissions = %o, want 600", info.Mode().Perm())
	}
	states, err := store.list()
	if err != nil || len(states) != 1 || states[0].Claimed.Lease.Token != "secret" || len(states[0].ArtifactUploads) != 1 || states[0].Process == nil || states[0].Process.StartTimeTicks != 5678 {
		t.Fatalf("list() = %#v, %v", states, err)
	}
	if err := store.remove("attempt-1"); err != nil {
		t.Fatalf("remove() error = %v", err)
	}
	states, err = store.list()
	if err != nil || len(states) != 0 {
		t.Fatalf("list() after remove = %#v, %v", states, err)
	}
}

func TestAttemptStoreReadsLegacyStateWithoutProcessIdentity(t *testing.T) {
	store := newAttemptStore(t.TempDir())
	if err := os.MkdirAll(store.directory, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := attemptState{
		SchemaVersion: legacyAttemptStateSchemaVersion,
		LocalState:    "running",
		Claimed: ClaimedAssignment{
			Assignment: Assignment{AttemptID: "attempt-legacy"},
		},
	}
	payload, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.directory, "attempt-legacy.json")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	states, err := store.list()
	if err != nil || len(states) != 1 {
		t.Fatalf("list() legacy state = %#v, %v", states, err)
	}
	if states[0].SchemaVersion != attemptStateSchemaVersion || states[0].Process != nil {
		t.Fatalf("normalized legacy state = %#v", states[0])
	}
}
