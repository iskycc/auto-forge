package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadTestNGReportClassifiesMethods(t *testing.T) {
	workspace := t.TempDir()
	reportDirectory := filepath.Join(workspace, "reports", "testng")
	if err := os.MkdirAll(reportDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	content := `<testng-results><suite name="Suite A" duration-ms="11"><test name="Test A" duration-ms="10"><class name="example.SmokeTest">` +
		`<test-method name="passes" signature="passes()[pri:0, instance:null]" status="PASS" duration-ms="2"/>` +
		`<test-method name="fails" status="FAIL" duration-ms="3"/>` +
		`<test-method name="skips" status="SKIP" duration-ms="4"/>` +
		`<test-method name="before" status="FAIL" is-config="true" duration-ms="1"/>` +
		`</class></test></suite></testng-results>`
	if err := os.WriteFile(filepath.Join(reportDirectory, "testng-results.xml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	summary, found, err := ReadTestNGReport(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if !found || summary.Total != 3 || summary.Passed != 1 || summary.Failed != 1 || summary.Skipped != 1 || summary.ConfigurationFailures != 1 {
		t.Fatalf("unexpected TestNG summary: %#v, found=%v", summary, found)
	}
	if len(summary.Suites) != 1 || summary.Suites[0].Name != "Suite A" || summary.Suites[0].DurationMs != 11 {
		t.Fatalf("unexpected suite details: %#v", summary.Suites)
	}
	classResult := summary.Suites[0].Tests[0].Classes[0]
	if classResult.Name != "example.SmokeTest" || classResult.DurationMs != 10 || len(classResult.Methods) != 4 {
		t.Fatalf("unexpected class details: %#v", classResult)
	}
	if classResult.Methods[0].Name != "passes" || classResult.Methods[0].Status != "passed" {
		t.Fatalf("unexpected method details: %#v", classResult.Methods[0])
	}
}

func TestReadTestNGReportBoundsMethodDetails(t *testing.T) {
	var content strings.Builder
	content.WriteString(`<testng-results><suite name="suite"><test name="test"><class name="class">`)
	for method := 0; method < maximumDetailedMethods+1; method++ {
		content.WriteString(`<test-method name="method" status="PASS" duration-ms="1"/>`)
	}
	content.WriteString(`</class></test></suite></testng-results>`)
	summary, err := parseTestNGReport([]byte(content.String()))
	if err != nil {
		t.Fatal(err)
	}
	if !summary.DetailsTruncated || summary.Total != maximumDetailedMethods+1 {
		t.Fatalf("unexpected bounded summary: %#v", summary)
	}
	if methods := summary.Suites[0].Tests[0].Classes[0].Methods; len(methods) != maximumDetailedMethods {
		t.Fatalf("detailed methods = %d, want %d", len(methods), maximumDetailedMethods)
	}
}

func TestReadTestNGReportRejectsDoctypeAndDeepNesting(t *testing.T) {
	for name, content := range map[string]string{
		"doctype": `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testng-results/>`,
		"depth":   `<testng-results>` + strings.Repeat("<suite>", maximumTestNGXMLDepth) + strings.Repeat("</suite>", maximumTestNGXMLDepth) + `</testng-results>`,
	} {
		t.Run(name, func(t *testing.T) {
			workspace := t.TempDir()
			reportDirectory := filepath.Join(workspace, "reports", "testng")
			if err := os.MkdirAll(reportDirectory, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(reportDirectory, "testng-results.xml"), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := ReadTestNGReport(workspace); err == nil {
				t.Fatal("expected unsafe TestNG report to be rejected")
			}
		})
	}
}
