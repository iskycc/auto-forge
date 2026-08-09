//go:build linux

package metrics

import (
	"math"
	"testing"
)

func TestCalculateCPUUtilizationUsesDeltaAfterFirstSample(t *testing.T) {
	first := cpuTimes{total: 1000, idle: 700}
	second := cpuTimes{total: 1200, idle: 800}
	got, err := calculateCPUUtilization(second, first)
	if err != nil {
		t.Fatalf("calculateCPUUtilization() error = %v", err)
	}
	if math.Abs(got-50) > 0.001 {
		t.Fatalf("delta CPU utilization = %v, want 50", got)
	}
}

func TestParseMemoryUtilizationUsesMemAvailable(t *testing.T) {
	got, err := parseMemoryUtilization("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")
	if err != nil {
		t.Fatalf("parseMemoryUtilization() error = %v", err)
	}
	if got != 75 {
		t.Fatalf("memory utilization = %v, want 75", got)
	}
}

func TestParseLoadAverageRejectsInvalidInput(t *testing.T) {
	if _, err := parseLoadAverage("not-a-number 0.2 0.3"); err == nil {
		t.Fatal("parseLoadAverage() accepted invalid input")
	}
}
