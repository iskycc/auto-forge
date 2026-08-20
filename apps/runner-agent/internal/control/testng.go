package control

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

const testNGLauncherRelativePath = "support/AutoforgeTestNgLauncher.java"

//go:embed AutoforgeTestNgLauncher.java
var testNGLauncherSource []byte

func testNGExecutorSpec(specification ExecutionSpec, toolchain config.ToolchainConfig) (executor.Spec, []ExecutionInput, error) {
	if specification.SchemaVersion != protocolVersion ||
		(specification.Executor != "testng" && specification.Executor != "testng-container") {
		return executor.Spec{}, nil, errors.New("unsupported execution specification")
	}
	if !toolchain.Enabled() {
		return executor.Spec{}, nil, errors.New("offline TestNG toolchain is not configured")
	}
	if len(specification.Inputs) < 1 || len(specification.Inputs) > 128 {
		return executor.Spec{}, nil, errors.New("TestNG execution requires 1-128 JAR inputs")
	}
	methodSelectors := make([]string, 0, len(specification.MethodDescriptors))
	for _, selector := range specification.MethodDescriptors {
		if !validJVMMethodSelector(selector) {
			return executor.Spec{}, nil, fmt.Errorf("invalid JVM method selector %q", selector)
		}
		methodSelectors = append(methodSelectors, selector)
	}
	if len(specification.Parameters) > 128 {
		return executor.Spec{}, nil, errors.New("TestNG execution has too many parameters")
	}
	parameterNames := make([]string, 0, len(specification.Parameters))
	for name, value := range specification.Parameters {
		if !validTestNGParameterName(name) || len(value) > 4_096 {
			return executor.Spec{}, nil, fmt.Errorf("invalid TestNG parameter %q", name)
		}
		parameterNames = append(parameterNames, name)
	}
	sort.Strings(parameterNames)
	inputs := append([]ExecutionInput(nil), specification.Inputs...)
	var testInput *ExecutionInput
	seenIDs := make(map[string]struct{}, len(inputs))
	seenPaths := make(map[string]struct{}, len(inputs))
	for index := range inputs {
		input := &inputs[index]
		if !filepath.IsLocal(input.TargetPath) || strings.ToLower(filepath.Ext(input.TargetPath)) != ".jar" {
			return executor.Spec{}, nil, errors.New("execution JAR target path is invalid")
		}
		if _, duplicate := seenIDs[input.InputID]; duplicate {
			return executor.Spec{}, nil, errors.New("execution input identifier is duplicated")
		}
		if _, duplicate := seenPaths[input.TargetPath]; duplicate {
			return executor.Spec{}, nil, errors.New("execution input target path is duplicated")
		}
		seenIDs[input.InputID] = struct{}{}
		seenPaths[input.TargetPath] = struct{}{}
		switch input.Kind {
		case "test-jar":
			if testInput != nil {
				return executor.Spec{}, nil, errors.New("TestNG execution contains more than one test JAR")
			}
			testInput = input
		case "dependency-jar":
		default:
			return executor.Spec{}, nil, errors.New("execution input kind is unsupported")
		}
	}
	if testInput == nil {
		return executor.Spec{}, nil, errors.New("TestNG execution does not contain a test JAR")
	}
	dependencyPaths := make([]string, 0, len(inputs)-1)
	for _, input := range inputs {
		if input.Kind == "dependency-jar" {
			dependencyPaths = append(dependencyPaths, filepath.Clean(input.TargetPath))
		}
	}
	sort.Strings(dependencyPaths)
	classpath := append([]string{filepath.Clean(testInput.TargetPath)}, dependencyPaths...)
	classpath = append(classpath, toolchain.Classpath...)
	arguments := append(javaUTF8Arguments(),
		"-cp", strings.Join(classpath, string(filepath.ListSeparator)),
		"org.testng.TestNG",
		"-d", "reports/testng",
		"-testclass", specification.ClassName,
	)
	if len(methodSelectors) > 0 || len(parameterNames) > 0 {
		arguments = append(javaUTF8Arguments(),
			"-cp", strings.Join(classpath, string(filepath.ListSeparator)),
			testNGLauncherRelativePath,
			"--output", "reports/testng",
			"--class", specification.ClassName,
		)
		for _, selector := range methodSelectors {
			arguments = append(arguments, "--method", selector)
		}
		for _, name := range parameterNames {
			arguments = append(arguments, "--parameter", name+"="+specification.Parameters[name])
		}
	}
	return executor.Spec{
		SchemaVersion: executor.SupportedSchemaVersion,
		AttemptID:     specification.AttemptID,
		Command: executor.Command{
			Executable: toolchain.JavaExecutable,
			Args:       arguments,
		},
		Environment: map[string]string{},
		Limits: executor.Limits{
			TimeoutMs:          specification.TimeoutMs,
			MaxLogBytes:        min(specification.ResourceLimits.LogBytes, 64<<20),
			TerminationGraceMs: 2_000,
			CPUMillicores:      specification.ResourceLimits.CPUMillicores,
			MemoryBytes:        specification.ResourceLimits.MemoryBytes,
			DiskBytes:          specification.ResourceLimits.DiskBytes,
			ProcessCount:       specification.ResourceLimits.ProcessCount,
			FileCount:          specification.ResourceLimits.FileCount,
		},
	}, inputs, nil
}

