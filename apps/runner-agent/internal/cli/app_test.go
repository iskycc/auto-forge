package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
)

func TestVersionWritesMachineReadableBuildInformation(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run([]string{"version"}, &stdout, &stderr, buildinfo.Info{
		Version:   "1.2.3",
		Commit:    "abc123",
		BuildDate: "2026-08-09T00:00:00Z",
		Variant:   "amd64-musl",
	})

	if exitCode != exitSuccess {
		t.Fatalf("exitCode = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, expected := range []string{`"version":"1.2.3"`, `"variant":"amd64-musl"`} {
		if !strings.Contains(stdout.String(), expected) {
			t.Fatalf("stdout = %q, want %s", stdout.String(), expected)
		}
	}
}

func TestUnknownCommandReturnsUsageError(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run([]string{"unknown"}, &stdout, &stderr, buildinfo.Info{})
	if exitCode != exitUsage {
		t.Fatalf("exitCode = %d, want %d", exitCode, exitUsage)
	}
	if !strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestHealthLiveDoesNotRequireConfiguration(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run([]string{"health", "live"}, &stdout, &stderr, buildinfo.Info{})
	if exitCode != exitSuccess {
		t.Fatalf("exitCode = %d, stderr = %q", exitCode, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"status":"live"`) {
		t.Fatalf("stdout = %q", stdout.String())
	}
}
