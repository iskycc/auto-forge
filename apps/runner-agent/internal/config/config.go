package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultDataDirectory    = "./autoforge-agent-data"
	defaultConcurrency      = 1
	maximumConcurrency      = 64
	defaultTerminalShell    = "/bin/sh"
	maximumTerminalSessions = 4
)

type LookupEnvironment func(string) (string, bool)

type Config struct {
	ServerURL      *url.URL
	DataDirectory  string
	Name           string
	Labels         []string
	MaxConcurrent  int
	CAFile         string
	BootstrapToken string
	HasBootstrap   bool
	Toolchain      ToolchainConfig
	Claim          ClaimConfig
	Terminal       TerminalConfig
}

func (configuration Config) RunnerLabels() []string {
	result := append([]string(nil), configuration.Labels...)
	if configuration.Toolchain.Enabled() {
		result = append(result, "java", "testng")
	}
	return labels(strings.Join(result, ","))
}

type ToolchainConfig struct {
	JavaExecutable string
	Classpath      []string
	JavaVersion    string
	TestNGVersion  string
}

type ClaimConfig struct {
	WaitDuration        time.Duration
	MaximumBackoff      time.Duration
	ShutdownGracePeriod time.Duration
}

func (configuration ToolchainConfig) Enabled() bool {
	return configuration.JavaExecutable != "" && len(configuration.Classpath) > 0
}

func (configuration ToolchainConfig) Capabilities() []string {
	if !configuration.Enabled() {
		return nil
	}
	return []string{
		"executor:testng-v1",
		"java:" + configuration.JavaVersion,
		"testng:" + configuration.TestNGVersion,
	}
}

type TerminalConfig struct {
	Enabled         bool
	Shell           string
	WorkDirectory   string
	MaxSessions     int
	MaximumDuration time.Duration
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
	toolchain, err := toolchainConfig(lookup)
	if err != nil {
		return Config{}, err
	}
	claim, err := claimConfig(lookup)
	if err != nil {
		return Config{}, err
	}
	terminal, err := terminalConfig(lookup, dataDirectory)
	if err != nil {
		return Config{}, err
	}
	return Config{
		ServerURL:      serverURL,
		DataDirectory:  dataDirectory,
		Name:           name,
		Labels:         labels(environmentValue(lookup, "AUTOFORGE_AGENT_LABELS")),
		MaxConcurrent:  maxConcurrent,
		CAFile:         caFile,
		BootstrapToken: bootstrapToken,
		HasBootstrap:   bootstrapToken != "",
		Toolchain:      toolchain,
		Claim:          claim,
		Terminal:       terminal,
	}, nil
}

func claimConfig(lookup LookupEnvironment) (ClaimConfig, error) {
	waitDuration, err := boundedDuration(environmentValue(lookup, "AUTOFORGE_AGENT_CLAIM_WAIT"), 20*time.Second, time.Second, 30*time.Second)
	if err != nil {
		return ClaimConfig{}, fmt.Errorf("AUTOFORGE_AGENT_CLAIM_WAIT is invalid: %w", err)
	}
	maximumBackoff, err := boundedDuration(environmentValue(lookup, "AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF"), 30*time.Second, time.Second, 5*time.Minute)
	if err != nil {
		return ClaimConfig{}, fmt.Errorf("AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF is invalid: %w", err)
	}
	shutdownGracePeriod, err := boundedDuration(environmentValue(lookup, "AUTOFORGE_AGENT_SHUTDOWN_GRACE"), 30*time.Second, time.Second, 10*time.Minute)
	if err != nil {
		return ClaimConfig{}, fmt.Errorf("AUTOFORGE_AGENT_SHUTDOWN_GRACE is invalid: %w", err)
	}
	return ClaimConfig{WaitDuration: waitDuration, MaximumBackoff: maximumBackoff, ShutdownGracePeriod: shutdownGracePeriod}, nil
}

