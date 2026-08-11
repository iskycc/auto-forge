package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Diagnostic struct {
	Status          string   `json:"status"`
	ServerURL       string   `json:"serverUrl"`
	DataDirectory   string   `json:"dataDirectory"`
	Name            string   `json:"name"`
	Labels          []string `json:"labels"`
	MaxConcurrent   int      `json:"maxConcurrency"`
	CAFile          string   `json:"caFile,omitempty"`
	HasBootstrap    bool     `json:"hasBootstrapToken"`
	TerminalEnabled bool     `json:"terminalEnabled"`
	TerminalShell   string   `json:"terminalShell,omitempty"`
	Capabilities    []string `json:"capabilities"`
	ResourceControl string   `json:"resourceControl"`
}

func CheckLocalEnvironment(configuration Config) (Diagnostic, error) {
	terminalShell := ""
	for _, directory := range []string{"identity", "spool", "work"} {
		path := filepath.Join(configuration.DataDirectory, directory)
		if err := os.MkdirAll(path, 0o700); err != nil {
			return Diagnostic{}, fmt.Errorf("prepare agent directory %s: %w", path, err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			return Diagnostic{}, fmt.Errorf("secure agent directory %s: %w", path, err)
		}
	}

	probe, err := os.CreateTemp(configuration.DataDirectory, ".write-probe-")
	if err != nil {
		return Diagnostic{}, fmt.Errorf("agent data directory is not writable: %w", err)
	}
	probePath := probe.Name()
	if closeErr := probe.Close(); closeErr != nil {
		return Diagnostic{}, fmt.Errorf("close data directory probe: %w", closeErr)
	}
	if removeErr := os.Remove(probePath); removeErr != nil {
		return Diagnostic{}, fmt.Errorf("remove data directory probe: %w", removeErr)
	}

	if configuration.CAFile != "" {
		info, statErr := os.Stat(configuration.CAFile)
		if statErr != nil {
			return Diagnostic{}, fmt.Errorf("read configured CA file: %w", statErr)
		}
		if !info.Mode().IsRegular() {
			return Diagnostic{}, fmt.Errorf("configured CA file is not a regular file: %s", configuration.CAFile)
		}
	}
	if configuration.Toolchain.Enabled() {
		if err := requireExecutable(configuration.Toolchain.JavaExecutable); err != nil {
			return Diagnostic{}, fmt.Errorf("validate Java executable: %w", err)
		}
		for _, entry := range configuration.Toolchain.Classpath {
			info, statErr := os.Stat(entry)
			if statErr != nil {
				return Diagnostic{}, fmt.Errorf("inspect TestNG classpath entry %s: %w", entry, statErr)
			}
			if !info.Mode().IsRegular() && !info.IsDir() {
				return Diagnostic{}, fmt.Errorf("TestNG classpath entry is not a file or directory: %s", entry)
			}
		}
	}
	if configuration.Container.Enabled() {
		if err := requireExecutable(configuration.Container.RuntimeExecutable); err != nil {
			return Diagnostic{}, fmt.Errorf("validate container runtime: %w", err)
		}
		info, statErr := os.Stat(configuration.Container.SeccompProfile)
		if statErr != nil {
			return Diagnostic{}, fmt.Errorf("inspect container seccomp profile: %w", statErr)
		}
		if !info.Mode().IsRegular() {
			return Diagnostic{}, errors.New("container seccomp profile is not a regular file")
		}
	}
	resourceControl := "disabled"
	if configuration.Resources.Enabled() {
		if err := checkCgroupDelegation(configuration.Resources.CgroupRoot); err != nil {
			return Diagnostic{}, fmt.Errorf("validate cgroup v2 delegation: %w", err)
		}
		resourceControl = configuration.Resources.CgroupRoot
	}
	if configuration.Terminal.Enabled {
		terminalShell = configuration.Terminal.Shell
		info, statErr := os.Stat(configuration.Terminal.Shell)
		if statErr != nil {
			return Diagnostic{}, fmt.Errorf("inspect configured terminal shell: %w", statErr)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return Diagnostic{}, fmt.Errorf("configured terminal shell is not an executable regular file: %s", configuration.Terminal.Shell)
		}
		if err := os.MkdirAll(configuration.Terminal.WorkDirectory, 0o700); err != nil {
			return Diagnostic{}, fmt.Errorf("prepare terminal work directory: %w", err)
		}
		if err := os.Chmod(configuration.Terminal.WorkDirectory, 0o700); err != nil {
			return Diagnostic{}, fmt.Errorf("secure terminal work directory: %w", err)
		}
	}

	return Diagnostic{
		Status:          "ready",
		ServerURL:       configuration.ServerURL.String(),
		DataDirectory:   configuration.DataDirectory,
		Name:            configuration.Name,
		Labels:          configuration.Labels,
		MaxConcurrent:   configuration.MaxConcurrent,
		CAFile:          configuration.CAFile,
		HasBootstrap:    configuration.HasBootstrap,
		TerminalEnabled: configuration.Terminal.Enabled,
		TerminalShell:   terminalShell,
		Capabilities:    configuration.Capabilities(),
		ResourceControl: resourceControl,
	}, nil
}

func checkCgroupDelegation(root string) error {
	controllers, err := os.ReadFile(filepath.Join(root, "cgroup.controllers"))
	if err != nil {
		return fmt.Errorf("read cgroup.controllers: %w", err)
	}
	for _, required := range []string{"cpu", "memory", "pids"} {
		if !containsWord(string(controllers), required) {
			return fmt.Errorf("controller %s is not delegated", required)
		}
	}
	agentLeaf := filepath.Join(root, ".autoforge-agent")
	if err := os.Mkdir(agentLeaf, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create Agent leaf cgroup: %w", err)
	}
	if err := writeCgroupControl(agentLeaf, "cgroup.procs", strconv.Itoa(os.Getpid())); err != nil {
		return fmt.Errorf("move Agent into leaf cgroup: %w", err)
	}
	if err := writeCgroupControl(root, "cgroup.subtree_control", "+cpu +memory +pids"); err != nil {
		return fmt.Errorf("enable delegated controllers: %w", err)
	}
	probe, err := os.MkdirTemp(root, ".autoforge-doctor-")
	if err != nil {
		return fmt.Errorf("create delegated child cgroup: %w", err)
	}
	defer os.Remove(probe)
	for _, name := range []string{"cpu.max", "memory.max", "memory.swap.max", "memory.oom.group", "pids.max", "cgroup.procs"} {
		file, openErr := os.OpenFile(filepath.Join(probe, name), os.O_WRONLY, 0)
		if openErr != nil {
			return fmt.Errorf("open delegated %s: %w", name, openErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return fmt.Errorf("close delegated %s: %w", name, closeErr)
		}
	}
	return nil
}

func writeCgroupControl(directory, name, value string) error {
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(value); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func containsWord(value, wanted string) bool {
	for _, word := range strings.Fields(value) {
		if word == wanted {
			return true
		}
	}
	return false
}

func requireExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("not an executable regular file: %s", path)
	}
	return nil
}
