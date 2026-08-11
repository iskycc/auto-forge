package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/metrics"
)

func TestClientDownloadsOnlyTheDeclaredInputSizeWithRunnerAndLeaseCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/run-attempts/attempt-1/inputs/source-1" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer runner-credential" || request.Header.Get("X-AutoForge-Runner-Id") != "runner-1" || request.Header.Get("X-AutoForge-Lease-Token") != "lease-token" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Length", "3")
		_, _ = writer.Write([]byte("jar"))
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	var destination bytes.Buffer
	err = client.DownloadInput(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "runner-credential"},
		"attempt-1",
		Lease{Token: "lease-token"},
		ExecutionInput{InputID: "source-1", SizeBytes: 3},
		&destination,
	)
	if err != nil {
		t.Fatalf("DownloadInput() error = %v", err)
	}
	if destination.String() != "jar" {
		t.Fatalf("downloaded input = %q", destination.String())
	}
}

func TestClientAcquiresOnlyExpectedSecretsWithRunnerAndLeaseCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/run-attempts/attempt-1/secrets" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer runner-credential" || request.Header.Get("X-AutoForge-Runner-Id") != "runner-1" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		var acquisition acquireSecretsRequest
		if err := json.NewDecoder(request.Body).Decode(&acquisition); err != nil {
			t.Errorf("decode secret request: %v", err)
			return
		}
		if acquisition.LeaseToken != "lease-token" || acquisition.SchemaVersion != protocolVersion {
			t.Errorf("secret request = %#v", acquisition)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(acquireSecretsResponse{
			SchemaVersion: protocolVersion,
			RequestID:     acquisition.RequestID,
			Secrets:       []EnvironmentEntry{{Name: "API_TOKEN", Value: "execution-secret"}},
		})
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	secrets, err := client.AcquireSecrets(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "runner-credential"},
		"attempt-1",
		Lease{Token: "lease-token"},
		[]SecretReference{{
			Name: "API_TOKEN", SecretID: "secret-1", SecretVersionID: "secret-version-1",
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(secrets) != 1 || secrets[0].Value != "execution-secret" || !secrets[0].Secret {
		t.Fatalf("AcquireSecrets() = %#v", secrets)
	}
}

func TestClientRejectsUnexpectedSecretResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var acquisition acquireSecretsRequest
		_ = json.NewDecoder(request.Body).Decode(&acquisition)
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(acquireSecretsResponse{
			SchemaVersion: protocolVersion,
			RequestID:     acquisition.RequestID,
			Secrets:       []EnvironmentEntry{{Name: "UNDECLARED_TOKEN", Value: "must-not-be-used"}},
		})
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.AcquireSecrets(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "runner-credential"},
		"attempt-1",
		Lease{Token: "lease-token"},
		[]SecretReference{{
			Name: "API_TOKEN", SecretID: "secret-1", SecretVersionID: "secret-version-1",
		}},
	)
	if err == nil || !strings.Contains(err.Error(), "unexpected variable") {
		t.Fatalf("AcquireSecrets() error = %v", err)
	}
}

func TestClientUploadsDirectArtifactWithoutLeakingCredentialsAndFinalizes(t *testing.T) {
	artifactReceived := false
	objectServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" || request.Header.Get("X-AutoForge-Lease-Token") != "" || request.Header.Get("X-AutoForge-Runner-Id") != "" {
			t.Error("direct upload leaked control-plane credentials")
		}
		content := new(bytes.Buffer)
		if _, err := content.ReadFrom(request.Body); err != nil {
			t.Error(err)
		}
		artifactReceived = content.String() == "artifact"
		writer.WriteHeader(http.StatusOK)
	}))
	defer objectServer.Close()

	finalized := false
	controlServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/run-attempts/attempt-1/artifacts/artifact-1/finalize" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer runner-credential" || request.Header.Get("X-AutoForge-Lease-Token") != "lease-token" || request.Header.Get("X-AutoForge-Runner-Id") != "runner-1" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		finalized = true
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(uploadArtifactResponse{ArtifactID: "artifact-1", Status: "uploaded"})
	}))
	defer controlServer.Close()

	client, err := NewClient(testConfiguration(t, controlServer.URL))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "artifact.xml")
	if err := os.WriteFile(path, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = client.UploadArtifact(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "runner-credential"},
		Lease{Token: "lease-token"},
		declaredArtifact{
			artifactDeclaration: artifactDeclaration{ArtifactID: "artifact-1", MediaType: "application/xml", SizeBytes: 8},
			UploadMethod:        "direct",
			UploadPath:          objectServer.URL + "/signed-object",
			FinalizePath:        "/api/v1/run-attempts/attempt-1/artifacts/artifact-1/finalize",
		},
		path,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !artifactReceived || !finalized {
		t.Fatalf("artifactReceived=%v finalized=%v", artifactReceived, finalized)
	}
}

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
				"schemaVersion": 1, "acceptedAt": "2026-08-09T00:00:00.000Z", "heartbeatIntervalSeconds": 15, "draining": false, "rotateCredential": true,
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
	heartbeat, err := client.Heartbeat(context.Background(), identity, configuration, buildinfo.Info{Version: "0.2.0"}, 1, snapshot)
	if err != nil {
		t.Fatalf("Heartbeat() error = %v", err)
	}
	if !heartbeat.RotateCredential {
		t.Fatal("Heartbeat() did not preserve the credential rotation instruction")
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
}

