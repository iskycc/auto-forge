package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maximumArtifactCount      = 256
	maximumSingleArtifactSize = 256 << 20
)

type RequiredArtifactMissingError struct {
	Pattern string
}

func (problem *RequiredArtifactMissingError) Error() string {
	return fmt.Sprintf("required artifact pattern %q matched no files", problem.Pattern)
}

type ArtifactRule struct {
	Pattern   string
	Required  bool
	MediaType string
}

type Artifact struct {
	RelativePath string
	AbsolutePath string
	MediaType    string
	SizeBytes    int64
	SHA256       string
	Required     bool
}

type compiledArtifactRule struct {
	ArtifactRule
	pattern *regexp.Regexp
	matched bool
}

func DiscoverArtifacts(ctx context.Context, workspace string, rules []ArtifactRule, maximumBytes int64) ([]Artifact, error) {
	if maximumBytes < 1 {
		return nil, errors.New("artifact byte limit must be positive")
	}
	compiled, err := compileArtifactRules(rules)
	if err != nil {
		return nil, err
	}
	artifacts := make([]Artifact, 0)
	var totalBytes int64
	err = filepath.WalkDir(workspace, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == workspace {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(workspace, path)
		if err != nil || !filepath.IsLocal(relative) {
			return errors.New("artifact path escapes the attempt workspace")
		}
		relative = filepath.ToSlash(relative)
		matchedRule := -1
		for index := range compiled {
			if compiled[index].pattern.MatchString(relative) {
				matchedRule = index
				break
			}
		}
		if matchedRule < 0 {
			// 与任何产物规则无关的文件（含工具链 JDK legal 下的符号链接）直接跳过，
			// 不参与收集也不算入配额。
			return nil
		}
		rule := &compiled[matchedRule]
		// 产物收集是尽力而为的辅助能力，用例真实结果由 TestNG 报告与进程退出码决定：
		// 命中规则的符号链接、特殊文件、超过大小/数量/字节预算的文件一律跳过（从不跟随
		// 符号链接、从不读取），而不是让整个扫描失败并推翻用例结果。
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		if len(artifacts) >= maximumArtifactCount {
			return nil
		}
		if info.Size() > min(maximumBytes, int64(maximumSingleArtifactSize)) {
			return nil
		}
		if info.Size() > maximumBytes-totalBytes {
			return nil
		}
		digest, err := fileSHA256(path)
		if err != nil {
			return nil
		}
		mediaType := rule.MediaType
		if mediaType == "" {
			mediaType = mime.TypeByExtension(filepath.Ext(path))
		}
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		artifacts = append(artifacts, Artifact{
			RelativePath: relative,
			AbsolutePath: path,
			MediaType:    mediaType,
			SizeBytes:    info.Size(),
			SHA256:       digest,
			Required:     rule.Required,
		})
		rule.matched = true
		totalBytes += info.Size()
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("discover artifacts: %w", err)
	}
	for _, rule := range compiled {
		if rule.Required && !rule.matched {
			return nil, &RequiredArtifactMissingError{Pattern: rule.Pattern}
		}
	}
	return artifacts, nil
}

func compileArtifactRules(rules []ArtifactRule) ([]compiledArtifactRule, error) {
	if len(rules) > 64 {
		return nil, errors.New("artifact rules exceed 64 entries")
	}
	compiled := make([]compiledArtifactRule, 0, len(rules))
	for _, rule := range rules {
		if rule.Pattern == "" || len(rule.Pattern) > 512 || strings.Contains(rule.Pattern, "\\") || !filepath.IsLocal(rule.Pattern) {
			return nil, fmt.Errorf("artifact pattern %q is invalid", rule.Pattern)
		}
		pattern, err := compileGlob(rule.Pattern)
		if err != nil {
			return nil, err
		}
		compiled = append(compiled, compiledArtifactRule{ArtifactRule: rule, pattern: pattern})
	}
	return compiled, nil
}

func compileGlob(pattern string) (*regexp.Regexp, error) {
	var expression strings.Builder
	expression.WriteString("^")
	for index := 0; index < len(pattern); index++ {
		switch pattern[index] {
		case '*':
			if index+1 < len(pattern) && pattern[index+1] == '*' {
				index++
				if index+1 < len(pattern) && pattern[index+1] == '/' {
					index++
					expression.WriteString("(?:.*/)?")
				} else {
					expression.WriteString(".*")
				}
			} else {
				expression.WriteString("[^/]*")
			}
		case '?':
			expression.WriteString("[^/]")
		default:
			expression.WriteString(regexp.QuoteMeta(string(pattern[index])))
		}
	}
	expression.WriteString("$")
	return regexp.Compile(expression.String())
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open artifact for hashing: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", fmt.Errorf("hash artifact: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
