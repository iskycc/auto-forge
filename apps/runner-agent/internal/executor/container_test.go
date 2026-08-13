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
		"--cidfile=" + filepath.Join(root, ".autoforge-container-id-"),
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

func TestContainerCleanupForcesRemovalAndDeletesTemporaryFiles(t *testing.T) {
	root := t.TempDir()
	invocationPath := filepath.Join(root, "runtime-invocation")
	runtimePath := filepath.Join(root, "docker")
	runtimeScript := "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"" + invocationPath + "\"\n"
	if err := os.WriteFile(runtimePath, []byte(runtimeScript), 0o700); err != nil {
		t.Fatal(err)
	}
	containerIDFile := filepath.Join(root, "container.cid")
	environmentFile := filepath.Join(root, "container.env")
	containerID := strings.Repeat("a", 64)
	if err := os.WriteFile(containerIDFile, []byte(containerID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(environmentFile, []byte("TOKEN=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := cleanupContainer(runtimePath, containerIDFile, environmentFile); err != nil {
		t.Fatal(err)
	}
	invocation, err := os.ReadFile(invocationPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(invocation)) != "rm --force "+containerID {
		t.Fatalf("unexpected cleanup invocation: %s", invocation)
	}
	for _, path := range []string{containerIDFile, environmentFile} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("temporary file %s was not removed", path)
		}
	}
}

func TestContainerCleanupAcceptsAlreadyRemovedContainer(t *testing.T) {
	root := t.TempDir()
	runtimePath := filepath.Join(root, "docker")
	runtimeScript := "#!/bin/sh\nprintf 'Error: No such container: %s\\n' \"$3\" >&2\nexit 1\n"
	if err := os.WriteFile(runtimePath, []byte(runtimeScript), 0o700); err != nil {
		t.Fatal(err)
	}
	containerIDFile := filepath.Join(root, "container.cid")
	if err := os.WriteFile(containerIDFile, []byte(strings.Repeat("b", 64)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := cleanupContainer(runtimePath, containerIDFile, filepath.Join(root, "missing.env")); err != nil {
		t.Fatal(err)
	}
}

func TestContainerCleanupRejectsInvalidRuntimeIdentifier(t *testing.T) {
	root := t.TempDir()
	containerIDFile := filepath.Join(root, "container.cid")
	if err := os.WriteFile(containerIDFile, []byte("--all\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := cleanupContainer(filepath.Join(root, "docker"), containerIDFile, filepath.Join(root, "missing.env"))
	if err == nil || !strings.Contains(err.Error(), "invalid container id") {
		t.Fatalf("expected invalid container id rejection, got %v", err)
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
