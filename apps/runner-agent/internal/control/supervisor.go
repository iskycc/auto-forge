package control

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const liveLogUploadInterval = 500 * time.Millisecond

type attemptSupervisor struct {
	client        *Client
	identity      Identity
	identityMutex sync.RWMutex
	configuration config.Config
	store         attemptStore
	logSpool      *logSpool
	artifactSpool *artifactSpool
	diagnostics   io.Writer
	draining      atomic.Bool
	busy          atomic.Int32
	waitGroup     sync.WaitGroup
	mutex         sync.Mutex
	cancellations map[string]context.CancelFunc
	runExecution  func(context.Context, executor.Spec, executor.RunOptions) (executor.Result, error)
}

func newAttemptSupervisor(client *Client, identity Identity, configuration config.Config, diagnostics io.Writer) *attemptSupervisor {
	return &attemptSupervisor{
		client:        client,
		identity:      identity,
		configuration: configuration,
		store:         newAttemptStore(configuration.DataDirectory),
		diagnostics:   diagnostics,
		cancellations: make(map[string]context.CancelFunc),
		runExecution:  executor.Run,
	}
}

func (supervisor *attemptSupervisor) Start(ctx context.Context) error {
	spool, err := newLogSpool(
		supervisor.configuration.DataDirectory,
		supervisor.configuration.Spool,
		supervisor.configuration.MaxConcurrent,
	)
	if err != nil {
		return err
	}
	supervisor.logSpool = spool
	supervisor.store.budget = spool.budget
	if err := supervisor.store.removeTemporaryFiles(); err != nil {
		return err
	}
	artifactSpool, err := newArtifactSpool(supervisor.configuration.DataDirectory, spool.budget)
	if err != nil {
		return err
	}
	supervisor.artifactSpool = artifactSpool
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

func (supervisor *attemptSupervisor) UpdateIdentity(identity Identity) {
	supervisor.identityMutex.Lock()
	supervisor.identity = identity
	supervisor.identityMutex.Unlock()
}

func (supervisor *attemptSupervisor) currentIdentity() Identity {
	supervisor.identityMutex.RLock()
	defer supervisor.identityMutex.RUnlock()
	return supervisor.identity
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
		if availableSlots <= 0 || !supervisor.configuration.CanClaimExecutions() {
			if !waitFor(ctx, time.Second) {
				return
			}
			continue
		}
		response, err := supervisor.client.Claim(ctx, supervisor.currentIdentity(), supervisor.configuration, availableSlots)
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
		supervisor.currentIdentity().RunnerID,
		supervisor.configuration,
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
	stateMutex := &sync.Mutex{}
	renewContext, stopRenewal := context.WithCancel(context.Background())
	renewed := make(chan struct{})
	go func() {
		defer close(renewed)
		supervisor.renewLease(renewContext, cancel, &state, stateMutex, reportAllowed)
	}()

	persistProgress := func(result completionResult, uploads []artifactUploadState) error {
		stateMutex.Lock()
		defer stateMutex.Unlock()
		if state.CompletionID == "" {
			completionID, err := randomIdentifier()
			if err != nil {
				return err
			}
			state.CompletionID = completionID
		}
		state.LocalState = "uploading"
		state.Result = &result
		state.ArtifactUploads = append([]artifactUploadState(nil), uploads...)
		return supervisor.store.save(state)
	}
	result := supervisor.runTestNG(ctx, state.Claimed, persistProgress)
	stopRenewal()
	<-renewed
	stateMutex.Lock()
	if state.CompletionID == "" {
		completionID, err := randomIdentifier()
		if err != nil {
			stateMutex.Unlock()
			fmt.Fprintf(supervisor.diagnostics, "create completion ID for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
			return
		}
		state.CompletionID = completionID
	}
	state.LocalState = "finishing"
	state.Result = &result
	if err := supervisor.store.save(state); err != nil {
		stateMutex.Unlock()
		fmt.Fprintf(supervisor.diagnostics, "persist completion for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		return
	}
	stateMutex.Unlock()
	if !reportAllowed.Load() {
		fmt.Fprintf(supervisor.diagnostics, "attempt %s lost its lease; completion retained locally\n", state.Claimed.Assignment.AttemptID)
		return
	}
	supervisor.reportCompletion(context.Background(), state)
}

func (supervisor *attemptSupervisor) runTestNG(
	ctx context.Context,
	claimed ClaimedAssignment,
	persistProgress func(completionResult, []artifactUploadState) error,
) completionResult {
	executionSpec, err := supervisor.executionSpecWithSecrets(ctx, claimed)
	if err != nil {
		return platformFailure("EXECUTION_SECRET_ACQUISITION_FAILED", err)
	}
	executionToolchain := supervisor.configuration.Toolchain
	useAdapter := executionSpec.Adapter != nil && supervisor.configuration.Adapter.Enabled()
	isolation := "process"
	containerPolicy := executor.ContainerPolicy{}
	if executionSpec.Executor == "testng-container" {
		container := supervisor.configuration.Container
		if !container.Enabled() {
			return platformFailure("EXECUTION_SPEC_REJECTED", errors.New("container executor is not configured by local Agent policy"))
		}
		executionToolchain.JavaExecutable = container.JavaExecutable
		executionToolchain.Classpath = append([]string(nil), container.Classpath...)
		isolation = "container"
		containerPolicy = executor.ContainerPolicy{
			RuntimeExecutable: container.RuntimeExecutable,
			ImageReference:    container.ImageReference,
			SeccompProfile:    container.SeccompProfile,
			User:              container.User,
		}
	}
	var specification executor.Spec
	var inputs []ExecutionInput
	if useAdapter {
		specification, inputs, err = cotestAdapterExecutorSpec(
			executionSpec,
			executionToolchain,
			supervisor.configuration.Adapter,
		)
	} else {
		specification, inputs, err = testNGExecutorSpec(executionSpec, executionToolchain)
	}
	if err != nil {
		return platformFailure("EXECUTION_SPEC_REJECTED", err)
	}
	specification.Isolation = isolation
	collector := newAttemptLogCollector(
		claimed.Assignment.AttemptID,
		supervisor.logSpool,
		executionSpec.Environment,
	)
	_ = collector.Write(executor.LogChunk{
		Stream:     "agent",
		Content:    "AutoForge Runner Agent started the attempt.\n",
		RecordedAt: time.Now().UTC(),
	})
	liveLogContext, stopLiveLogUpload := context.WithCancel(ctx)
	liveLogWatermarks := make(chan logWatermark, 1)
	go func() {
		liveLogWatermarks <- supervisor.streamAttemptLogs(
			liveLogContext,
			claimed,
			liveLogUploadInterval,
		)
	}()
	result, runErr := supervisor.runExecution(ctx, specification, executor.RunOptions{
		DataDirectory: supervisor.configuration.DataDirectory,
		KeepWorkspace: true,
		Policy: executor.Policy{
			AllowedExecutables: []string{specification.Command.Executable},
			Container:          containerPolicy,
		},
		ResourcePolicy: executor.ResourcePolicy{
			CgroupRoot:    supervisor.configuration.Resources.CgroupRoot,
			RequireCgroup: supervisor.configuration.Resources.Enabled(),
			ApplyRlimits:  true,
		},
		LogSink: collector.Write,
		PrepareWorkspace: func(workspace string) error {
			if err := downloadAttemptInputs(ctx, supervisor.client, supervisor.currentIdentity(), claimed, inputs, workspace); err != nil {
				return err
			}
			if useAdapter {
				return prepareCotestWorkspace(
					workspace,
					inputs,
					executionSpec.ResourceLimits.DiskBytes,
					executionSpec.ResourceLimits.FileCount,
				)
			}
			return prepareTestNGLauncher(
				workspace,
				claimed.Assignment.ExecutionSpec.MethodDescriptors,
				claimed.Assignment.ExecutionSpec.Parameters,
			)
		},
	})
	stopLiveLogUpload()
	streamedWatermarks := <-liveLogWatermarks
	if closeErr := collector.Close(time.Now().UTC().Format(time.RFC3339Nano)); closeErr != nil {
		if errors.Is(closeErr, errLogSpoolQuotaExceeded) {
			return platformFailure("LOG_SPOOL_QUOTA_EXCEEDED", closeErr)
		}
		return platformFailure("LOG_SPOOL_WRITE_FAILED", closeErr)
	}
	if runErr != nil {
		if errors.Is(runErr, executor.ErrResourceIsolationUnavailable) {
			return platformFailure("RESOURCE_ISOLATION_UNAVAILABLE", runErr)
		}
		return platformFailure("PROCESS_START_FAILED", runErr)
	}
	defer func() {
		if removeErr := os.RemoveAll(result.WorkspacePath); removeErr != nil {
			fmt.Fprintf(supervisor.diagnostics, "clean attempt workspace %s: %v\n", claimed.Assignment.AttemptID, removeErr)
		}
	}()
	reportSummary, reportFound, reportErr := executor.ReadTestNGReport(result.WorkspacePath)
	artifactRules := make([]executor.ArtifactRule, 0, len(claimed.Assignment.ExecutionSpec.ArtifactRules))
	for _, rule := range claimed.Assignment.ExecutionSpec.ArtifactRules {
		artifactRules = append(artifactRules, executor.ArtifactRule{
			Pattern: rule.Pattern, Required: rule.Required, MediaType: rule.MediaType,
		})
	}
	artifacts := make([]executor.Artifact, 0)
	var artifactDiscoveryErr error
	artifactDiscoveryCode := ""
	if len(artifactRules) > 0 {
		artifactContext, cancelArtifactScan := context.WithTimeout(
			ctx,
			time.Duration(claimed.Assignment.ExecutionSpec.UploadTimeoutMs)*time.Millisecond,
		)
		discovered, artifactErr := executor.DiscoverArtifacts(
			artifactContext,
			result.WorkspacePath,
			artifactRules,
			claimed.Assignment.ExecutionSpec.ResourceLimits.ArtifactBytes,
		)
		cancelArtifactScan()
		if artifactErr != nil {
			artifactDiscoveryErr = artifactErr
			artifactDiscoveryCode = "ARTIFACT_DISCOVERY_REJECTED"
			var missing *executor.RequiredArtifactMissingError
			if errors.As(artifactErr, &missing) {
				artifactDiscoveryCode = "REQUIRED_ARTIFACT_MISSING"
			}
		} else {
			artifacts = discovered
		}
	}
	watermarks, uploadErr := supervisor.flushAttemptLogs(
		ctx,
		claimed,
		time.Duration(claimed.Assignment.ExecutionSpec.UploadTimeoutMs)*time.Millisecond,
	)
	if uploadErr != nil {
		return platformFailure("LOG_UPLOAD_FAILED", uploadErr)
	}
	watermarks = mergeLogWatermarks(streamedWatermarks, watermarks)
	mapped := mapExecutionResult(result)
	if reportErr != nil {
		mapped.Status = "failed"
		mapped.ResultCode = "TESTNG_REPORT_INVALID"
		mapped.Summary = boundedSummary(reportErr.Error())
	} else if reportFound {
		mapTestNGReport(&mapped, result, reportSummary)
	}
	if artifactDiscoveryErr != nil {
		mapped.Status = "failed"
		mapped.ResultCode = artifactDiscoveryCode
		mapped.Summary = boundedSummary(artifactDiscoveryErr.Error())
	}
	mapped.LogWatermarks = &watermarks
	uploads := make([]artifactUploadState, 0, len(artifacts))
	for _, artifact := range artifacts {
		artifactID, err := randomIdentifier()
		if err != nil {
			return platformFailure("ARTIFACT_ID_FAILED", err)
		}
		declaration := artifactDeclaration{
			ArtifactID: artifactID, RelativePath: artifact.RelativePath,
			MediaType: artifact.MediaType, SizeBytes: artifact.SizeBytes,
			SHA256: artifact.SHA256, Required: artifact.Required,
		}
		mapped.Artifacts = append(mapped.Artifacts, declaration)
		if err := supervisor.artifactSpool.stage(claimed.Assignment.AttemptID, declaration, artifact.AbsolutePath); err != nil {
			_ = supervisor.artifactSpool.removeAttempt(claimed.Assignment.AttemptID)
			code := "ARTIFACT_SPOOL_WRITE_FAILED"
			if errors.Is(err, errSpoolQuotaExceeded) {
				code = "ARTIFACT_SPOOL_QUOTA_EXCEEDED"
			}
			return platformFailure(code, err)
		}
		uploads = append(uploads, artifactUploadState{Artifact: declaration})
	}
	if err := persistProgress(mapped, uploads); err != nil {
		_ = supervisor.artifactSpool.removeAttempt(claimed.Assignment.AttemptID)
		return platformFailure("RESULT_SPOOL_WRITE_FAILED", err)
	}
	if err := supervisor.uploadArtifacts(
		ctx,
		claimed,
		uploads,
		time.Duration(claimed.Assignment.ExecutionSpec.UploadTimeoutMs)*time.Millisecond,
		func(updated []artifactUploadState) error { return persistProgress(mapped, updated) },
	); err != nil {
		code := "OPTIONAL_ARTIFACT_UPLOAD_FAILED"
		var transferError *artifactTransferError
		if errors.As(err, &transferError) && transferError.required {
			code = "REQUIRED_ARTIFACT_UPLOAD_FAILED"
		}
		return platformFailure(code, err)
	}
	return mapped
}

func (supervisor *attemptSupervisor) executionSpecWithSecrets(
	ctx context.Context,
	claimed ClaimedAssignment,
) (ExecutionSpec, error) {
	specification := claimed.Assignment.ExecutionSpec
	secrets, err := supervisor.client.AcquireSecrets(
		ctx,
		supervisor.currentIdentity(),
		claimed.Assignment.AttemptID,
		claimed.Lease,
		specification.SecretReferences,
	)
	if err != nil {
		return ExecutionSpec{}, err
	}
	specification.Environment = append(
		append([]EnvironmentEntry(nil), specification.Environment...),
		secrets...,
	)
	return specification, nil
}

type artifactTransferError struct {
	required bool
	cause    error
}

func (problem *artifactTransferError) Error() string { return problem.cause.Error() }
func (problem *artifactTransferError) Unwrap() error { return problem.cause }

func (supervisor *attemptSupervisor) uploadArtifacts(
	ctx context.Context,
	claimed ClaimedAssignment,
	uploads []artifactUploadState,
	timeout time.Duration,
	persistProgress func([]artifactUploadState) error,
) error {
	artifacts := make([]artifactDeclaration, 0, len(uploads))
	for _, upload := range uploads {
		if err := supervisor.artifactSpool.verify(claimed.Assignment.AttemptID, upload.Artifact); err != nil {
			return &artifactTransferError{required: upload.Artifact.Required, cause: err}
		}
		artifacts = append(artifacts, upload.Artifact)
	}
	uploadContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	declared, err := supervisor.client.DeclareArtifacts(
		uploadContext,
		supervisor.currentIdentity(),
		claimed.Assignment.AttemptID,
		claimed.Lease.Token,
		artifacts,
	)
	if err != nil {
		return &artifactTransferError{required: hasRequiredArtifact(artifacts), cause: err}
	}
	byID := make(map[string]int, len(uploads))
	for index, upload := range uploads {
		byID[upload.Artifact.ArtifactID] = index
	}
	for _, accepted := range declared.Artifacts {
		index, exists := byID[accepted.ArtifactID]
		if !exists {
			return &artifactTransferError{required: true, cause: errors.New("control plane returned an unknown artifact declaration")}
		}
		artifact := uploads[index].Artifact
		if accepted.Status == "uploaded" {
			uploads[index].Uploaded = true
			if err := persistProgress(uploads); err != nil {
				return &artifactTransferError{required: artifact.Required, cause: err}
			}
			continue
		}
		backoff := time.Second
		for {
			err := supervisor.client.UploadArtifact(
				uploadContext,
				supervisor.currentIdentity(),
				claimed.Lease,
				accepted,
				supervisor.artifactSpool.path(claimed.Assignment.AttemptID, artifact.ArtifactID),
			)
			if err == nil {
				break
			}
			if !waitFor(uploadContext, backoff) {
				return &artifactTransferError{required: artifact.Required, cause: err}
			}
			backoff = min(backoff*2, 10*time.Second)
		}
		uploads[index].Uploaded = true
		if err := persistProgress(uploads); err != nil {
			return &artifactTransferError{required: artifact.Required, cause: err}
		}
	}
	for _, upload := range uploads {
		if !upload.Uploaded {
			return &artifactTransferError{required: upload.Artifact.Required, cause: errors.New("control plane omitted a declared artifact")}
		}
	}
	return nil
}

func hasRequiredArtifact(artifacts []artifactDeclaration) bool {
	for _, artifact := range artifacts {
		if artifact.Required {
			return true
		}
	}
	return false
}

func (supervisor *attemptSupervisor) flushAttemptLogs(ctx context.Context, claimed ClaimedAssignment, timeout time.Duration) (logWatermark, error) {
	watermarks := logWatermark{Stdout: -1, Stderr: -1, Agent: -1}
	uploadContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	backoff := time.Second
	uploadBatch := supervisor.configuration.Spool.UploadBatch
	if uploadBatch == 0 {
		uploadBatch = 128
	}
	for {
		chunks, err := supervisor.logSpool.list(claimed.Assignment.AttemptID, uploadBatch)
		if err != nil {
			return watermarks, err
		}
		if len(chunks) == 0 {
			return watermarks, nil
		}
		response, uploadErr := supervisor.client.UploadLogs(
			uploadContext,
			supervisor.currentIdentity(),
			claimed.Assignment.AttemptID,
			claimed.Lease.Token,
			chunks,
		)
		if uploadErr == nil {
			watermarks = response.AcknowledgedSequence
			if err := supervisor.logSpool.acknowledge(claimed.Assignment.AttemptID, watermarks); err != nil {
				return watermarks, err
			}
			backoff = time.Second
			continue
		}
		if !waitFor(uploadContext, backoff) {
			return watermarks, fmt.Errorf("upload attempt logs before deadline: %w", uploadErr)
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (supervisor *attemptSupervisor) streamAttemptLogs(
	ctx context.Context,
	claimed ClaimedAssignment,
	interval time.Duration,
) logWatermark {
	watermarks := logWatermark{Stdout: -1, Stderr: -1, Agent: -1}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return watermarks
		case <-ticker.C:
			uploaded, err := supervisor.flushAttemptLogs(ctx, claimed, 5*time.Second)
			if err != nil {
				if ctx.Err() == nil {
					fmt.Fprintf(supervisor.diagnostics, "stream attempt logs for %s: %v\n", claimed.Assignment.AttemptID, err)
				}
				continue
			}
			watermarks = mergeLogWatermarks(watermarks, uploaded)
		}
	}
}

func mergeLogWatermarks(left, right logWatermark) logWatermark {
	return logWatermark{
		Stdout: max(left.Stdout, right.Stdout),
		Stderr: max(left.Stderr, right.Stderr),
		Agent:  max(left.Agent, right.Agent),
	}
}

func (supervisor *attemptSupervisor) renewLease(
	ctx context.Context,
	cancelExecution context.CancelFunc,
	state *attemptState,
	stateMutex *sync.Mutex,
	reportAllowed *atomic.Bool,
) {
	stateMutex.Lock()
	lease := state.Claimed.Lease
	stateMutex.Unlock()
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
		response, renewErr := supervisor.client.RenewLease(ctx, supervisor.currentIdentity(), lease)
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
		stateMutex.Lock()
		state.Claimed.Lease = lease
		if err := supervisor.store.save(*state); err != nil {
			fmt.Fprintf(supervisor.diagnostics, "persist renewed lease for %s: %v\n", state.Claimed.Assignment.AttemptID, err)
		}
		stateMutex.Unlock()
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
			supervisor.currentIdentity(),
			state.Claimed.Assignment.AttemptID,
			state.Claimed.Lease.Token,
			state.CompletionID,
			*state.Result,
		)
		if completeErr == nil {
			if response.Disposition == "accepted" || response.Disposition == "duplicate" || response.Disposition == "late" {
				if removeErr := supervisor.cleanAttemptSpool(state.Claimed.Assignment.AttemptID); removeErr != nil {
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
	response, err := supervisor.client.Reconcile(ctx, supervisor.currentIdentity(), attempts)
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
			if err := supervisor.cleanAttemptSpool(decision.AttemptID); err != nil {
				return err
			}
		case "continue", "cancel", "retransmit":
			if decision.AcknowledgedLogSequence != nil {
				if err := supervisor.logSpool.acknowledge(
					decision.AttemptID,
					*decision.AcknowledgedLogSequence,
				); err != nil {
					return fmt.Errorf("apply confirmed log watermark for %s: %w", decision.AttemptID, err)
				}
			}
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
			if len(state.ArtifactUploads) > 0 {
				state.LocalState = "uploading"
				if err := supervisor.store.save(state); err != nil {
					return err
				}
				uploadErr := supervisor.uploadArtifacts(
					ctx,
					state.Claimed,
					state.ArtifactUploads,
					time.Duration(state.Claimed.Assignment.ExecutionSpec.UploadTimeoutMs)*time.Millisecond,
					func(updated []artifactUploadState) error {
						state.ArtifactUploads = append([]artifactUploadState(nil), updated...)
						return supervisor.store.save(state)
					},
				)
				if uploadErr != nil {
					return fmt.Errorf("retransmit artifacts for %s: %w", decision.AttemptID, uploadErr)
				}
			}
			watermarks, uploadErr := supervisor.flushAttemptLogs(
				ctx,
				state.Claimed,
				time.Duration(state.Claimed.Assignment.ExecutionSpec.UploadTimeoutMs)*time.Millisecond,
			)
			if uploadErr != nil {
				return fmt.Errorf("retransmit logs for %s: %w", decision.AttemptID, uploadErr)
			}
			state.Result.LogWatermarks = &watermarks
			state.LocalState = "finishing"
			if err := supervisor.store.save(state); err != nil {
				return err
			}
			supervisor.reportCompletion(ctx, state)
		}
	}
	return nil
}

func (supervisor *attemptSupervisor) cleanAttemptSpool(attemptID string) error {
	if err := supervisor.artifactSpool.removeAttempt(attemptID); err != nil {
		return err
	}
	maximumSequence := int64(^uint64(0) >> 1)
	if err := supervisor.logSpool.acknowledge(attemptID, logWatermark{
		Stdout: maximumSequence,
		Stderr: maximumSequence,
		Agent:  maximumSequence,
	}); err != nil {
		return err
	}
	return supervisor.store.remove(attemptID)
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

func validateClaimedAssignment(
	claimed ClaimedAssignment,
	runnerID string,
	configuration config.Config,
) error {
	if claimed.Assignment.SchemaVersion != protocolVersion || claimed.Assignment.ExecutionSpec.SchemaVersion != protocolVersion {
		return errors.New("assignment uses an unsupported schema version")
	}
	if claimed.Assignment.RunnerID != runnerID || claimed.Assignment.AttemptID != claimed.Assignment.ExecutionSpec.AttemptID {
		return errors.New("assignment identity does not match the local runner or execution spec")
	}
	if !localIdentifierPattern.MatchString(claimed.Assignment.AssignmentID) || !localIdentifierPattern.MatchString(claimed.Assignment.AttemptID) {
		return errors.New("assignment identifiers are invalid")
	}
	if !containsAll(configuration.RunnerLabels(), claimed.Assignment.ExecutionSpec.RequiredLabels) || !containsAll(configuration.Capabilities(), claimed.Assignment.ExecutionSpec.RequiredCapabilities) {
		return errors.New("assignment requirements exceed local Runner capabilities")
	}
	specification := claimed.Assignment.ExecutionSpec
	if err := validateSecretReferences(specification.Environment, specification.SecretReferences); err != nil {
		return err
	}
	runtimeRequirements := specification.RuntimeRequirements
	if runtimeRequirements.OS != runtime.GOOS || !containsAll(runtimeRequirements.Architectures, []string{runtime.GOARCH}) {
		return errors.New("assignment runtime platform is incompatible with the local Runner")
	}
	hasJDKArchive := false
	for _, input := range specification.Inputs {
		if input.Kind == "jdk-archive" {
			hasJDKArchive = true
			break
		}
	}
	usesAdapter := specification.Adapter != nil
	if usesAdapter && !configuration.Adapter.Enabled() {
		return errors.New("assignment requires the CoTest adapter but it is not installed")
	}
	if (!usesAdapter || !hasJDKArchive) && !configuration.Toolchain.Supports(
		runtimeRequirements.MinimumJavaMajorVersion,
		runtimeRequirements.TestNGVersion,
	) {
		return errors.New("assignment toolchain requirements exceed the local Runner toolchain")
	}
	executorSupported := specification.Executor == "testng" || specification.Executor == "testng-container"
	if !executorSupported || specification.ClassName == "" || len(specification.ClassName) > 1_024 || specification.TimeoutMs < 1_000 || specification.TimeoutMs > 86_400_000 {
		return errors.New("assignment execution specification is invalid")
	}
	if specification.ResourceLimits.CPUMillicores <= 0 || specification.ResourceLimits.MemoryBytes <= 0 || specification.ResourceLimits.DiskBytes <= 0 || specification.ResourceLimits.ProcessCount <= 0 || specification.ResourceLimits.FileCount <= 0 {
		return errors.New("assignment resource limits are invalid")
	}
	if len(specification.Inputs) < 1 || len(specification.Inputs) > 128 {
		return errors.New("assignment must contain 1-128 execution inputs")
	}
	inputIDs := make(map[string]struct{}, len(specification.Inputs))
	targetPaths := make(map[string]struct{}, len(specification.Inputs))
	testJARs := 0
	var totalInputBytes int64
	for _, input := range specification.Inputs {
		if !localIdentifierPattern.MatchString(input.InputID) || !filepath.IsLocal(input.TargetPath) || input.SizeBytes <= 0 || !sha256Pattern.MatchString(input.SHA256) {
			return errors.New("assignment execution input is invalid")
		}
		lowerPath := strings.ToLower(input.TargetPath)
		switch input.Kind {
		case "test-jar", "dependency-jar":
			if input.MediaType != "application/java-archive" || !strings.HasSuffix(lowerPath, ".jar") {
				return errors.New("assignment JAR input is invalid")
			}
		case "jdk-archive", "jar-bundle":
			validArchive := (input.MediaType == "application/zip" && strings.HasSuffix(lowerPath, ".zip")) ||
				(input.MediaType == "application/gzip" && (strings.HasSuffix(lowerPath, ".tar.gz") || strings.HasSuffix(lowerPath, ".tgz")))
			if !validArchive {
				return errors.New("assignment runtime archive input is invalid")
			}
		default:
			return errors.New("assignment execution input kind is unsupported")
		}
		if input.DownloadURL != "" {
			parsedURL, err := url.Parse(input.DownloadURL)
			if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.User != nil {
				return errors.New("assignment external input URL is invalid")
			}
		}
		if input.Kind == "test-jar" {
			testJARs++
		}
		if _, duplicate := inputIDs[input.InputID]; duplicate {
			return errors.New("assignment execution input identifier is duplicated")
		}
		if _, duplicate := targetPaths[input.TargetPath]; duplicate {
			return errors.New("assignment execution input target path is duplicated")
		}
		inputIDs[input.InputID] = struct{}{}
		targetPaths[input.TargetPath] = struct{}{}
		if totalInputBytes > specification.ResourceLimits.DiskBytes-input.SizeBytes {
			return errors.New("assignment execution inputs exceed the disk limit")
		}
		totalInputBytes += input.SizeBytes
	}
	if testJARs != 1 {
		return errors.New("assignment must contain exactly one test JAR")
	}
	if claimed.Lease.LeaseID == "" || len(claimed.Lease.Token) < 32 || claimed.Lease.Version < 1 {
		return errors.New("assignment lease is incomplete")
	}
	if _, err := time.Parse(time.RFC3339Nano, claimed.Lease.ExpiresAt); err != nil {
		return errors.New("assignment lease expiry is invalid")
	}
	return nil
}

func validateSecretReferences(
	environment []EnvironmentEntry,
	references []SecretReference,
) error {
	if len(references) > 64 {
		return errors.New("assignment secret references exceed 64 entries")
	}
	names := make(map[string]struct{}, len(environment)+len(references))
	for _, entry := range environment {
		names[entry.Name] = struct{}{}
	}
	for _, reference := range references {
		if !executionEnvironmentName.MatchString(reference.Name) || reference.SecretID == "" || reference.SecretVersionID == "" {
			return errors.New("assignment contains an invalid secret reference")
		}
		if _, duplicate := names[reference.Name]; duplicate {
			return errors.New("assignment contains a duplicate environment name")
		}
		names[reference.Name] = struct{}{}
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
	case result.Termination == "resource_exceeded":
		mapped.Status = "failed"
		mapped.ResultCode, mapped.Summary = resourceLimitResult(result.ResourceLimit)
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

func resourceLimitResult(resource string) (string, string) {
	switch resource {
	case "memory":
		return "RESOURCE_MEMORY_EXCEEDED", "The execution exceeded its cgroup memory limit."
	case "processes":
		return "RESOURCE_PROCESS_LIMIT_EXCEEDED", "The execution exceeded its cgroup process limit."
	case "disk":
		return "RESOURCE_DISK_EXCEEDED", "The execution exceeded its workspace byte limit."
	case "files":
		return "RESOURCE_FILE_LIMIT_EXCEEDED", "The execution exceeded its workspace file limit."
	default:
		return "RESOURCE_MONITOR_FAILED", "The Agent could not safely enforce workspace resource limits."
	}
}

func mapTestNGReport(mapped *completionResult, result executor.Result, summary executor.TestNGReportSummary) {
	mapped.TestNG = &testNGResultSummary{
		testNGResultCounts: testNGResultCounts{
			Total: summary.Total, Passed: summary.Passed, Failed: summary.Failed,
			Skipped: summary.Skipped, ConfigurationFailures: summary.ConfigurationFailures,
		},
		DetailsTruncated: summary.DetailsTruncated,
		Suites:           mapTestNGSuites(summary.Suites),
	}
	if result.Termination != "completed" || result.LogsTruncated {
		return
	}
	switch {
	case summary.ConfigurationFailures > 0:
		mapped.Status = "failed"
		mapped.ResultCode = "TESTNG_CONFIGURATION_FAILED"
		mapped.Summary = fmt.Sprintf("TestNG reported %d configuration failure(s).", summary.ConfigurationFailures)
	case summary.Failed > 0:
		mapped.Status = "failed"
		mapped.ResultCode = "TESTNG_ASSERTIONS_FAILED"
		mapped.Summary = fmt.Sprintf("TestNG reported %d failed test method(s).", summary.Failed)
	case result.ExitCode != 0:
		// A non-zero process exit remains authoritative when the XML contains no failure.
	case summary.Total == 0:
		mapped.Status = "failed"
		mapped.ResultCode = "TESTNG_NO_TESTS"
		mapped.Summary = "TestNG completed without reporting any test methods."
	case summary.Passed == 0 && summary.Skipped > 0:
		mapped.Status = "succeeded"
		mapped.ResultCode = "TESTNG_ALL_SKIPPED"
		mapped.Summary = fmt.Sprintf("TestNG skipped all %d test method(s).", summary.Skipped)
	case summary.Skipped > 0:
		mapped.Status = "succeeded"
		mapped.ResultCode = "TESTNG_SUCCEEDED_WITH_SKIPS"
		mapped.Summary = fmt.Sprintf("TestNG passed %d and skipped %d test method(s).", summary.Passed, summary.Skipped)
	default:
		mapped.Status = "succeeded"
		mapped.ResultCode = "TESTNG_SUCCEEDED"
		mapped.Summary = fmt.Sprintf("TestNG passed %d test method(s).", summary.Passed)
	}
}

func mapTestNGSuites(suites []executor.TestNGSuiteResult) []testNGSuiteResult {
	mapped := make([]testNGSuiteResult, 0, len(suites))
	for _, suite := range suites {
		tests := make([]testNGTestResult, 0, len(suite.Tests))
		for _, test := range suite.Tests {
			classes := make([]testNGClassResult, 0, len(test.Classes))
			for _, classResult := range test.Classes {
				methods := make([]testNGMethodResult, 0, len(classResult.Methods))
				for _, method := range classResult.Methods {
					methods = append(methods, testNGMethodResult{
						Name: method.Name, Signature: method.Signature, Status: method.Status,
						Configuration: method.Configuration, DurationMs: method.DurationMs,
					})
				}
				classes = append(classes, testNGClassResult{
					testNGResultCounts: testNGCounts(classResult.TestNGResultCounts),
					Name:               classResult.Name, DurationMs: classResult.DurationMs, Methods: methods,
				})
			}
			tests = append(tests, testNGTestResult{
				testNGResultCounts: testNGCounts(test.TestNGResultCounts),
				Name:               test.Name, DurationMs: test.DurationMs, Classes: classes,
			})
		}
		mapped = append(mapped, testNGSuiteResult{
			testNGResultCounts: testNGCounts(suite.TestNGResultCounts),
			Name:               suite.Name, DurationMs: suite.DurationMs, Tests: tests,
		})
	}
	return mapped
}

func testNGCounts(counts executor.TestNGResultCounts) testNGResultCounts {
	return testNGResultCounts{
		Total: counts.Total, Passed: counts.Passed, Failed: counts.Failed,
		Skipped: counts.Skipped, ConfigurationFailures: counts.ConfigurationFailures,
	}
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
