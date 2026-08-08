package config

import (
	"fmt"
	"os"
	"path/filepath"
)

type Diagnostic struct {
	Status        string   `json:"status"`
	ServerURL     string   `json:"serverUrl"`
	DataDirectory string   `json:"dataDirectory"`
	Name          string   `json:"name"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrency"`
	CAFile        string   `json:"caFile,omitempty"`
	HasBootstrap  bool     `json:"hasBootstrapToken"`
}

func CheckLocalEnvironment(configuration Config) (Diagnostic, error) {
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

	return Diagnostic{
		Status:        "ready-for-protocol-integration",
		ServerURL:     configuration.ServerURL.String(),
		DataDirectory: configuration.DataDirectory,
		Name:          configuration.Name,
		Labels:        configuration.Labels,
		MaxConcurrent: configuration.MaxConcurrent,
		CAFile:        configuration.CAFile,
		HasBootstrap:  configuration.HasBootstrap,
	}, nil
}
