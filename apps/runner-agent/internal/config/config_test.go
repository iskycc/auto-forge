package config

import (
	"os"
	"path/filepath"
	"strings"
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

func TestLoadRejectsJavaWithoutSourceFileMode(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL":             "https://autoforge.internal",
		"AUTOFORGE_AGENT_JAVA_EXECUTABLE":  "/opt/jdk/bin/java",
		"AUTOFORGE_AGENT_TESTNG_CLASSPATH": "/opt/testng/testng.jar",
		"AUTOFORGE_AGENT_JAVA_VERSION":     "1.8.0_452",
		"AUTOFORGE_AGENT_TESTNG_VERSION":   "7.11.0",
	}))
	if err == nil {
		t.Fatal("Load() accepted Java 8 for the TestNG source-file launcher")
	}
}

func TestLoadAcceptsInternalHTTPAddress(t *testing.T) {
	loaded, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL": "http://10.20.30.40:3000",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.ServerURL.String() != "http://10.20.30.40:3000" {
		t.Fatalf("ServerURL = %q", loaded.ServerURL.String())
	}
}

func TestLoadRejectsUnsupportedServerURLScheme(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL": "ftp://runner.example.test",
	}))
	if err == nil {
		t.Fatal("Load() accepted an unsupported URL scheme")
	}
}

func TestLoadAddsCgroupIsolationCapability(t *testing.T) {
	loaded, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL":            "https://autoforge.internal",
		"AUTOFORGE_AGENT_CGROUP_ROOT":     "/sys/fs/cgroup/autoforge-agent.service",
		"AUTOFORGE_AGENT_DATA_DIR":        t.TempDir(),
		"AUTOFORGE_AGENT_MAX_CONCURRENCY": "1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !containsWord(strings.Join(loaded.Capabilities(), " "), "isolation:cgroup-v2") {
		t.Fatalf("Capabilities() = %#v", loaded.Capabilities())
	}
	if !containsWord(strings.Join(loaded.Capabilities(), " "), "secrets:on-demand-v1") {
		t.Fatalf("Capabilities() = %#v, want on-demand secret support", loaded.Capabilities())
	}
}

func TestLoadRejectsCgroupRootOutsideKernelHierarchy(t *testing.T) {
	_, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL":        "https://autoforge.internal",
		"AUTOFORGE_AGENT_CGROUP_ROOT": "/tmp/not-a-cgroup",
	}))
	if err == nil {
		t.Fatal("Load() accepted a cgroup root outside /sys/fs/cgroup")
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

func TestLoadUsesBashAsTheDefaultTerminalShell(t *testing.T) {
	loaded, err := Load(mapLookup(map[string]string{
		"AUTOFORGE_SERVER_URL": "https://autoforge.internal",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Terminal.Shell != "/bin/bash" {
		t.Fatalf("Terminal.Shell = %q, want /bin/bash", loaded.Terminal.Shell)
	}
}

func TestAdapterCanClaimProjectSuppliedRuntimeWithoutLocalToolchain(t *testing.T) {
	configuration := Config{Adapter: AdapterConfig{JarPath: "/opt/autoforge/lib/cotest-testng-adapter.jar"}}
	if !configuration.CanClaimExecutions() {
		t.Fatal("CanClaimExecutions() = false, want true for an installed Adapter")
	}
	capabilities := strings.Join(configuration.Capabilities(), " ")
	for _, expected := range []string{"executor:testng-v1", "adapter:cotest-testng-v1", "runtime:project-assets-v1"} {
		if !containsWord(capabilities, expected) {
			t.Fatalf("Capabilities() = %#v, missing %q", configuration.Capabilities(), expected)
		}
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
