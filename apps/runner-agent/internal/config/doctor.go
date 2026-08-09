package config

import (
	"fmt"
	"os"
	"path/filepath"
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
	}, nil
}
