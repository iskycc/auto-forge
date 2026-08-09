package control

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

func testNGExecutorSpec(specification ExecutionSpec, toolchain config.ToolchainConfig) (executor.Spec, ExecutionInput, error) {
	if specification.SchemaVersion != protocolVersion || specification.Executor != "testng" {
		return executor.Spec{}, ExecutionInput{}, errors.New("unsupported execution specification")
	}
	if !toolchain.Enabled() {
		return executor.Spec{}, ExecutionInput{}, errors.New("offline TestNG toolchain is not configured")
	}
	if len(specification.Inputs) != 1 || specification.Inputs[0].Kind != "test-jar" {
		return executor.Spec{}, ExecutionInput{}, errors.New("TestNG execution requires exactly one test JAR")
	}
	if len(specification.MethodDescriptors) > 0 {
		return executor.Spec{}, ExecutionInput{}, errors.New("method-level TestNG selection is not supported by Runner Protocol v1")
	}
	input := specification.Inputs[0]
	if !filepath.IsLocal(input.TargetPath) || filepath.Ext(input.TargetPath) != ".jar" {
		return executor.Spec{}, ExecutionInput{}, errors.New("test JAR target path is invalid")
	}
	environment := make(map[string]string, len(specification.Environment))
	for _, entry := range specification.Environment {
		if _, exists := environment[entry.Name]; exists {
			return executor.Spec{}, ExecutionInput{}, fmt.Errorf("duplicate environment variable %q", entry.Name)
		}
		environment[entry.Name] = entry.Value
	}
	classpath := append([]string{filepath.Clean(input.TargetPath)}, toolchain.Classpath...)
	return executor.Spec{
		SchemaVersion: executor.SupportedSchemaVersion,
		AttemptID:     specification.AttemptID,
		Command: executor.Command{
			Executable: toolchain.JavaExecutable,
			Args: []string{
				"-cp", strings.Join(classpath, string(filepath.ListSeparator)),
				"org.testng.TestNG",
				"-d", "reports/testng",
				"-testclass", specification.ClassName,
			},
		},
		Environment: environment,
		Limits: executor.Limits{
			TimeoutMs:          specification.TimeoutMs,
			MaxLogBytes:        min(specification.ResourceLimits.LogBytes, 64<<20),
			TerminationGraceMs: 2_000,
		},
	}, input, nil
}
