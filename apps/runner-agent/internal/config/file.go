package config

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const fileSchemaVersion = 1

type fileConfiguration struct {
	SchemaVersion   int                 `json:"schemaVersion"`
	ServerURL       string              `json:"serverUrl"`
	DataDirectory   string              `json:"dataDirectory"`
	Name            string              `json:"name"`
	Labels          []string            `json:"labels"`
	MaxConcurrency  *int                `json:"maxConcurrency"`
	CAFile          string              `json:"caFile"`
	BootstrapToken  string              `json:"bootstrapToken"`
	RecoverIdentity *bool               `json:"recoverIdentity,omitempty"`
	Toolchain       fileToolchainConfig `json:"toolchain"`
	Adapter         fileAdapterConfig   `json:"adapter"`
	Container       fileContainerConfig `json:"container"`
	Claim           fileClaimConfig     `json:"claim"`
	Spool           fileSpoolConfig     `json:"spool"`
	Resources       fileResourceConfig  `json:"resources"`
	Terminal        fileTerminalConfig  `json:"terminal"`
}

type fileAdapterConfig struct {
	JarPath string `json:"jarPath"`
}

type fileToolchainConfig struct {
	JavaExecutable string   `json:"javaExecutable"`
	Classpath      []string `json:"classpath"`
	JavaVersion    string   `json:"javaVersion"`
	TestNGVersion  string   `json:"testngVersion"`
}

type fileContainerConfig struct {
	RuntimeExecutable string   `json:"runtimeExecutable"`
	ImageReference    string   `json:"imageReference"`
	SeccompProfile    string   `json:"seccompProfile"`
	User              string   `json:"user"`
	JavaExecutable    string   `json:"javaExecutable"`
	Classpath         []string `json:"classpath"`
}

type fileClaimConfig struct {
	Wait              string `json:"wait"`
	MaximumBackoff    string `json:"maximumBackoff"`
	ShutdownGraceTime string `json:"shutdownGraceTime"`
}

type fileSpoolConfig struct {
	MaximumBytes *int64 `json:"maximumBytes"`
	Retention    string `json:"retention"`
	UploadBatch  *int   `json:"uploadBatch"`
}

type fileResourceConfig struct {
	CgroupRoot string `json:"cgroupRoot"`
}

type fileTerminalConfig struct {
	Enabled         *bool  `json:"enabled"`
	Shell           string `json:"shell"`
	MaximumSessions *int   `json:"maximumSessions"`
	MaximumDuration string `json:"maximumDuration"`
}

// LoadFile reads a private, versioned Agent configuration without consulting
// process environment. Unknown fields are rejected so misspelled security
// policy cannot silently fall back to a weaker default.
func LoadFile(path string) (Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Config{}, fmt.Errorf("stat Agent configuration: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Config{}, errors.New("Agent configuration must not be readable or writable by group or other users")
	}
	persisted, err := readFileConfiguration(path)
	if err != nil {
		return Config{}, err
	}
	configuration, err := Load(configurationLookup(persisted))
	if err != nil {
		return Config{}, err
	}
	configuration.ConfigurationFile = filepath.Clean(path)
	return configuration, nil
}

// ConsumeBootstrapToken removes the one-time registration secret after the
// durable Runner identity has been saved.
func ConsumeBootstrapToken(path string) error {
	persisted, err := readFileConfiguration(path)
	if err != nil {
		return err
	}
	if persisted.BootstrapToken == "" && persisted.RecoverIdentity == nil {
		return nil
	}
	persisted.BootstrapToken = ""
	persisted.RecoverIdentity = nil
	randomValue := make([]byte, 12)
	if _, err := rand.Read(randomValue); err != nil {
		return fmt.Errorf("generate temporary Agent configuration name: %w", err)
	}
	temporaryPath := fmt.Sprintf("%s.%x.tmp", path, randomValue)
	file, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create temporary Agent configuration: %w", err)
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	writeErr := encoder.Encode(persisted)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(temporaryPath)
		return errors.Join(writeErr, closeErr)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("replace Agent configuration: %w", err)
	}
	return nil
}

func readFileConfiguration(path string) (fileConfiguration, error) {
	file, err := os.Open(filepath.Clean(path))
	if err != nil {
		return fileConfiguration{}, fmt.Errorf("open Agent configuration: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var persisted fileConfiguration
	if err := decoder.Decode(&persisted); err != nil {
		return fileConfiguration{}, fmt.Errorf("decode Agent configuration: %w", err)
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return fileConfiguration{}, err
	}
	if persisted.SchemaVersion != fileSchemaVersion {
		return fileConfiguration{}, fmt.Errorf(
			"unsupported Agent configuration schemaVersion %d",
			persisted.SchemaVersion,
		)
	}
	return persisted, nil
}

func rejectTrailingJSON(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("Agent configuration must contain exactly one JSON object")
		}
		return fmt.Errorf("decode trailing Agent configuration: %w", err)
	}
	return nil
}

