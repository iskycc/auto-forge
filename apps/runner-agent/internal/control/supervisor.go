package control

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type attemptSupervisor struct {
	client        *Client
	identity      Identity
	configuration config.Config
	store         attemptStore
	diagnostics   io.Writer
	draining      atomic.Bool
	busy          atomic.Int32
	waitGroup     sync.WaitGroup
	mutex         sync.Mutex
	cancellations map[string]context.CancelFunc
}

func newAttemptSupervisor(client *Client, identity Identity, configuration config.Config, diagnostics io.Writer) *attemptSupervisor {
	return &attemptSupervisor{
		client:        client,
		identity:      identity,
		configuration: configuration,
		store:         newAttemptStore(configuration.DataDirectory),
		diagnostics:   diagnostics,
		cancellations: make(map[string]context.CancelFunc),
	}
}

func (supervisor *attemptSupervisor) Start(ctx context.Context) error {
	if err := supervisor.reconcile(ctx); err != nil {
		return err
	}
	supervisor.waitGroup.Add(1)
	go func() {
		defer supervisor.waitGroup.Done()
		supervisor.claimLoop(ctx)
	}()
	return nil
}

func (supervisor *attemptSupervisor) BusySlots() int {
	return int(supervisor.busy.Load())
}

func (supervisor *attemptSupervisor) BeginDrain() {
	supervisor.draining.Store(true)
}

func (supervisor *attemptSupervisor) Close() {
	supervisor.BeginDrain()
	completed := make(chan struct{})
	go func() {
		supervisor.waitGroup.Wait()
		close(completed)
	}()
	select {
	case <-completed:
		return
	case <-time.After(supervisor.configuration.Claim.ShutdownGracePeriod):
	}
	supervisor.mutex.Lock()
	for _, cancel := range supervisor.cancellations {
		cancel()
	}
	supervisor.mutex.Unlock()
	<-completed
}

func (supervisor *attemptSupervisor) claimLoop(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil || supervisor.draining.Load() {
			return
		}
		availableSlots := supervisor.configuration.MaxConcurrent - supervisor.BusySlots()
		if availableSlots <= 0 || !supervisor.configuration.Toolchain.Enabled() {
			if !waitFor(ctx, time.Second) {
				return
			}
			continue
		}
		response, err := supervisor.client.Claim(ctx, supervisor.identity, supervisor.configuration, availableSlots)
		if err != nil {
			fmt.Fprintf(supervisor.diagnostics, "assignment claim failed: %v\n", err)
			if !waitFor(ctx, jitter(backoff)) {
				return
			}
			backoff = min(backoff*2, supervisor.configuration.Claim.MaximumBackoff)
			continue
		}
		backoff = time.Second
		for _, claimed := range response.Assignments {
			if err := supervisor.startAttempt(claimed); err != nil {
				fmt.Fprintf(supervisor.diagnostics, "assignment %s rejected locally: %v\n", claimed.Assignment.AssignmentID, err)
			}
		}
		if len(response.Assignments) == 0 && !waitFor(ctx, time.Duration(response.RetryAfterMs)*time.Millisecond) {
			return
		}
	}
}

func (supervisor *attemptSupervisor) startAttempt(claimed ClaimedAssignment) error {
	if err := validateClaimedAssignment(
		claimed,
		supervisor.identity.RunnerID,
		supervisor.configuration.RunnerLabels(),
		supervisor.configuration.Toolchain.Capabilities(),
	); err != nil {
		return err
	}
	attemptID := claimed.Assignment.AttemptID
	state := attemptState{SchemaVersion: attemptStateSchemaVersion, Claimed: claimed, LocalState: "claimed"}
	executionContext, cancel := context.WithCancel(context.Background())
	supervisor.mutex.Lock()
	if _, exists := supervisor.cancellations[attemptID]; exists {
		supervisor.mutex.Unlock()
		cancel()
		return errors.New("attempt is already running locally")
	}
	supervisor.cancellations[attemptID] = cancel
	supervisor.mutex.Unlock()
	if err := supervisor.store.save(state); err != nil {
		supervisor.mutex.Lock()
		delete(supervisor.cancellations, attemptID)
		supervisor.mutex.Unlock()
		cancel()
		return err
	}
	supervisor.busy.Add(1)
	supervisor.waitGroup.Add(1)
	go func() {
		defer supervisor.waitGroup.Done()
		defer supervisor.busy.Add(-1)
		defer func() {
			supervisor.mutex.Lock()
			delete(supervisor.cancellations, attemptID)
			supervisor.mutex.Unlock()
			cancel()
		}()
		supervisor.executeAttempt(executionContext, cancel, state)
	}()
	return nil
}

