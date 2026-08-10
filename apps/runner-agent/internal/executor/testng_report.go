package executor

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	maximumTestNGReportBytes = 16 << 20
	maximumTestNGXMLDepth    = 64
	maximumTestNGMethods     = 1_000_000
	maximumDetailedSuites    = 32
	maximumDetailedTests     = 64
	maximumDetailedClasses   = 128
	maximumDetailedMethods   = 256
	maximumResultDurationMs  = 86_400_000
)

type TestNGResultCounts struct {
	Total                 int
	Passed                int
	Failed                int
	Skipped               int
	ConfigurationFailures int
}

type TestNGReportSummary struct {
	TestNGResultCounts
	DetailsTruncated bool
	Suites           []TestNGSuiteResult
}

type TestNGSuiteResult struct {
	TestNGResultCounts
	Name       string
	DurationMs int64
	Tests      []TestNGTestResult
}

type TestNGTestResult struct {
	TestNGResultCounts
	Name       string
	DurationMs int64
	Classes    []TestNGClassResult
}

type TestNGClassResult struct {
	TestNGResultCounts
	Name       string
	DurationMs int64
	Methods    []TestNGMethodResult
}

type TestNGMethodResult struct {
	Name          string
	Signature     string
	Status        string
	Configuration bool
	DurationMs    int64
}

func ReadTestNGReport(workspace string) (TestNGReportSummary, bool, error) {
	reportPath := filepath.Join(workspace, "reports", "testng", "testng-results.xml")
	file, err := os.Open(reportPath)
	if errors.Is(err, os.ErrNotExist) {
		return TestNGReportSummary{}, false, nil
	}
	if err != nil {
		return TestNGReportSummary{}, false, fmt.Errorf("open TestNG report: %w", err)
	}
	defer file.Close()
	limited := io.LimitReader(file, maximumTestNGReportBytes+1)
	content, err := io.ReadAll(limited)
	if err != nil {
		return TestNGReportSummary{}, false, fmt.Errorf("read TestNG report: %w", err)
	}
	if len(content) > maximumTestNGReportBytes {
		return TestNGReportSummary{}, false, errors.New("TestNG report exceeds the size limit")
	}
	upper := bytes.ToUpper(content)
	if bytes.Contains(upper, []byte("<!DOCTYPE")) || bytes.Contains(upper, []byte("<!ENTITY")) {
		return TestNGReportSummary{}, false, errors.New("TestNG report contains a forbidden DTD or entity declaration")
	}
	summary, err := parseTestNGReport(content)
	if err != nil {
		return TestNGReportSummary{}, false, err
	}
	return summary, true, nil
}