func toolchainConfig(lookup LookupEnvironment) (ToolchainConfig, error) {
	javaExecutable := environmentValue(lookup, "AUTOFORGE_AGENT_JAVA_EXECUTABLE")
	classpathValue := environmentValue(lookup, "AUTOFORGE_AGENT_TESTNG_CLASSPATH")
	javaVersion := environmentValue(lookup, "AUTOFORGE_AGENT_JAVA_VERSION")
	testNGVersion := environmentValue(lookup, "AUTOFORGE_AGENT_TESTNG_VERSION")
	configuredValues := 0
	for _, value := range []string{javaExecutable, classpathValue, javaVersion, testNGVersion} {
		if value != "" {
			configuredValues++
		}
	}
	if configuredValues == 0 {
		return ToolchainConfig{}, nil
	}
	if configuredValues != 4 {
		return ToolchainConfig{}, errors.New("Java executable, classpath, Java version and TestNG version must be configured together")
	}
	if len(javaVersion) > 100 || len(testNGVersion) > 100 {
		return ToolchainConfig{}, errors.New("Java and TestNG versions must not exceed 100 bytes")
	}
	if !filepath.IsAbs(javaExecutable) {
		return ToolchainConfig{}, errors.New("AUTOFORGE_AGENT_JAVA_EXECUTABLE must be an absolute path")
	}
	classpath := filepath.SplitList(classpathValue)
	if len(classpath) == 0 || len(classpath) > 128 {
		return ToolchainConfig{}, errors.New("AUTOFORGE_AGENT_TESTNG_CLASSPATH must contain 1-128 paths")
	}
	for _, entry := range classpath {
		if !filepath.IsAbs(entry) {
			return ToolchainConfig{}, errors.New("AUTOFORGE_AGENT_TESTNG_CLASSPATH entries must be absolute paths")
		}
	}
	return ToolchainConfig{
		JavaExecutable: filepath.Clean(javaExecutable),
		Classpath:      classpath,
		JavaVersion:    javaVersion,
		TestNGVersion:  testNGVersion,
	}, nil
}

func terminalConfig(lookup LookupEnvironment, dataDirectory string) (TerminalConfig, error) {
	enabled, err := optionalBoolean(environmentValue(lookup, "AUTOFORGE_AGENT_TERMINAL_ENABLED"))
	if err != nil {
		return TerminalConfig{}, fmt.Errorf("AUTOFORGE_AGENT_TERMINAL_ENABLED is invalid: %w", err)
	}
	shell := environmentValue(lookup, "AUTOFORGE_AGENT_TERMINAL_SHELL")
	if shell == "" {
		shell = defaultTerminalShell
	}
	if !filepath.IsAbs(shell) {
		return TerminalConfig{}, errors.New("AUTOFORGE_AGENT_TERMINAL_SHELL must be an absolute path")
	}
	maxSessions, err := boundedInteger(
		environmentValue(lookup, "AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS"),
		1,
		1,
		maximumTerminalSessions,
	)
	if err != nil {
		return TerminalConfig{}, fmt.Errorf("AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS is invalid: %w", err)
	}
	maximumDuration, err := boundedDuration(
		environmentValue(lookup, "AUTOFORGE_AGENT_TERMINAL_MAX_DURATION"),
		time.Hour,
		time.Minute,
		8*time.Hour,
	)
	if err != nil {
		return TerminalConfig{}, fmt.Errorf("AUTOFORGE_AGENT_TERMINAL_MAX_DURATION is invalid: %w", err)
	}
	return TerminalConfig{
		Enabled:         enabled,
		Shell:           filepath.Clean(shell),
		WorkDirectory:   filepath.Join(dataDirectory, "work", "terminal"),
		MaxSessions:     maxSessions,
		MaximumDuration: maximumDuration,
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

func optionalBoolean(raw string) (bool, error) {
	if raw == "" {
		return false, nil
	}
	parsed, err := strconv.ParseBool(raw)
	if err != nil {
		return false, errors.New("must be true or false")
	}
	return parsed, nil
}

func boundedInteger(raw string, fallback, minimum, maximum int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("must be an integer from %d to %d", minimum, maximum)
	}
	return parsed, nil
}

func boundedDuration(raw string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	if raw == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("must be a duration from %s to %s", minimum, maximum)
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