func prepareTestNGLauncher(workspace string, methodSelectors []string, parameters map[string]string) error {
	if len(methodSelectors) == 0 && len(parameters) == 0 {
		return nil
	}
	target := filepath.Join(workspace, filepath.FromSlash(testNGLauncherRelativePath))
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create TestNG launcher directory: %w", err)
	}
	if err := os.WriteFile(target, testNGLauncherSource, 0o600); err != nil {
		return fmt.Errorf("write TestNG launcher: %w", err)
	}
	return nil
}

func validTestNGParameterName(name string) bool {
	if len(name) == 0 || len(name) > 128 {
		return false
	}
	for index, character := range name {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || character == '_' {
			continue
		}
		if index > 0 && ((character >= '0' && character <= '9') || character == '.' || character == '-') {
			continue
		}
		return false
	}
	return true
}

func validJVMMethodSelector(selector string) bool {
	descriptorStart := strings.IndexByte(selector, '(')
	if descriptorStart < 1 || descriptorStart > 256 || strings.ContainsAny(selector[:descriptorStart], ".;[/<>") {
		return false
	}
	for _, character := range selector[:descriptorStart] {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			return false
		}
	}
	descriptor := selector[descriptorStart:]
	position := 1
	for position < len(descriptor) && descriptor[position] != ')' {
		next, valid := consumeJVMType(descriptor, position, false)
		if !valid {
			return false
		}
		position = next
	}
	if position >= len(descriptor) || descriptor[position] != ')' {
		return false
	}
	end, valid := consumeJVMType(descriptor, position+1, true)
	return valid && end == len(descriptor)
}

func consumeJVMType(descriptor string, start int, allowVoid bool) (int, bool) {
	position := start
	for position < len(descriptor) && descriptor[position] == '[' {
		position++
	}
	arrayDepth := position - start
	if arrayDepth > 255 || position >= len(descriptor) {
		return 0, false
	}
	if strings.ContainsRune("BCDFIJSZ", rune(descriptor[position])) {
		return position + 1, true
	}
	if descriptor[position] == 'V' {
		return position + 1, allowVoid && arrayDepth == 0
	}
	if descriptor[position] != 'L' {
		return 0, false
	}
	endOffset := strings.IndexByte(descriptor[position+1:], ';')
	if endOffset < 1 {
		return 0, false
	}
	end := position + 1 + endOffset
	className := descriptor[position+1 : end]
	if strings.HasPrefix(className, "/") || strings.HasSuffix(className, "/") || strings.ContainsAny(className, ".;[") || strings.Contains(className, "//") {
		return 0, false
	}
	return end + 1, true
}