func TestClientRotatesCredentialAndKeepsRunnerIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path != "/api/v1/runner-agents/runner-1/credentials/rotate" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer old-credential-with-more-than-32-bytes" {
			t.Errorf("rotate Authorization = %q", request.Header.Get("Authorization"))
		}
		json.NewEncoder(writer).Encode(map[string]any{
			"schemaVersion":                1,
			"credential":                   "new-credential-with-more-than-32-bytes",
			"credentialVersion":            2,
			"previousCredentialValidUntil": "2026-08-09T00:15:00.000Z",
		})
	}))
	defer server.Close()

	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	identity := Identity{
		SchemaVersion: identitySchemaVersion,
		RunnerID:      "runner-1",
		Credential:    "old-credential-with-more-than-32-bytes",
		ServerURL:     server.URL,
	}
	rotated, err := client.RotateCredential(context.Background(), identity)
	if err != nil {
		t.Fatalf("RotateCredential() error = %v", err)
	}
	if rotated.RunnerID != "runner-1" || rotated.Credential != "new-credential-with-more-than-32-bytes" {
		t.Fatalf("RotateCredential() identity = %#v", rotated)
	}
	if rotated.ServerURL != identity.ServerURL || rotated.SchemaVersion != identitySchemaVersion {
		t.Fatalf("RotateCredential() identity metadata = %#v", rotated)
	}
}

func TestClientRejectsRotationResponseWithInvalidGraceDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(map[string]any{
			"schemaVersion":                1,
			"credential":                   "new-credential-with-more-than-32-bytes",
			"credentialVersion":            2,
			"previousCredentialValidUntil": "not-a-timestamp",
		})
	}))
	defer server.Close()

	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	identity := Identity{SchemaVersion: identitySchemaVersion, RunnerID: "runner-1", Credential: "old-credential-with-more-than-32-bytes"}
	if _, err := client.RotateCredential(context.Background(), identity); err == nil {
		t.Fatal("RotateCredential() succeeded with an invalid grace deadline")
	}
}

func TestClientReturnsStableErrorForRevokedRunnerCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"error": map[string]any{
				"code": "RUNNER_AUTH_REJECTED", "message": "credential revoked", "requestId": "request-1",
			},
		})
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Heartbeat(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "revoked-credential"},
		testConfiguration(t, server.URL),
		buildinfo.Info{Version: "0.2.2"},
		0,
		nil,
	)
	var problem *APIError
	if !errors.As(err, &problem) || problem.Code != "RUNNER_AUTH_REJECTED" {
		t.Fatalf("Heartbeat() error = %#v, want RUNNER_AUTH_REJECTED", err)
	}
}

func TestClientUsesSameProtocolForLiteAndFullControlPlanes(t *testing.T) {
	for _, mode := range []string{"lite", "full"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/api/v1/runner-agents/runner-1/claims" {
					http.NotFound(writer, request)
					return
				}
				if request.Header.Get("Authorization") != "Bearer runner-credential" {
					http.Error(writer, "unauthorized", http.StatusUnauthorized)
					return
				}
				var claim claimRequest
				if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
					t.Errorf("decode claim request: %v", err)
					return
				}
				if claim.SchemaVersion != protocolVersion {
					t.Errorf("claim schemaVersion = %d, want %d", claim.SchemaVersion, protocolVersion)
				}
				writer.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(writer).Encode(map[string]any{
					"schemaVersion":            protocolVersion,
					"requestId":                claim.RequestID,
					"assignments":              []any{},
					"retryAfterMs":             1_000,
					"optionalServerPatchField": mode,
				})
			}))
			defer server.Close()

			configuration := testConfiguration(t, server.URL)
			client, err := NewClient(configuration)
			if err != nil {
				t.Fatalf("NewClient() error = %v", err)
			}
			response, err := client.Claim(
				context.Background(),
				Identity{RunnerID: "runner-1", Credential: "runner-credential"},
				configuration,
				1,
			)
			if err != nil {
				t.Fatalf("Claim() error = %v", err)
			}
			if response.SchemaVersion != protocolVersion || len(response.Assignments) != 0 {
				t.Fatalf("Claim() response = %#v", response)
			}
		})
	}
}

func TestClientRejectsIncompatibleClaimResponseVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var claim claimRequest
		if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
			t.Errorf("decode claim request: %v", err)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"schemaVersion": 2,
			"requestId":     claim.RequestID,
			"assignments":   []any{},
			"retryAfterMs":  1_000,
		})
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, err = client.Claim(
		context.Background(),
		Identity{RunnerID: "runner-1", Credential: "runner-credential"},
		configuration,
		1,
	)
	if err == nil || !strings.Contains(err.Error(), "incompatible protocol response") {
		t.Fatalf("Claim() error = %v, want incompatible protocol response", err)
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
