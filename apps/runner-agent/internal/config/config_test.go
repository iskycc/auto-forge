package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAcceptsHTTPSAndDeduplicatesLabels(t *testing.T) {
	environment := map[string]string{
		"AUTOFORGE_SERVER_URL":            "https://autoforge.internal/",
		"AUTOFORGE_AGENT_DATA_DIR":        t.TempDir(),
		"AUTOFORGE_AGENT_NAME":            "runner-east-1",
		"AUTOFORGE_AGENT_LABELS":          "linux, java,linux",
		"AUTOFORGE_AGENT_MAX_CONCURRENCY": "4",
		"AUTOFORGE_AGENT_BOOTSTRAP_TOKEN": "secret-that-must-not-be-returned",
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
}

func TestLoadRejectsInsecureRemoteHTTP(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL": "http://runner.example.test",
	}))
	if err == nil {
		t.Fatal("Load() error = nil, want insecure URL error")
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
	if diagnostic.Status != "ready-for-protocol-integration" {
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