func parseTestNGReport(content []byte) (TestNGReportSummary, error) {
	decoder := xml.NewDecoder(bytes.NewReader(content))
	decoder.Strict = true
	depth := 0
	methods := 0
	detailedTests := 0
	detailedClasses := 0
	detailedMethods := 0
	summary := TestNGReportSummary{}
	seenRoot := false
	suiteIndex := -1
	testIndex := -1
	classIndex := -1
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return TestNGReportSummary{}, fmt.Errorf("parse TestNG report: %w", err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			depth++
			if depth > maximumTestNGXMLDepth {
				return TestNGReportSummary{}, errors.New("TestNG report nesting exceeds the limit")
			}
			if depth == 1 {
				if element.Name.Local != "testng-results" {
					return TestNGReportSummary{}, errors.New("TestNG report root element is invalid")
				}
				seenRoot = true
			}
			switch element.Name.Local {
			case "suite":
				testIndex = -1
				classIndex = -1
				if len(summary.Suites) >= maximumDetailedSuites {
					summary.DetailsTruncated = true
					suiteIndex = -1
					continue
				}
				duration, durationErr := testNGDuration(element.Attr)
				if durationErr != nil {
					return TestNGReportSummary{}, durationErr
				}
				summary.Suites = append(summary.Suites, TestNGSuiteResult{
					Name: attributeOrDefault(element.Attr, "name", "Unnamed suite", 512), DurationMs: duration,
				})
				suiteIndex = len(summary.Suites) - 1
			case "test":
				classIndex = -1
				if suiteIndex < 0 || detailedTests >= maximumDetailedTests {
					summary.DetailsTruncated = true
					testIndex = -1
					continue
				}
				duration, durationErr := testNGDuration(element.Attr)
				if durationErr != nil {
					return TestNGReportSummary{}, durationErr
				}
				suite := &summary.Suites[suiteIndex]
				suite.Tests = append(suite.Tests, TestNGTestResult{
					Name: attributeOrDefault(element.Attr, "name", "Unnamed test", 512), DurationMs: duration,
				})
				detailedTests++
				testIndex = len(suite.Tests) - 1
			case "class":
				if suiteIndex < 0 || testIndex < 0 || detailedClasses >= maximumDetailedClasses {
					summary.DetailsTruncated = true
					classIndex = -1
					continue
				}
				test := &summary.Suites[suiteIndex].Tests[testIndex]
				test.Classes = append(test.Classes, TestNGClassResult{
					Name: attributeOrDefault(element.Attr, "name", "Unnamed class", 512),
				})
				detailedClasses++
				classIndex = len(test.Classes) - 1
			case "test-method":
				methods++
				if methods > maximumTestNGMethods {
					return TestNGReportSummary{}, errors.New("TestNG report method count exceeds the limit")
				}
				method, methodErr := parseTestNGMethod(element.Attr)
				if methodErr != nil {
					return TestNGReportSummary{}, methodErr
				}
				if method.Status == "" {
					continue
				}
				addTestNGResult(&summary.TestNGResultCounts, method)
				if suiteIndex >= 0 && testIndex >= 0 && classIndex >= 0 {
					suite := &summary.Suites[suiteIndex]
					test := &suite.Tests[testIndex]
					classResult := &test.Classes[classIndex]
					addTestNGResult(&suite.TestNGResultCounts, method)
					addTestNGResult(&test.TestNGResultCounts, method)
					addTestNGResult(&classResult.TestNGResultCounts, method)
					classResult.DurationMs += method.DurationMs
					if detailedMethods < maximumDetailedMethods {
						classResult.Methods = append(classResult.Methods, method)
						detailedMethods++
					} else {
						summary.DetailsTruncated = true
					}
				} else {
					summary.DetailsTruncated = true
				}
			}
		case xml.EndElement:
			switch element.Name.Local {
			case "suite":
				suiteIndex = -1
				testIndex = -1
				classIndex = -1
			case "test":
				testIndex = -1
				classIndex = -1
			case "class":
				classIndex = -1
			}
			depth--
			if depth < 0 {
				return TestNGReportSummary{}, errors.New("TestNG report XML is unbalanced")
			}
		}
	}
	if !seenRoot || depth != 0 {
		return TestNGReportSummary{}, errors.New("TestNG report is incomplete")
	}
	return summary, nil
}

func parseTestNGMethod(attributes []xml.Attr) (TestNGMethodResult, error) {
	status := strings.ToUpper(attributeValue(attributes, "status"))
	configuration, _ := strconv.ParseBool(attributeValue(attributes, "is-config"))
	duration, err := testNGDuration(attributes)
	if err != nil {
		return TestNGMethodResult{}, err
	}
	method := TestNGMethodResult{
		Name:          attributeOrDefault(attributes, "name", "Unnamed method", 256),
		Signature:     boundedTestNGText(strings.TrimSpace(attributeValue(attributes, "signature")), 512),
		Configuration: configuration,
		DurationMs:    duration,
	}
	switch status {
	case "PASS":
		method.Status = "passed"
	case "FAIL":
		method.Status = "failed"
	case "SKIP":
		method.Status = "skipped"
	}
	return method, nil
}

func addTestNGResult(counts *TestNGResultCounts, method TestNGMethodResult) {
	if method.Configuration {
		if method.Status == "failed" {
			counts.ConfigurationFailures++
		}
		return
	}
	counts.Total++
	switch method.Status {
	case "passed":
		counts.Passed++
	case "failed":
		counts.Failed++
	case "skipped":
		counts.Skipped++
	}
}

func testNGDuration(attributes []xml.Attr) (int64, error) {
	value := attributeValue(attributes, "duration-ms")
	if value == "" {
		return 0, nil
	}
	duration, err := strconv.ParseInt(value, 10, 64)
	if err != nil || duration < 0 || duration > maximumResultDurationMs {
		return 0, errors.New("TestNG report contains an invalid duration")
	}
	return duration, nil
}

func attributeOrDefault(attributes []xml.Attr, name, fallback string, maximumRunes int) string {
	value := strings.TrimSpace(attributeValue(attributes, name))
	if value == "" {
		return fallback
	}
	return boundedTestNGText(value, maximumRunes)
}

func boundedTestNGText(value string, maximumRunes int) string {
	runes := []rune(value)
	if len(runes) <= maximumRunes {
		return value
	}
	return string(runes[:maximumRunes])
}

func attributeValue(attributes []xml.Attr, name string) string {
	for _, attribute := range attributes {
		if attribute.Name.Local == name {
			return attribute.Value
		}
	}
	return ""
}
