package control

import (
	"strings"
	"testing"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
)

func TestDdtInsightURLUsesReachableOriginAndEscapesScope(t *testing.T) {
	base := mustParseURL(t, "https://platform.internal:8443/autoforge/")
	scope := DdtScope{ProjectID: "project/one", ProjectVersionID: "v 2", TestStageID: "SIT"}
	got, err := ddtInsightURL(base, scope)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://platform.internal:8443/autoforge/api/v1/public/ddt/projects/project%2Fone/versions/v%202/stages/SIT/case"
	if got != want {
		t.Fatalf("URL = %q; want %q", got, want)
	}
}

func TestDdtInsightURLRejectsMissingScopeAndCredentialExposure(t *testing.T) {
	scope := DdtScope{ProjectID: "project", ProjectVersionID: "version", TestStageID: "stage"}
	for _, base := range []string{"file:///tmp/platform", "https://user:secret@platform", "https://platform?token=secret", "https://platform#fragment"} {
		if _, err := ddtInsightURL(mustParseURL(t, base), scope); err == nil {
			t.Fatalf("accepted %q", base)
		}
	}
	for _, invalid := range []string{"", "..", "bad\x00id", strings.Repeat("a", 129)} {
		scope.TestStageID = invalid
		if _, err := ddtInsightURL(mustParseURL(t, "http://platform:3100"), scope); err == nil {
			t.Fatalf("accepted scope %q", invalid)
		}
	}
}

func TestCotestAdapterPassesScopedURLOnlyForDDTCases(t *testing.T) {
	for _, caseID := range []string{"", "CASE/1?x=2"} {
		specification := testExecutionSpec()
		specification.Adapter = &AdapterSettings{CaseID: caseID, DdtScope: &DdtScope{ProjectID: "p", ProjectVersionID: "v", TestStageID: "s"}}
		mapped, _, err := cotestAdapterExecutorSpec(specification, config.ToolchainConfig{JavaExecutable: "/usr/bin/java"}, config.AdapterConfig{JarPath: "/opt/adapter.jar"}, mustParseURL(t, "http://platform:3100"))
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for index, argument := range mapped.Command.Args {
			if argument == "--ddt-insight-url" {
				found = mapped.Command.Args[index+1] == "http://platform:3100/api/v1/public/ddt/projects/p/versions/v/stages/s/case"
			}
		}
		if found != (caseID != "") {
			t.Fatalf("unexpected scoped API URL for CaseID %q: %q", caseID, mapped.Command.Args)
		}
	}
}

func TestDdtInsightURLKeepsPersonalOwnerAndReadKeyAcrossExecution(t *testing.T) {
	scope := DdtScope{ProjectID: "p", ProjectVersionID: "v", TestStageID: "s", Debug: &DdtDebugAccess{OwnerUserID: "user/one", AccessKey: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"}}
	got, err := ddtInsightURL(mustParseURL(t, "http://platform/base"), scope)
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://platform/base/api/v1/public/ddt/projects/p/versions/v/stages/s/users/user%2Fone/debug/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/case" {
		t.Fatal(got)
	}
	for _, invalid := range []DdtDebugAccess{{OwnerUserID: "", AccessKey: scope.Debug.AccessKey}, {OwnerUserID: "user", AccessKey: "bad"}, {OwnerUserID: "..", AccessKey: scope.Debug.AccessKey}} {
		scope.Debug = &invalid
		if _, err := ddtInsightURL(mustParseURL(t, "http://platform"), scope); err == nil {
			t.Fatalf("accepted invalid personal scope: %#v", invalid)
		}
	}
}
