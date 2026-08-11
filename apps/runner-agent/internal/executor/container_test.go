package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContainerCommandAppliesMandatoryIsolationFlags(t *testing.T) {
	root := t.TempDir()
	runtimePath := filepath.Join(root, "podman")
	seccompPath := filepath.Join(root, "seccomp.json")
	if err := os.WriteFile(runtimePath, []byte("runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(seccompPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "attempt")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	spec := Spec{
		SchemaVersion: SupportedSchemaVersion,
		AttemptID:     "attempt-1",
		Isolation:     "container",
		Command:       Command{Executable: "/opt/java/bin/java", Args: []string{"-version"}},
		Environment:   map[string]string{"TOKEN": "redacted-value"},
		Limits: Limits{
			TimeoutMs:     1_000,
			MaxLogBytes:   1_024,
			CPUMillicores: 500,
			MemoryBytes:   256 << 20,
			ProcessCount:  32,
		},
	}
	policy := ContainerPolicy{
		RuntimeExecutable: runtimePath,
		ImageReference:    "registry.internal/autoforge/testng@sha256:" + strings.Repeat("a", 64),
		SeccompProfile:    seccompPath,
		User:              "10001:10001",
	}
	command, environment, cleanup, err := containerCommand(spec, workspace, policy)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	joined := strings.Join(command.Args, " ")
	for _, required := range []string{
		"--network=none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--security-opt=seccomp=" + seccompPath,
		"--pids-limit=32",
		"--memory=268435456",
		"--cpus=0.500",
		"--user=10001:10001",
		"--tmpfs=/tmp:rw,noexec,nosuid,size=67108864",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("container arguments do not contain %q: %s", required, joined)
		}
	}
	if strings.Contains(joined, "redacted-value") {
		t.Fatal("secret environment value leaked into process arguments")
	}
	if len(environment) != 1 || environment[0] != "PATH=/usr/bin:/bin" {
		t.Fatalf("unexpected runtime environment: %#v", environment)
	}
}

func TestValidateRejectsMutableOrRootContainerPolicy(t *testing.T) {
	spec := Spec{
		SchemaVersion: SupportedSchemaVersion,
		AttemptID:     "attempt-1",
		Isolation:     "container",
		Command:       Command{Executable: "/opt/java/bin/java"},
		Limits: Limits{
			TimeoutMs:     1_000,
			MaxLogBytes:   1_024,
			CPUMillicores: 500,
			MemoryBytes:   256 << 20,
			ProcessCount:  32,
		},
	}
	policy := Policy{
		AllowedExecutables: []string{"/opt/java/bin/java"},
		Container: ContainerPolicy{
			RuntimeExecutable: "/usr/bin/podman",
			ImageReference:    "autoforge/testng:latest",
			SeccompProfile:    "/etc/autoforge/seccomp.json",
			User:              "0:0",
		},
	}
	if err := Validate(spec, policy); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("expected immutable image rejection, got %v", err)
	}
	policy.Container.ImageReference = "autoforge/testng@sha256:" + strings.Repeat("a", 64)
	if err := Validate(spec, policy); err == nil || !strings.Contains(err.Error(), "non-root") {
		t.Fatalf("expected root user rejection, got %v", err)
	}
}