func (supervisor *attemptSupervisor) executeAttempt(ctx context.Context, cancel context.CancelFunc, state attemptState) {
	state.LocalState = "running"
	if err := supervisor.store.save(state); err != nil {
		fmt.Fprintf(supervisor.diagnostics, "persist running attempt %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		cancel()
		return
	}
	reportAllowed := &atomic.Bool{}
	reportAllowed.Store(true)
	renewContext, stopRenewal := context.WithCancel(context.Background())
	renewed := make(chan struct{})
	go func() {
		defer close(renewed)
		supervisor.renewLease(renewContext, cancel, &state, reportAllowed)
	}()

	result := supervisor.runTestNG(ctx, state.Claimed)
	stopRenewal()
	<-renewed
	if !reportAllowed.Load() {
		fmt.Fprintf(supervisor.diagnostics, "attempt %s lost its lease; completion retained locally\n", state.Claimed.Assignment.AttemptID)
		return
	}
	completionID, err := randomIdentifier()
	if err != nil {
		fmt.Fprintf(supervisor.diagnostics, "create completion ID for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		return
	}
	state.LocalState = "finishing"
	state.CompletionID = completionID
	state.Result = &result
	if err := supervisor.store.save(state); err != nil {
		fmt.Fprintf(supervisor.diagnostics, "persist completion for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		return
	}
	supervisor.reportCompletion(context.Background(), state)
}

func (supervisor *attemptSupervisor) runTestNG(ctx context.Context, claimed ClaimedAssignment) completionResult {
	specification, input, err := testNGExecutorSpec(claimed.Assignment.ExecutionSpec, supervisor.configuration.Toolchain)
	if err != nil {
		return platformFailure("EXECUTION_SPEC_REJECTED", err)
	}
	result, err := executor.Run(ctx, specification, executor.RunOptions{
		DataDirectory: supervisor.configuration.DataDirectory,
		Policy:        executor.Policy{AllowedExecutables: []string{supervisor.configuration.Toolchain.JavaExecutable}},
		PrepareWorkspace: func(workspace string) error {
			return downloadAttemptInput(ctx, supervisor.client, supervisor.identity, claimed, input, workspace)
		},
	})
	if err != nil {
		return platformFailure("PROCESS_START_FAILED", err)
	}
	return mapExecutionResult(result)
}

func (supervisor *attemptSupervisor) renewLease(ctx context.Context, cancelExecution context.CancelFunc, state *attemptState, reportAllowed *atomic.Bool) {
	lease := state.Claimed.Lease
	for {
		expiresAt, err := time.Parse(time.RFC3339Nano, lease.ExpiresAt)
		if err != nil {
			reportAllowed.Store(false)
			cancelExecution()
			return
		}
		remaining := time.Until(expiresAt)
		if remaining <= 0 {
			reportAllowed.Store(false)
			cancelExecution()
			return
		}
		if !waitFor(ctx, min(15*time.Second, max(time.Second, remaining/3))) {
			return
		}
		response, renewErr := supervisor.client.RenewLease(ctx, supervisor.identity, lease)
		if renewErr != nil {
			if isPermanentLeaseRejection(renewErr) {
				reportAllowed.Store(false)
				cancelExecution()
				return
			}
			if time.Until(expiresAt) <= 2*time.Second {
				reportAllowed.Store(false)
				cancelExecution()
				return
			}
			fmt.Fprintf(supervisor.diagnostics, "lease renewal failed for %s: %v\n", state.Claimed.Assignment.AttemptID, renewErr)
			continue
		}
		lease.Version = response.LeaseVersion
		lease.ExpiresAt = response.ExpiresAt
		state.Claimed.Lease = lease
		if err := supervisor.store.save(*state); err != nil {
			fmt.Fprintf(supervisor.diagnostics, "persist renewed lease for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		}
		switch response.Instruction {
		case "cancel":
			cancelExecution()
			return
		case "drain":
			supervisor.BeginDrain()
		}
	}
}

func isPermanentLeaseRejection(err error) bool {
	var problem *APIError
	if !errors.As(err, &problem) {
		return false
	}
	switch problem.Code {
	case "LEASE_AUTH_REJECTED", "LEASE_EXPIRED", "LEASE_VERSION_CONFLICT", "RUNNER_AUTH_REJECTED", "RUNNER_DISABLED":
		return true
	default:
		return problem.StatusCode >= 400 && problem.StatusCode < 500 && problem.StatusCode != http.StatusTooManyRequests
	}
}

func (supervisor *attemptSupervisor) reportCompletion(ctx context.Context, state attemptState) {
	if state.Result == nil || state.CompletionID == "" {
		return
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, state.Claimed.Lease.ExpiresAt)
	if err != nil {
		return
	}
	backoff := time.Second
	for time.Now().Before(expiresAt) {
		response, completeErr := supervisor.client.Complete(
			ctx,
			supervisor.identity,
			state.Claimed.Assignment.AttemptID,
			state.Claimed.Lease.Token,
			state.CompletionID,
			*state.Result,
		)
		if completeErr == nil {
			if response.Disposition == "accepted" || response.Disposition == "duplicate" || response.Disposition == "late" {
				if removeErr := supervisor.store.remove(state.Claimed.Assignment.AttemptID); removeErr != nil {
					fmt.Fprintf(supervisor.diagnostics, "clean completed attempt %s: %v\n", state.Claimed.Assignment.AttemptID, removeErr)
				}
				return
			}
		}
		if !waitFor(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (supervisor *attemptSupervisor) reconcile(ctx context.Context) error {
	states, err := supervisor.store.list()
	if err != nil {
		return fmt.Errorf("load local attempts for reconciliation: %w", err)
	}
	if len(states) == 0 {
		return nil
	}
	attempts := make([]localAttempt, 0, len(states))
	stateByID := make(map[string]attemptState, len(states))
	for _, state := range states {
		attemptID := state.Claimed.Assignment.AttemptID
		attempts = append(attempts, localAttempt{AttemptID: attemptID, LeaseID: state.Claimed.Lease.LeaseID, LeaseVersion: state.Claimed.Lease.Version, LocalState: state.LocalState})
		stateByID[attemptID] = state
	}
	response, err := supervisor.client.Reconcile(ctx, supervisor.identity, attempts)
	if err != nil {
		return err
	}
	if err := validateReconcileDecisions(response.Decisions, stateByID); err != nil {
		return err
	}
	for _, decision := range response.Decisions {
		state, exists := stateByID[decision.AttemptID]
		if !exists {
			continue
		}
		switch decision.Action {
		case "clean":
			if err := supervisor.store.remove(decision.AttemptID); err != nil {
				return err
			}
		case "continue", "cancel", "retransmit":
			if state.Result == nil {
				result := completionResult{Status: "failed", ResultCode: "AGENT_RESTARTED_DURING_EXECUTION", Summary: "Runner Agent restarted before the attempt completed.", DurationMs: 0}
				if decision.Action == "cancel" {
					result.Status = "cancelled"
					result.ResultCode = "EXECUTION_CANCELLED_DURING_RECONCILE"
					result.Summary = "The control plane cancelled the attempt during restart reconciliation."
				}
				completionID, identifierErr := randomIdentifier()
				if identifierErr != nil {
					return identifierErr
				}
				state.LocalState = "finishing"
				state.CompletionID = completionID
				state.Result = &result
				if err := supervisor.store.save(state); err != nil {
					return err
				}
			}
			supervisor.reportCompletion(ctx, state)
		}
	}
	return nil
}

func validateReconcileDecisions(decisions []ReconcileDecision, states map[string]attemptState) error {
	seen := make(map[string]struct{}, len(decisions))
	for _, decision := range decisions {
		if _, exists := states[decision.AttemptID]; !exists {
			return fmt.Errorf("control plane returned a reconcile decision for unknown attempt %s", decision.AttemptID)
		}
		if _, duplicate := seen[decision.AttemptID]; duplicate {
			return fmt.Errorf("control plane returned duplicate reconcile decisions for attempt %s", decision.AttemptID)
		}
		seen[decision.AttemptID] = struct{}{}
	}
	if len(seen) != len(states) {
		return errors.New("control plane omitted one or more reconcile decisions")
	}
	return nil
}

func validateClaimedAssignment(claimed ClaimedAssignment, runnerID string, labels, capabilities []string) error {
	if claimed.Assignment.SchemaVersion != protocolVersion || claimed.Assignment.ExecutionSpec.SchemaVersion != protocolVersion {
		return errors.New("assignment uses an unsupported schema version")
	}
	if claimed.Assignment.RunnerID != runnerID || claimed.Assignment.AttemptID != claimed.Assignment.ExecutionSpec.AttemptID {
		return errors.New("assignment identity does not match the local runner or execution spec")
	}
	if !localIdentifierPattern.MatchString(claimed.Assignment.AssignmentID) || !localIdentifierPattern.MatchString(claimed.Assignment.AttemptID) {
		return errors.New("assignment identifiers are invalid")
	}
	if !containsAll(labels, claimed.Assignment.ExecutionSpec.RequiredLabels) || !containsAll(capabilities, claimed.Assignment.ExecutionSpec.RequiredCapabilities) {
		return errors.New("assignment requirements exceed local Runner capabilities")
	}
	specification := claimed.Assignment.ExecutionSpec
	if specification.Executor != "testng" || specification.ClassName == "" || len(specification.ClassName) > 1_024 || specification.TimeoutMs < 1_000 || specification.TimeoutMs > 86_400_000 {
		return errors.New("assignment execution specification is invalid")
	}
	if len(specification.Inputs) != 1 {
		return errors.New("assignment must contain exactly one execution input")
	}
	input := specification.Inputs[0]
	if !localIdentifierPattern.MatchString(input.InputID) || input.Kind != "test-jar" || input.MediaType != "application/java-archive" || !filepath.IsLocal(input.TargetPath) || input.SizeBytes <= 0 || !sha256Pattern.MatchString(input.SHA256) {
		return errors.New("assignment execution input is invalid")
	}
	if claimed.Lease.LeaseID == "" || len(claimed.Lease.Token) < 32 || claimed.Lease.Version < 1 {
		return errors.New("assignment lease is incomplete")
	}
	if _, err := time.Parse(time.RFC3339Nano, claimed.Lease.ExpiresAt); err != nil {
		return errors.New("assignment lease expiry is invalid")
	}
	return nil
}

func containsAll(available, required []string) bool {
	values := make(map[string]struct{}, len(available))
	for _, value := range available {
		values[value] = struct{}{}
	}
	for _, value := range required {
		if _, exists := values[value]; !exists {
			return false
		}
	}
	return true
}

func platformFailure(code string, err error) completionResult {
	return completionResult{Status: "failed", ResultCode: code, Summary: boundedSummary(err.Error()), DurationMs: 0}
}

func boundedSummary(value string) string {
	const maximumBytes = 4_096
	if len(value) <= maximumBytes {
		return value
	}
	return strings.ToValidUTF8(value[:maximumBytes], "")
}

func mapExecutionResult(result executor.Result) completionResult {
	exitCode := result.ExitCode
	mapped := completionResult{DurationMs: result.DurationMs, ExitCode: &exitCode}
	switch {
	case result.Termination == "timeout":
		mapped.Status = "timed_out"
		mapped.ResultCode = "EXECUTION_TIMEOUT"
		mapped.Summary = "TestNG exceeded the configured execution timeout."
	case result.Termination == "cancelled":
		mapped.Status = "cancelled"
		mapped.ResultCode = "EXECUTION_CANCELLED"
		mapped.Summary = "The execution was cancelled and its process group was terminated."
	case result.LogsTruncated:
		mapped.Status = "failed"
		mapped.ResultCode = "LOG_LIMIT_EXCEEDED"
		mapped.Summary = "Test output exceeded the local log byte limit."
	case result.ExitCode == 0:
		mapped.Status = "succeeded"
		mapped.ResultCode = "TESTNG_SUCCEEDED"
		mapped.Summary = "TestNG completed successfully."
	default:
		mapped.Status = "failed"
		mapped.ResultCode = "TESTNG_EXIT_NONZERO"
		mapped.Summary = fmt.Sprintf("TestNG exited with code %d.", result.ExitCode)
	}
	return mapped
}

func waitFor(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func jitter(duration time.Duration) time.Duration {
	if duration <= 4*time.Millisecond {
		return duration
	}
	value := []byte{0}
	if _, err := rand.Read(value); err != nil {
		return duration
	}
	delta := duration / 4
	return duration - delta/2 + time.Duration(value[0])*delta/255
}