func configurationLookup(persisted fileConfiguration) LookupEnvironment {
	values := map[string]string{
		"AUTOFORGE_SERVER_URL":                       persisted.ServerURL,
		"AUTOFORGE_AGENT_DATA_DIR":                   persisted.DataDirectory,
		"AUTOFORGE_AGENT_NAME":                       persisted.Name,
		"AUTOFORGE_AGENT_LABELS":                     strings.Join(persisted.Labels, ","),
		"AUTOFORGE_AGENT_CA_FILE":                    persisted.CAFile,
		"AUTOFORGE_AGENT_BOOTSTRAP_TOKEN":            persisted.BootstrapToken,
		"AUTOFORGE_AGENT_JAVA_EXECUTABLE":            persisted.Toolchain.JavaExecutable,
		"AUTOFORGE_AGENT_TESTNG_CLASSPATH":           strings.Join(persisted.Toolchain.Classpath, string(os.PathListSeparator)),
		"AUTOFORGE_AGENT_JAVA_VERSION":               persisted.Toolchain.JavaVersion,
		"AUTOFORGE_AGENT_TESTNG_VERSION":             persisted.Toolchain.TestNGVersion,
		"AUTOFORGE_AGENT_ADAPTER_JAR":                persisted.Adapter.JarPath,
		"AUTOFORGE_AGENT_CONTAINER_RUNTIME":          persisted.Container.RuntimeExecutable,
		"AUTOFORGE_AGENT_CONTAINER_IMAGE":            persisted.Container.ImageReference,
		"AUTOFORGE_AGENT_CONTAINER_SECCOMP":          persisted.Container.SeccompProfile,
		"AUTOFORGE_AGENT_CONTAINER_USER":             persisted.Container.User,
		"AUTOFORGE_AGENT_CONTAINER_JAVA_EXECUTABLE":  persisted.Container.JavaExecutable,
		"AUTOFORGE_AGENT_CONTAINER_TESTNG_CLASSPATH": strings.Join(persisted.Container.Classpath, string(os.PathListSeparator)),
		"AUTOFORGE_AGENT_CLAIM_WAIT":                 persisted.Claim.Wait,
		"AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF":          persisted.Claim.MaximumBackoff,
		"AUTOFORGE_AGENT_SHUTDOWN_GRACE":             persisted.Claim.ShutdownGraceTime,
		"AUTOFORGE_AGENT_SPOOL_RETENTION":            persisted.Spool.Retention,
		"AUTOFORGE_AGENT_CGROUP_ROOT":                persisted.Resources.CgroupRoot,
		"AUTOFORGE_AGENT_TERMINAL_SHELL":             persisted.Terminal.Shell,
		"AUTOFORGE_AGENT_TERMINAL_MAX_DURATION":      persisted.Terminal.MaximumDuration,
	}
	setOptionalBoolean(values, "AUTOFORGE_AGENT_RECOVER_IDENTITY", persisted.RecoverIdentity)
	setOptionalInteger(values, "AUTOFORGE_AGENT_MAX_CONCURRENCY", persisted.MaxConcurrency)
	setOptionalInteger(values, "AUTOFORGE_AGENT_LOG_UPLOAD_BATCH", persisted.Spool.UploadBatch)
	setOptionalInt64(values, "AUTOFORGE_AGENT_SPOOL_MAX_BYTES", persisted.Spool.MaximumBytes)
	setOptionalBoolean(values, "AUTOFORGE_AGENT_TERMINAL_ENABLED", persisted.Terminal.Enabled)
	setOptionalInteger(values, "AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS", persisted.Terminal.MaximumSessions)
	return func(key string) (string, bool) {
		value, found := values[key]
		return value, found
	}
}

func setOptionalInteger(values map[string]string, key string, value *int) {
	if value != nil {
		values[key] = strconv.Itoa(*value)
	}
}

func setOptionalInt64(values map[string]string, key string, value *int64) {
	if value != nil {
		values[key] = strconv.FormatInt(*value, 10)
	}
}

func setOptionalBoolean(values map[string]string, key string, value *bool) {
	if value != nil {
		values[key] = strconv.FormatBool(*value)
	}
}
