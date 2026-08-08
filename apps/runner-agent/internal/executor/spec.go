package executor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	SupportedSchemaVersion = 1
	maximumSpecBytes       = 1 << 20
	maximumArguments       = 256
	maximumArgumentBytes   = 64 << 10
	maximumEnvironment     = 128
	maximumEnvironmentSize = 64 << 10
	minimumTimeout         = 10 * time.Millisecond
	maximumTimeout         = 24 * time.Hour
	maximumLogBytes        = 64 << 20
	defaultGracePeriod     = 2 * time.Second
)

var (
	attemptIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	environmentName  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	forbiddenShells  = map[string]struct{}{
		"bash": {}, "cmd.exe": {}, "dash": {}, "fish": {}, "ksh": {},
		"powershell": {}, "pwsh": {}, "sh": {}, "zsh": {},
	}
)

type Spec struct {
	SchemaVersion int               `json:"schemaVersion"`
	AttemptID     string            `json:"attemptId"`
	Command       Command           `json:"command"`
	Environment   map[string]string `json:"environment,omitempty"`
	Limits        Limits            `json:"limits"`
}

type Command struct {
	Executable  string   `json:"executable"`
	Args        []string `json:"args"`
	CwdRelative string   `json:"cwdRelative,omitempty"`
}

type Limits struct {
	TimeoutMs          int64 `json:"timeoutMs"`
	MaxLogBytes        int64 `json:"maxLogBytes"`
	TerminationGraceMs int64 `json:"terminationGraceMs,omitempty"`
}

type Policy struct {
	AllowedExecutables []string
}

func ReadSpec(path string) (Spec, error) {
	file, err := os.Open(path)
	if err != nil {
		return Spec{}, fmt.Errorf("open execution spec: %w", err)
	}
	defer file.Close()

	limited := io.LimitReader(file, maximumSpecBytes+1)
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	var spec Spec
	if err := decoder.Decode(&spec); err != nil {
		return Spec{}, fmt.Errorf("decode execution spec: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return Spec{}, errors.New("execution spec contains more than one JSON value")
		}
		return Spec{}, fmt.Errorf("decode trailing execution spec data: %w", err)
	}
	return spec, nil
}

func Validate(spec Spec, policy Policy) error {
	if spec.SchemaVersion != SupportedSchemaVersion {
		return fmt.Errorf("unsupported schemaVersion %d", spec.SchemaVersion)
	}
	if !attemptIDPattern.MatchString(spec.AttemptID) {
		return errors.New("attemptId must contain 1-128 safe identifier characters")
	}
	if err := validateCommand(spec.Command, policy); err != nil {
		return err
	}
	if err := validateEnvironment(spec.Environment); err != nil {
		return err
	}
	return validateLimits(spec.Limits)
}

func validateCommand(command Command, policy Policy) error {
	if command.Executable == "" || strings.ContainsRune(command.Executable, '\x00') {
		return errors.New("command.executable is required and must not contain NUL")
	}
	if _, forbidden := forbiddenShells[strings.ToLower(filepath.Base(command.Executable))]; forbidden {
		return fmt.Errorf("shell executable %q is disabled", command.Executable)
	}
	if !isExecutableAllowed(command.Executable, policy.AllowedExecutables) {
		return fmt.Errorf("executable %q is not allowed by local policy", command.Executable)
	}
	if len(command.Args) > maximumArguments {
		return fmt.Errorf("command.args exceeds %d entries", maximumArguments)
	}
	for index, argument := range command.Args {
		if len(argument) > maximumArgumentBytes || strings.ContainsRune(argument, '\x00') {
			return fmt.Errorf("command.args[%d] is invalid or too large", index)
		}
	}
	if command.CwdRelative != "" && !filepath.IsLocal(command.CwdRelative) {
		return errors.New("command.cwdRelative must stay inside the attempt workspace")
	}
	return nil
}

func isExecutableAllowed(executable string, allowed []string) bool {
	wanted := filepath.Clean(executable)
	for _, candidate := range allowed {
		if filepath.Clean(candidate) == wanted {
			return true
		}
	}
	return false
}

func validateEnvironment(environment map[string]string) error {
	if len(environment) > maximumEnvironment {
		return fmt.Errorf("environment exceeds %d entries", maximumEnvironment)
	}
	totalBytes := 0
	for name, value := range environment {
		if !environmentName.MatchString(name) {
			return fmt.Errorf("environment variable name %q is invalid", name)
		}
		if strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("environment variable %q contains NUL", name)
		}
		totalBytes += len(name) + len(value)
	}
	if totalBytes > maximumEnvironmentSize {
		return fmt.Errorf("environment exceeds %d bytes", maximumEnvironmentSize)
	}
	return nil
}

func validateLimits(limits Limits) error {
	timeout := time.Duration(limits.TimeoutMs) * time.Millisecond
	if timeout < minimumTimeout || timeout > maximumTimeout {
		return fmt.Errorf("limits.timeoutMs must be between %d and %d", minimumTimeout.Milliseconds(), maximumTimeout.Milliseconds())
	}
	if limits.MaxLogBytes < 1 || limits.MaxLogBytes > maximumLogBytes {
		return fmt.Errorf("limits.maxLogBytes must be between 1 and %d", maximumLogBytes)
	}
	gracePeriod := terminationGracePeriod(limits)
	if gracePeriod < 0 || gracePeriod > 30*time.Second {
		return errors.New("limits.terminationGraceMs must be between 0 and 30000")
	}
	return nil
}

func terminationGracePeriod(limits Limits) time.Duration {
	if limits.TerminationGraceMs == 0 {
		return defaultGracePeriod
	}
	return time.Duration(limits.TerminationGraceMs) * time.Millisecond
}
