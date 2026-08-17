package executor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverArtifactsHashesBoundedRegularFiles(t *testing.T) {
	workspace := t.TempDir()
	report := filepath.Join(workspace, "reports", "testng", "results.xml")
	if err := os.MkdirAll(filepath.Dir(report), 0o700); err != nil {
		t.Fatalf("create report directory: %v", err)
	}
	if err := os.WriteFile(report, []byte("<testng-results/>"), 0o600); err != nil {
		t.Fatalf("write report: %v", err)
	}
	artifacts, err := DiscoverArtifacts(context.Background(), workspace, []ArtifactRule{{
		Pattern: "reports/testng/**", Required: true, MediaType: "application/xml",
	}}, 1024)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	if len(artifacts) != 1 || artifacts[0].RelativePath != "reports/testng/results.xml" || len(artifacts[0].SHA256) != 64 {
		t.Fatalf("artifacts = %#v", artifacts)
	}
}

func TestDiscoverArtifactsRejectsSymlinksAndMissingRequiredPatterns(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "report.xml")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	if _, err := DiscoverArtifacts(context.Background(), workspace, []ArtifactRule{{Pattern: "**"}}, 1024); err == nil {
		t.Fatal("DiscoverArtifacts() accepted a symbolic link")
	}
	clean := t.TempDir()
	_, err := DiscoverArtifacts(context.Background(), clean, []ArtifactRule{{Pattern: "report.xml", Required: true}}, 1024)
	var missing *RequiredArtifactMissingError
	if !errors.As(err, &missing) || missing.Pattern != "report.xml" {
		t.Fatalf("expected missing required artifact error, got %v", err)
	}
}

func TestDiscoverArtifactsAllowsEmptyOptionalRulesAndRejectsTraversal(t *testing.T) {
	workspace := t.TempDir()
	artifacts, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "reports/*.xml"}},
		1024,
	)
	if err != nil || len(artifacts) != 0 {
		t.Fatalf("optional empty match = %#v, error = %v", artifacts, err)
	}
	if _, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "../secret"}},
		1024,
	); err == nil {
		t.Fatal("DiscoverArtifacts() accepted a traversal pattern")
	}
}

func TestDiscoverArtifactsSkipsUnmatchedToolchainSymlinks(t *testing.T) {
	workspace := t.TempDir()
	// 复现 JDK legal 目录场景：runtime 下的符号链接不匹配任何产物规则，不得导致扫描失败。
	legal := filepath.Join(workspace, "runtime", "jdk", "legal", "java.compiler")
	if err := os.MkdirAll(legal, 0o700); err != nil {
		t.Fatalf("create legal directory: %v", err)
	}
	target := filepath.Join(legal, "LICENSE")
	if err := os.WriteFile(target, []byte("license"), 0o600); err != nil {
		t.Fatalf("write link target: %v", err)
	}
	if err := os.Symlink("LICENSE", filepath.Join(legal, "ADDITIONAL_LICENSE_INFO")); err != nil {
		t.Fatalf("create toolchain symlink: %v", err)
	}
	report := filepath.Join(workspace, "reports", "testng", "results.xml")
	if err := os.MkdirAll(filepath.Dir(report), 0o700); err != nil {
		t.Fatalf("create report directory: %v", err)
	}
	if err := os.WriteFile(report, []byte("<testng-results/>"), 0o600); err != nil {
		t.Fatalf("write report: %v", err)
	}
	artifacts, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "reports/testng/**", Required: true, MediaType: "application/xml"}},
		1024,
	)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	if len(artifacts) != 1 || artifacts[0].RelativePath != "reports/testng/results.xml" {
		t.Fatalf("artifacts = %#v", artifacts)
	}
}

func TestDiscoverArtifactsRejectsAggregateByteOverflow(t *testing.T) {
	workspace := t.TempDir()
	for _, name := range []string{"first.log", "second.log"} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte("123456"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "*.log"}},
		10,
	); err == nil {
		t.Fatal("DiscoverArtifacts() accepted artifacts above the aggregate byte limit")
	}
}
