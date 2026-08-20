package control

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDownloadAttemptInputsRejectsAggregateDiskLimitBeforeTransfer(t *testing.T) {
	claimed := ClaimedAssignment{
		Assignment: Assignment{
			ExecutionSpec: ExecutionSpec{ResourceLimits: ResourceLimits{DiskBytes: 10}},
		},
	}
	inputs := []ExecutionInput{
		{InputID: "source-1", SizeBytes: 6, SHA256: strings.Repeat("a", 64)},
		{InputID: "dependency-1", SizeBytes: 5, SHA256: strings.Repeat("b", 64)},
	}

	err := downloadAttemptInputs(context.Background(), nil, Identity{}, claimed, inputs, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "exceed the attempt disk limit") {
		t.Fatalf("downloadAttemptInputs() error = %v", err)
	}
	var limitFailure *executionInputDiskLimitError
	if !errors.As(err, &limitFailure) {
		t.Fatalf("downloadAttemptInputs() error type = %T, want executionInputDiskLimitError", err)
	}
}
