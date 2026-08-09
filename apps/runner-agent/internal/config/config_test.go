package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadAcceptsHTTPSAndDeduplicatesLabels(t *testing.T) {
	environment := map[string]string{
		"AUTOFORGE_SERVER_URL":            "https://autoforge.internal/",
		"AUTOFORGE_AGENT_DATA_DIR":        t.TempDir(),
		"AUTOFORGE_AGENT_NAME":            "runner-east-1",
		"AUTOFORGE_AGENT_LABELS":          "linux, java,linux",
		"AUTOFORGE_AGENT_MAX_CONCURRENCY": "4",
		"AUTOFORGE_AGENT_BOOTSTRAP_TOKEN": "secret-that-must-not-be-returned",
		"AUTOFORGE_AGENT_CLAIM_WAIT":      "10s",
	}

	loaded, err := Load(mapLookup(environment))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.ServerURL.String() != "https://autoforge.internal" {
		t.Fatalf("ServerURL = %q", loaded.ServerURL.String())
	}
	if len(loaded.Labels) != 2 || loaded.Labels[0] != "linux" || loaded.Labels[1] != "java" {
		t.Fatalf("Labels = %#v", loaded.Labels)
	}
	if !loaded.HasBootstrap {
		t.Fatal("HasBootstrap = false, want true")
	}
	if loaded.Claim.WaitDuration != 10*time.Second || loaded.Claim.MaximumBackoff != 30*time.Second {
		t.Fatalf("Claim policy = %#v", loaded.Claim)
	}
}

func TestLoadRejectsOutOfRangeClaimPolicy(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL":       "https://autoforge.internal",
		"AUTOFORGE_AGENT_CLAIM_WAIT": "31s",
	}))
	if err == nil {
		t.Fatal("Load() accepted an out-of-range claim wait duration")
	}
}

func TestLoadRejectsInsecureRemoteHTTP(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL": "http://runner.example.test",
	}))
	if err == nil {
		t.Fatal("Load() error = nil, want insecure URL error")
	}
}

func TestLoadEnablesTerminalWithBoundedPolicy(t *testing.T) {
	loaded, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL":                  "https://autoforge.internal",
		"AUTOFORGE_AGENT_DATA_DIR":              t.TempDir(),
		"AUTOFORGE_AGENT_TERMINAL_ENABLED":      "true",
		"AUTOFORGE_AGENT_TERMINAL_SHELL":        "/bin/sh",
		"AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS": "2",
		"AUTOFORGE_AGENT_TERMINAL_MAX_DURATION": "30m",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !loaded.Terminal.Enabled || loaded.Terminal.Shell != "/bin/sh" {
		t.Fatalf("Terminal = %#v", loaded.Terminal)
	}
	if loaded.Terminal.MaxSessions != 2 || loaded.Terminal.MaximumDuration != 30*time.Minute {
		t.Fatalf("Terminal policy = %#v", loaded.Terminal)
	}
}

func TestCheckLocalEnvironmentCreatesPrivateDirectories(t *testing.T) {
	dataDirectory := filepath.Join(t.TempDir(), "agent")
	configuration := Config{
		ServerURL:     mustURL(t, "https://autoforge.internal"),
		DataDirectory: dataDirectory,
		Name:          "runner",
		MaxConcurrent: 1,
	}

	diagnostic, err := CheckLocalEnvironment(configuration)
	if err != nil {
		t.Fatalf("CheckLocalEnvironment() error = %v", err)
	}
	if diagnostic.Status != "ready" {
		t.Fatalf("Status = %q", diagnostic.Status)
	}
	for _, directory := range []string{"identity", "spool", "work"} {
		info, statErr := os.Stat(filepath.Join(dataDirectory, directory))
		if statErr != nil {
			t.Fatalf("stat %s: %v", directory, statErr)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("mode for %s = %o, want 700", directory, info.Mode().Perm())
		}
	}
}

func mapLookup(values map[string]string) LookupEnvironment {
	return func(key string) (string, bool) {
		value, exists := values[key]
		return value, exists
	}
}
