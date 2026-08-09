package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/metrics"
)

func TestClientRegistersAndSendsAuthenticatedHeartbeat(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/runner-agents/register":
			if request.Header.Get("Authorization") != "Bearer bootstrap-secret" {
				t.Errorf("registration Authorization = %q", request.Header.Get("Authorization"))
			}
			json.NewEncoder(writer).Encode(map[string]any{
				"schemaVersion": 1, "runnerId": "runner-1", "credential": "runner-credential-with-more-than-32-bytes", "heartbeatIntervalSeconds": 15,
			})
		case "/api/v1/runner-agents/runner-1/heartbeat":
			if request.Header.Get("Authorization") != "Bearer runner-credential-with-more-than-32-bytes" {
				t.Errorf("heartbeat Authorization = %q", request.Header.Get("Authorization"))
			}
			json.NewEncoder(writer).Encode(map[string]any{
				"schemaVersion": 1, "acceptedAt": "2026-08-09T00:00:00.000Z", "heartbeatIntervalSeconds": 15, "draining": false,
			})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	identity, _, err := client.Register(context.Background(), configuration, buildinfo.Info{Version: "0.2.0"})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	snapshot := &metrics.Snapshot{CPUUtilizationPercent: 20, MemoryUtilizationPercent: 30, LoadAverage1m: 0.5, LogicalCPUCount: 4, ObservedAt: "2026-08-09T00:00:00Z"}
	if _, err := client.Heartbeat(context.Background(), identity, configuration, buildinfo.Info{Version: "0.2.0"}, snapshot); err != nil {
		t.Fatalf("Heartbeat() error = %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
}

func TestIdentityStoreUsesPrivateFilePermissions(t *testing.T) {
	store := NewIdentityStore(t.TempDir())
	want := Identity{SchemaVersion: 1, RunnerID: "runner-1", Credential: "secret", ServerURL: "https://autoforge.internal"}
	if err := store.Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, exists, err := store.Load()
	if err != nil || !exists {
		t.Fatalf("Load() = %#v, %v, %v", loaded, exists, err)
	}
	if loaded != want {
		t.Fatalf("Load() = %#v, want %#v", loaded, want)
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(store.path), "credentials.json"))
	if err != nil {
		t.Fatalf("stat identity: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestIdentityStoreRejectsCredentialsReadableByOtherUsers(t *testing.T) {
	store := NewIdentityStore(t.TempDir())
	identity := Identity{SchemaVersion: 1, RunnerID: "runner-1", Credential: "secret", ServerURL: "https://autoforge.internal"}
	if err := store.Save(identity); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := os.Chmod(store.path, 0o644); err != nil {
		t.Fatalf("chmod identity: %v", err)
	}
	if _, _, err := store.Load(); err == nil {
		t.Fatal("Load() accepted credentials readable by other users")
	}
}

func testConfiguration(t *testing.T, serverURL string) config.Config {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	return config.Config{
		ServerURL:      parsed,
		DataDirectory:  t.TempDir(),
		Name:           "runner-1",
		Labels:         []string{"linux", "java"},
		MaxConcurrent:  2,
		BootstrapToken: "bootstrap-secret",
		HasBootstrap:   true,
		Terminal: config.TerminalConfig{
			Enabled:         true,
			Shell:           "/bin/sh",
			WorkDirectory:   filepath.Join(t.TempDir(), "terminal"),
			MaxSessions:     1,
			MaximumDuration: time.Hour,
		},
	}
}
