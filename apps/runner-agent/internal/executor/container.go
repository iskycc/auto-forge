package executor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var (
	immutableImagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:\-]*@sha256:[a-f0-9]{64}$`)
	containerUserPattern  = regexp.MustCompile(`^[1-9][0-9]{0,9}(?::[1-9][0-9]{0,9})?$`)
)

func validateContainerPolicy(policy ContainerPolicy, spec Spec) error {
	if !filepath.IsAbs(policy.RuntimeExecutable) {
		return errors.New("container runtime executable must be an absolute path")
	}
	switch filepath.Base(policy.RuntimeExecutable) {
	case "docker", "nerdctl", "podman":
	default:
		return errors.New("container runtime must be docker, nerdctl, or podman")
	}
	if !immutableImagePattern.MatchString(policy.ImageReference) {
		return errors.New("container image must use an immutable sha256 digest")
	}
	if !filepath.IsAbs(policy.SeccompProfile) {
		return errors.New("container seccomp profile must be an absolute path")
	}
	if !containerUserPattern.MatchString(policy.User) {
		return errors.New("container user must be an explicit non-root numeric uid[:gid]")
	}
	if !filepath.IsAbs(spec.Command.Executable) {
		return errors.New("container command executable must be an absolute in-container path")
	}
	if spec.Limits.CPUMillicores <= 0 || spec.Limits.MemoryBytes <= 0 || spec.Limits.ProcessCount <= 0 {
		return errors.New("container execution requires positive CPU, memory, and process limits")
	}
	for name, value := range spec.Environment {
		if strings.ContainsAny(name, "\r\n=") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("container environment entry %q cannot contain line breaks", name)
		}
	}
	return nil
}

func containerCommand(
	spec Spec,
	workspace string,
	policy ContainerPolicy,
) (Command, []string, func() error, error) {
	if strings.Contains(workspace, ",") {
		return Command{}, nil, nil, errors.New("container workspace path cannot contain a comma")
	}
	if err := requireRegularFile(policy.SeccompProfile); err != nil {
		return Command{}, nil, nil, fmt.Errorf("validate container seccomp profile: %w", err)
	}
	if err := requireExecutableFile(policy.RuntimeExecutable); err != nil {
		return Command{}, nil, nil, fmt.Errorf("validate container runtime: %w", err)
	}
	environmentFile, err := writeContainerEnvironment(filepath.Dir(workspace), spec.Environment)
	if err != nil {
		return Command{}, nil, nil, err
	}
	cleanup := func() error { return os.Remove(environmentFile) }
	workDirectory := "/workspace"
	if spec.Command.CwdRelative != "" {
		workDirectory += "/" + filepath.ToSlash(spec.Command.CwdRelative)
	}
	arguments := []string{
		"run",
		"--rm",
		"--network=none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--security-opt=seccomp=" + policy.SeccompProfile,
		"--pids-limit=" + strconv.FormatInt(spec.Limits.ProcessCount, 10),
		"--memory=" + strconv.FormatInt(spec.Limits.MemoryBytes, 10),
		"--cpus=" + strconv.FormatFloat(float64(spec.Limits.CPUMillicores)/1000, 'f', 3, 64),
		"--user=" + policy.User,
		"--mount=type=bind,src=" + workspace + ",dst=/workspace,rw",
		"--workdir=" + workDirectory,
		"--env-file=" + environmentFile,
		"--tmpfs=/tmp:rw,noexec,nosuid,size=67108864",
		policy.ImageReference,
		spec.Command.Executable,
	}
	arguments = append(arguments, spec.Command.Args...)
	return Command{Executable: policy.RuntimeExecutable, Args: arguments}, []string{"PATH=/usr/bin:/bin"}, cleanup, nil
}

func writeContainerEnvironment(directory string, environment map[string]string) (string, error) {
	file, err := os.CreateTemp(directory, ".autoforge-container-env-")
	if err != nil {
		return "", fmt.Errorf("create container environment file: %w", err)
	}
	path := file.Name()
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("secure container environment file: %w", err)
	}
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if _, err := fmt.Fprintf(file, "%s=%s\n", name, environment[name]); err != nil {
			file.Close()
			_ = os.Remove(path)
			return "", fmt.Errorf("write container environment file: %w", err)
		}
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("close container environment file: %w", err)
	}
	return path, nil
}

func requireRegularFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("path is not a regular file")
	}
	return nil
}

func requireExecutableFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("path is not an executable regular file")
	}
	return nil
}
