package control

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
)

func TestEnsureIdentityAcceptedKeepsValidIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/runner-agents/runner-1/heartbeat" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"schemaVersion": 1, "acceptedAt": "2026-08-09T00:00:00.000Z",
			"heartbeatIntervalSeconds": 20, "draining": false, "rotateCredential": false,
		})
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	store := NewIdentityStore(t.TempDir())
	identity := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-1", Credential: "valid-credential-with-more-than-32-bytes", ServerURL: server.URL}

	result, interval, err := ensureIdentityAccepted(context.Background(), client, store, identity, configuration, buildinfo.Info{Version: "0.3.0"}, io.Discard)
	if err != nil {
		t.Fatalf("ensureIdentityAccepted() error = %v", err)
	}
	if result != identity {
		t.Fatalf("identity changed: got %#v, want %#v", result, identity)
	}
	if interval.Seconds() != 20 {
		t.Fatalf("interval = %v, want 20s", interval)
	}
}

func TestEnsureIdentityAcceptedReRegistersWhenCredentialRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/runner-old/heartbeat":
			writer.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"error": map[string]any{"code": "RUNNER_AUTH_REJECTED", "message": "执行机已注销，凭据已失效。"},
			})
		case "/api/v1/runner-agents/register":
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"schemaVersion": 1, "runnerId": "runner-new",
				"credential": "new-credential-with-more-than-32-bytes", "heartbeatIntervalSeconds": 15,
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	store := NewIdentityStore(t.TempDir())
	stale := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-old", Credential: "stale-credential-with-more-than-32-bytes", ServerURL: server.URL}
	if err := store.Save(stale); err != nil {
		t.Fatal(err)
	}

	result, _, err := ensureIdentityAccepted(context.Background(), client, store, stale, configuration, buildinfo.Info{Version: "0.3.0"}, io.Discard)
	if err != nil {
		t.Fatalf("ensureIdentityAccepted() error = %v", err)
	}
	if result.RunnerID != "runner-new" {
		t.Fatalf("RunnerID = %q, want runner-new", result.RunnerID)
	}
	// 旧身份必须已被删除并替换为新身份。
	persisted, exists, loadErr := store.Load()
	if loadErr != nil || !exists {
		t.Fatalf("store.Load() = %v, %v, %v", persisted, exists, loadErr)
	}
	if persisted.RunnerID != "runner-new" {
		t.Fatalf("persisted RunnerID = %q, want runner-new", persisted.RunnerID)
	}
}

func TestEnsureIdentityAcceptedFailsWithoutBootstrapToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"error": map[string]any{"code": "RUNNER_AUTH_REJECTED", "message": "执行机已注销，凭据已失效。"},
		})
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	configuration.BootstrapToken = ""
	configuration.HasBootstrap = false
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	store := NewIdentityStore(t.TempDir())
	stale := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-old", Credential: "stale-credential-with-more-than-32-bytes", ServerURL: server.URL}

	_, _, err = ensureIdentityAccepted(context.Background(), client, store, stale, configuration, buildinfo.Info{Version: "0.3.0"}, io.Discard)
	if err == nil {
		t.Fatal("ensureIdentityAccepted() succeeded without a bootstrap token")
	}
	if !strings.Contains(err.Error(), "bootstrap token") {
		t.Fatalf("error = %v, want bootstrap token hint", err)
	}
}

func TestEnsureIdentityAcceptedToleratesTransientErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatal(err)
	}
	store := NewIdentityStore(t.TempDir())
	identity := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-1", Credential: "valid-credential-with-more-than-32-bytes", ServerURL: server.URL}

	result, interval, err := ensureIdentityAccepted(context.Background(), client, store, identity, configuration, buildinfo.Info{Version: "0.3.0"}, io.Discard)
	if err != nil {
		t.Fatalf("ensureIdentityAccepted() error = %v", err)
	}
	if result != identity {
		t.Fatalf("identity changed on transient error: got %#v", result)
	}
	if interval.Seconds() != 15 {
		t.Fatalf("interval = %v, want default 15s", interval)
	}
}

func TestIdentityStoreRemoveDeletesCredentials(t *testing.T) {
	store := NewIdentityStore(t.TempDir())
	identity := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-1", Credential: "secret", ServerURL: "https://autoforge.internal"}
	if err := store.Save(identity); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if _, exists, err := store.Load(); err != nil || exists {
		t.Fatalf("Load() after Remove() = exists=%v err=%v, want not found", exists, err)
	}
	// 重复删除不应报错。
	if err := store.Remove(); err != nil {
		t.Fatalf("second Remove() error = %v", err)
	}
}
