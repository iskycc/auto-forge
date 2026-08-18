package executor

import (
	"context"
	"errors"
	"fmt"
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

func TestDiscoverArtifactsSkipsMatchedSymlinksAndDetectsMissingRequiredPatterns(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "report.xml")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	// 命中规则的符号链接被跳过而不是拒绝整轮扫描：绝不跟随链接读取工作区外的内容，
	// 因此不会收集到任何产物，但用例结果不受影响。
	artifacts, err := DiscoverArtifacts(context.Background(), workspace, []ArtifactRule{{Pattern: "**"}}, 1024)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	if len(artifacts) != 0 {
		t.Fatalf("DiscoverArtifacts() followed a symbolic link: %#v", artifacts)
	}
	clean := t.TempDir()
	_, err = DiscoverArtifacts(context.Background(), clean, []ArtifactRule{{Pattern: "report.xml", Required: true}}, 1024)
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

func TestDiscoverArtifactsStaysWithinByteBudgetBySkipping(t *testing.T) {
	workspace := t.TempDir()
	for _, name := range []string{"first.log", "second.log"} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte("123456"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 超出字节预算的文件被跳过而不是让整个扫描失败：收集结果始终不超过预算。
	artifacts, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "*.log"}},
		10,
	)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	var total int64
	for _, artifact := range artifacts {
		total += artifact.SizeBytes
	}
	if total > 10 {
		t.Fatalf("DiscoverArtifacts() exceeded the byte budget: %#v", artifacts)
	}
	if len(artifacts) != 1 {
		t.Fatalf("expected exactly one artifact within budget, got %#v", artifacts)
	}
}

func TestDiscoverArtifactsCollectsHealthyFilesAroundProblematicOnes(t *testing.T) {
	workspace := t.TempDir()
	reportDirectory := filepath.Join(workspace, "reports", "testng")
	if err := os.MkdirAll(reportDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	// 复现真实用例输出混杂异常文件的场景：正常报告文件与符号链接共存时，
	// 扫描必须收集正常产物而不是整体拒绝（ARTIFACT_DISCOVERY_REJECTED 回归防护）。
	if err := os.WriteFile(filepath.Join(reportDirectory, "testng-results.xml"), []byte("<testng-results/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(reportDirectory, "index.html"), []byte("<html/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside-secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(reportDirectory, "linked.log")); err != nil {
		t.Fatal(err)
	}
	artifacts, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "reports/testng/**"}},
		10_737_418_240,
	)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	collected := map[string]bool{}
	for _, artifact := range artifacts {
		collected[artifact.RelativePath] = true
	}
	if len(artifacts) != 2 || !collected["reports/testng/testng-results.xml"] || !collected["reports/testng/index.html"] {
		t.Fatalf("artifacts = %#v", artifacts)
	}
}

func TestDiscoverArtifactsCapsCountWithoutFailing(t *testing.T) {
	workspace := t.TempDir()
	reportDirectory := filepath.Join(workspace, "reports", "testng")
	if err := os.MkdirAll(reportDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < maximumArtifactCount+4; index++ {
		name := filepath.Join(reportDirectory, fmt.Sprintf("file-%03d.txt", index))
		if err := os.WriteFile(name, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	artifacts, err := DiscoverArtifacts(
		context.Background(),
		workspace,
		[]ArtifactRule{{Pattern: "reports/testng/**"}},
		10_737_418_240,
	)
	if err != nil {
		t.Fatalf("DiscoverArtifacts() error = %v", err)
	}
	if len(artifacts) != maximumArtifactCount {
		t.Fatalf("expected the scan to cap at %d artifacts, got %d", maximumArtifactCount, len(artifacts))
	}
}
