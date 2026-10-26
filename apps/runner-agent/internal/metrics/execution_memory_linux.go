//go:build linux

package metrics

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// The supervisor supplies only its current execution scopes. Orphans must remain
// ordinary measured usage; they cannot subsidize new executions.
const maximumMemoryScopes = 64

var executionScopePattern = regexp.MustCompile(`^attempt-[a-f0-9]{24}$`)

type executionMemory struct {
	root             string
	anonymousBytes   uint64
	anonymousByScope map[string]uint64
}

func collectExecutionMemory(root string, scopeNames []string, readFile func(string) ([]byte, error)) (executionMemory, error) {
	result := executionMemory{root: root, anonymousByScope: make(map[string]uint64)}
	if root == "" {
		return result, nil
	}
	if len(scopeNames) > maximumMemoryScopes {
		return result, nil
	}
	for _, scopeName := range scopeNames {
		if !executionScopePattern.MatchString(scopeName) {
			continue
		}
		if _, duplicate := result.anonymousByScope[scopeName]; duplicate {
			continue
		}
		path := filepath.Join(root, scopeName, "memory.stat")
		content, err := readFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		} // A completed scope was removed.
		if err != nil {
			return executionMemory{}, fmt.Errorf("read execution memory %s: %w", scopeName, err)
		}
		anonymous, err := memoryStatValue(string(content), "anon")
		if err != nil {
			return executionMemory{}, fmt.Errorf("parse execution memory %s: %w", scopeName, err)
		}
		if anonymous > maximumJSONInteger-result.anonymousBytes {
			return executionMemory{}, errors.New("execution memory exceeds safe JSON range")
		}
		result.anonymousByScope[scopeName] = anonymous
		result.anonymousBytes += anonymous
	}
	return result, nil
}

func memoryStatValue(content, key string) (uint64, error) {
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != key {
			continue
		}
		if len(fields) != 2 {
			return 0, fmt.Errorf("invalid memory statistic %s", key)
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse memory statistic %s: %w", key, err)
		}
		if value > maximumJSONInteger {
			return 0, fmt.Errorf("memory statistic %s exceeds safe JSON range", key)
		}
		return value, nil
	}
	return 0, nil
}

func containsCgroup(parent, child string) bool {
	if child == "" {
		return false
	}
	relative, err := filepath.Rel(parent, child)
	return err == nil && (relative == "." || filepath.IsLocal(relative))
}

func intersectExecutionMemory(before, after executionMemory) executionMemory {
	result := executionMemory{root: before.root}
	for name, anonymous := range before.anonymousByScope {
		result.anonymousBytes += min(anonymous, after.anonymousByScope[name])
	}
	return result
}
