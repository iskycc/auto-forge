package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultDataDirectory = "./autoforge-agent-data"
	defaultConcurrency   = 1
	maximumConcurrency   = 64
)

type LookupEnvironment func(string) (string, bool)

type Config struct {
	ServerURL     *url.URL
	DataDirectory string
	Name          string
	Labels        []string
	MaxConcurrent int
	CAFile        string
	HasBootstrap  bool
}

func Load(lookup LookupEnvironment) (Config, error) {
	serverURL, err := parseServerURL(environmentValue(lookup, "AUTOFORGE_SERVER_URL"))
	if err != nil {
		return Config{}, err
	}

	dataDirectory, err := absoluteDataDirectory(environmentValue(lookup, "AUTOFORGE_AGENT_DATA_DIR"))
	if err != nil {
		return Config{}, err
	}

	name, err := agentName(environmentValue(lookup, "AUTOFORGE_AGENT_NAME"))
	if err != nil {
		return Config{}, err
	}

	maxConcurrent, err := concurrency(environmentValue(lookup, "AUTOFORGE_AGENT_MAX_CONCURRENCY"))
	if err != nil {
		return Config{}, err
	}

	caFile, err := optionalAbsolutePath(environmentValue(lookup, "AUTOFORGE_AGENT_CA_FILE"))
	if err != nil {
		return Config{}, fmt.Errorf("AUTOFORGE_AGENT_CA_FILE is invalid: %w", err)
	}

	bootstrapToken := environmentValue(lookup, "AUTOFORGE_AGENT_BOOTSTRAP_TOKEN")
	return Config{
		ServerURL:     serverURL,
		DataDirectory: dataDirectory,
		Name:          name,
		Labels:        labels(environmentValue(lookup, "AUTOFORGE_AGENT_LABELS")),
		MaxConcurrent: maxConcurrent,
		CAFile:        caFile,
		HasBootstrap:  bootstrapToken != "",
	}, nil
}

func environmentValue(lookup LookupEnvironment, key string) string {
	value, _ := lookup(key)
	return strings.TrimSpace(value)
}

func parseServerURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("AUTOFORGE_SERVER_URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("AUTOFORGE_SERVER_URL is invalid: %w", err)
	}
	if parsed.User != nil {
		return nil, errors.New("AUTOFORGE_SERVER_URL must not contain credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("AUTOFORGE_SERVER_URL must not contain a query or fragment")
	}
	if parsed.Hostname() == "" {
		return nil, errors.New("AUTOFORGE_SERVER_URL must contain a host")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return nil, errors.New("AUTOFORGE_SERVER_URL must use HTTPS; HTTP is allowed only for loopback development")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = strings.TrimRight(parsed.RawPath, "/")
	return parsed, nil
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func absoluteDataDirectory(raw string) (string, error) {
	if raw == "" {
		raw = defaultDataDirectory
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("AUTOFORGE_AGENT_DATA_DIR is invalid: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func agentName(raw string) (string, error) {
	if raw == "" {
		hostname, err := os.Hostname()
		if err != nil {
			return "", fmt.Errorf("determine default agent name: %w", err)
		}
		raw = hostname
	}
	if len(raw) > 128 {
		return "", errors.New("AUTOFORGE_AGENT_NAME must not exceed 128 bytes")
	}
	return raw, nil
}

func concurrency(raw string) (int, error) {
	if raw == "" {
		return defaultConcurrency, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 1 || parsed > maximumConcurrency {
		return 0, fmt.Errorf("AUTOFORGE_AGENT_MAX_CONCURRENCY must be an integer from 1 to %d", maximumConcurrency)
	}
	return parsed, nil
}

func optionalAbsolutePath(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	return filepath.Clean(absolute), nil
}

func labels(raw string) []string {
	if raw == "" {
		return nil
	}
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		label := strings.TrimSpace(item)
		if label == "" {
			continue
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		result = append(result, label)
	}
	return result
}
