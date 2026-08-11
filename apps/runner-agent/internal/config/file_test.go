package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFileReadsVersionedPrivateConfiguration(t *testing.T) {
	configurationPath := filepath.Join(t.TempDir(), "agent.json")
	configuration := `{
  "schemaVersion": 1,
  "serverUrl": "https://autoforge.internal",
  "dataDirectory": "/var/lib/autoforge-agent",
  "name": "runner-west-1",
  "labels": ["linux", "internal"],
  "maxConcurrency": 3,
  "bootstrapToken": "one-time-token",
  "terminal": {"enabled": false}
}`
	if err := os.WriteFile(configurationPath, []byte(configuration), 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadFile(configurationPath)
	if err != nil {
		t.Fatalf("LoadFile() error = %v", err)
	}
	if loaded.Name != "runner-west-1" || loaded.MaxConcurrent != 3 {
		t.Fatalf("loaded = %#v", loaded)
	}
	if !loaded.HasBootstrap || len(loaded.Labels) != 2 {
		t.Fatalf("loaded bootstrap/labels = %#v", loaded)
	}
}

func TestLoadFileRejectsUnknownFields(t *testing.T) {
	configurationPath := filepath.Join(t.TempDir(), "agent.json")
	configuration := `{"schemaVersion":1,"serverUrl":"https://autoforge.internal","unexpected":true}`
	if err := os.WriteFile(configurationPath, []byte(configuration), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(configurationPath); err == nil {
		t.Fatal("LoadFile() accepted an unknown configuration field")
	}
}

func TestLoadFileRejectsConfigurationReadableByOtherUsers(t *testing.T) {
	configurationPath := filepath.Join(t.TempDir(), "agent.json")
	configuration := `{"schemaVersion":1,"serverUrl":"https://autoforge.internal"}`
	if err := os.WriteFile(configurationPath, []byte(configuration), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(configurationPath); err == nil {
		t.Fatal("LoadFile() accepted mode 0644")
	}
}

func TestConsumeBootstrapTokenAtomicallyRemovesSecret(t *testing.T) {
	configurationPath := filepath.Join(t.TempDir(), "agent.json")
	configuration := `{
  "schemaVersion": 1,
  "serverUrl": "https://autoforge.internal",
  "bootstrapToken": "one-time-token"
}`
	if err := os.WriteFile(configurationPath, []byte(configuration), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ConsumeBootstrapToken(configurationPath); err != nil {
		t.Fatalf("ConsumeBootstrapToken() error = %v", err)
	}
	loaded, err := LoadFile(configurationPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.HasBootstrap || loaded.BootstrapToken != "" {
		t.Fatalf("bootstrap token was not removed: %#v", loaded)
	}
	info, err := os.Stat(configurationPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("configuration mode = %o, want 600", info.Mode().Perm())
	}
}
