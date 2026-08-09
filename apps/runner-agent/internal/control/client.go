package control

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/metrics"
)

const (
	protocolVersion       = 1
	maximumResponseBytes  = 2 * 1024 * 1024
	defaultRequestTimeout = 20 * time.Second
)

type Client struct {
	baseURL *url.URL
	http    *http.Client
}

type registrationRequest struct {
	SchemaVersion   int      `json:"schemaVersion"`
	Name            string   `json:"name"`
	Labels          []string `json:"labels"`
	Capabilities    []string `json:"capabilities"`
	MaxConcurrency  int      `json:"maxConcurrency"`
	OS              string   `json:"os"`
	Architecture    string   `json:"architecture"`
	AgentVersion    string   `json:"agentVersion"`
	ProtocolVersion int      `json:"protocolVersion"`
	TerminalEnabled bool     `json:"terminalEnabled"`
}

type registrationResponse struct {
	SchemaVersion           int    `json:"schemaVersion"`
	RunnerID                string `json:"runnerId"`
	Credential              string `json:"credential"`
	HeartbeatIntervalSecond int    `json:"heartbeatIntervalSeconds"`
}

type heartbeatRequest struct {
	SchemaVersion    int               `json:"schemaVersion"`
	BusySlots        int               `json:"busySlots"`
	Labels           []string          `json:"labels"`
	Capabilities     []string          `json:"capabilities"`
	MaxConcurrency   int               `json:"maxConcurrency"`
	AgentVersion     string            `json:"agentVersion"`
	TerminalEnabled  bool              `json:"terminalEnabled"`
	ResourceSnapshot *metrics.Snapshot `json:"resourceSnapshot,omitempty"`
}

type HeartbeatResponse struct {
	SchemaVersion           int    `json:"schemaVersion"`
	AcceptedAt              string `json:"acceptedAt"`
	HeartbeatIntervalSecond int    `json:"heartbeatIntervalSeconds"`
	Draining                bool   `json:"draining"`
	TerminalConnectionToken string `json:"terminalConnectionToken,omitempty"`
}

type apiErrorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

func (problem *APIError) Error() string {
	if problem.Code != "" {
		return fmt.Sprintf("control plane rejected request (%s): %s", problem.Code, problem.Message)
	}
	return fmt.Sprintf("control plane returned HTTP %d", problem.StatusCode)
}

func NewClient(configuration config.Config) (*Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if configuration.CAFile != "" {
		certificate, err := os.ReadFile(configuration.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read control-plane CA: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system CA pool: %w", err)
		}
		if !roots.AppendCertsFromPEM(certificate) {
			return nil, errors.New("configured control-plane CA contains no certificate")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return &Client{
		baseURL: configuration.ServerURL,
		http: &http.Client{
			Transport: transport,
			Timeout:   0,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (client *Client) Close() {
	client.http.CloseIdleConnections()
}

func (client *Client) Register(ctx context.Context, configuration config.Config, info buildinfo.Info) (Identity, time.Duration, error) {
	request := registrationRequest{
		SchemaVersion:   protocolVersion,
		Name:            configuration.Name,
		Labels:          configuration.RunnerLabels(),
		Capabilities:    configuration.Toolchain.Capabilities(),
		MaxConcurrency:  configuration.MaxConcurrent,
		OS:              runtime.GOOS,
		Architecture:    runtime.GOARCH,
		AgentVersion:    info.Version,
		ProtocolVersion: protocolVersion,
		TerminalEnabled: configuration.Terminal.Enabled,
	}
	var response registrationResponse
	if err := client.post(ctx, "/api/v1/runner-agents/register", configuration.BootstrapToken, request, &response); err != nil {
		return Identity{}, 0, fmt.Errorf("register runner: %w", err)
	}
	if response.SchemaVersion != protocolVersion || response.RunnerID == "" || len(response.Credential) < 32 || !validHeartbeatInterval(response.HeartbeatIntervalSecond) {
		return Identity{}, 0, errors.New("register runner: control plane returned an incompatible response")
	}
	return Identity{
		SchemaVersion: identitySchemaVersion,
		RunnerID:      response.RunnerID,
		Credential:    response.Credential,
		ServerURL:     client.baseURL.String(),
	}, heartbeatInterval(response.HeartbeatIntervalSecond), nil
}

func (client *Client) Heartbeat(ctx context.Context, identity Identity, configuration config.Config, info buildinfo.Info, busySlots int, snapshot *metrics.Snapshot) (HeartbeatResponse, error) {
	request := heartbeatRequest{
		SchemaVersion:    protocolVersion,
		BusySlots:        busySlots,
		Labels:           configuration.RunnerLabels(),
		Capabilities:     configuration.Toolchain.Capabilities(),
		MaxConcurrency:   configuration.MaxConcurrent,
		AgentVersion:     info.Version,
		TerminalEnabled:  configuration.Terminal.Enabled,
		ResourceSnapshot: snapshot,
	}
	var response HeartbeatResponse
	path := fmt.Sprintf("/api/v1/runner-agents/%s/heartbeat", url.PathEscape(identity.RunnerID))
	if err := client.post(ctx, path, identity.Credential, request, &response); err != nil {
		return HeartbeatResponse{}, fmt.Errorf("send heartbeat: %w", err)
	}
	if response.SchemaVersion != protocolVersion || !validHeartbeatInterval(response.HeartbeatIntervalSecond) {
		return HeartbeatResponse{}, errors.New("send heartbeat: incompatible protocol response")
	}
	if _, err := time.Parse(time.RFC3339Nano, response.AcceptedAt); err != nil {
		return HeartbeatResponse{}, errors.New("send heartbeat: control plane returned an invalid acceptance time")
	}
	return response, nil
}

func (client *Client) Claim(ctx context.Context, identity Identity, configuration config.Config, availableSlots int) (ClaimResponse, error) {
	requestID, err := randomIdentifier()
	if err != nil {
		return ClaimResponse{}, fmt.Errorf("create claim request identifier: %w", err)
	}
	request := claimRequest{
		SchemaVersion:  protocolVersion,
		RequestID:      requestID,
		AvailableSlots: availableSlots,
		Labels:         configuration.RunnerLabels(),
		Capabilities:   configuration.Toolchain.Capabilities(),
		WaitSeconds:    int(configuration.Claim.WaitDuration / time.Second),
	}
	var response ClaimResponse
	path := fmt.Sprintf("/api/v1/runner-agents/%s/claims", url.PathEscape(identity.RunnerID))
	if err := client.postWithTimeout(ctx, configuration.Claim.WaitDuration+15*time.Second, path, identity.Credential, request, &response); err != nil {
		return ClaimResponse{}, fmt.Errorf("claim assignments: %w", err)
	}
	if response.SchemaVersion != protocolVersion || response.RequestID != requestID || response.RetryAfterMs < 100 || response.RetryAfterMs > 60_000 {
		return ClaimResponse{}, errors.New("claim assignments: incompatible protocol response")
	}
	if len(response.Assignments) > availableSlots {
		return ClaimResponse{}, errors.New("claim assignments: control plane exceeded the requested slot count")
	}
	return response, nil
}

func (client *Client) RenewLease(ctx context.Context, identity Identity, lease Lease) (RenewLeaseResponse, error) {
	requestID, err := randomIdentifier()
	if err != nil {
		return RenewLeaseResponse{}, fmt.Errorf("create lease request identifier: %w", err)
	}
	request := renewLeaseRequest{SchemaVersion: protocolVersion, RequestID: requestID, LeaseToken: lease.Token, LeaseVersion: lease.Version}
	var response RenewLeaseResponse
	path := fmt.Sprintf("/api/v1/runner-agents/%s/leases/%s/renew", url.PathEscape(identity.RunnerID), url.PathEscape(lease.LeaseID))
	if err := client.post(ctx, path, identity.Credential, request, &response); err != nil {
		return RenewLeaseResponse{}, fmt.Errorf("renew lease: %w", err)
	}
	if response.SchemaVersion != protocolVersion || response.LeaseVersion <= lease.Version || (response.Instruction != "continue" && response.Instruction != "cancel" && response.Instruction != "drain") {
		return RenewLeaseResponse{}, errors.New("renew lease: incompatible protocol response")
	}
	return response, nil
}

func (client *Client) Complete(ctx context.Context, identity Identity, attemptID, leaseToken, completionID string, result completionResult) (CompleteAttemptResponse, error) {
	request := completeAttemptRequest{SchemaVersion: protocolVersion, CompletionID: completionID, LeaseToken: leaseToken, Result: result}
	var response CompleteAttemptResponse
	path := fmt.Sprintf("/api/v1/run-attempts/%s/complete", url.PathEscape(attemptID))
	if err := client.postForRunner(ctx, path, identity.Credential, identity.RunnerID, request, &response); err != nil {
		return CompleteAttemptResponse{}, fmt.Errorf("complete attempt: %w", err)
	}
	if response.SchemaVersion != protocolVersion || response.CompletionID != completionID {
		return CompleteAttemptResponse{}, errors.New("complete attempt: incompatible protocol response")
	}
	return response, nil
}

func (client *Client) Reconcile(ctx context.Context, identity Identity, attempts []localAttempt) (ReconcileResponse, error) {
	requestID, err := randomIdentifier()
	if err != nil {
		return ReconcileResponse{}, fmt.Errorf("create reconcile request identifier: %w", err)
	}
	request := reconcileRequest{SchemaVersion: protocolVersion, RequestID: requestID, Attempts: attempts}
	var response ReconcileResponse
	path := fmt.Sprintf("/api/v1/runner-agents/%s/reconcile", url.PathEscape(identity.RunnerID))
	if err := client.post(ctx, path, identity.Credential, request, &response); err != nil {
		return ReconcileResponse{}, fmt.Errorf("reconcile attempts: %w", err)
	}
	if response.SchemaVersion != protocolVersion {
		return ReconcileResponse{}, errors.New("reconcile attempts: incompatible protocol response")
	}
	return response, nil
}

func (client *Client) DownloadInput(ctx context.Context, identity Identity, attemptID string, lease Lease, input ExecutionInput, destination io.Writer) error {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + fmt.Sprintf("/api/v1/run-attempts/%s/inputs/%s", url.PathEscape(attemptID), url.PathEscape(input.InputID))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("create input request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+identity.Credential)
	request.Header.Set("X-AutoForge-Runner-Id", identity.RunnerID)
	request.Header.Set("X-AutoForge-Lease-Token", lease.Token)
	request.Header.Set("User-Agent", "AutoForge-Runner-Agent")
	response, err := client.http.Do(request)
	if err != nil {
		return fmt.Errorf("download input: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return client.responseError(response)
	}
	if response.ContentLength > input.SizeBytes {
		return errors.New("download input: response exceeds declared size")
	}
	written, err := io.Copy(destination, io.LimitReader(response.Body, input.SizeBytes+1))
	if err != nil {
		return fmt.Errorf("download input: %w", err)
	}
	if written != input.SizeBytes {
		return fmt.Errorf("download input: received %d bytes, expected %d", written, input.SizeBytes)
	}
	return nil
}

func (client *Client) post(ctx context.Context, path, credential string, input, output any) error {
	return client.postWithTimeoutForRunner(ctx, defaultRequestTimeout, path, credential, "", input, output)
}

func (client *Client) postWithTimeout(ctx context.Context, timeout time.Duration, path, credential string, input, output any) error {
	return client.postWithTimeoutForRunner(ctx, timeout, path, credential, "", input, output)
}

func (client *Client) postForRunner(ctx context.Context, path, credential, runnerID string, input, output any) error {
	return client.postWithTimeoutForRunner(ctx, defaultRequestTimeout, path, credential, runnerID, input, output)
}

func (client *Client) postWithTimeoutForRunner(ctx context.Context, timeout time.Duration, path, credential, runnerID string, input, output any) error {
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+credential)
	if runnerID != "" {
		request.Header.Set("X-AutoForge-Runner-Id", runnerID)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "AutoForge-Runner-Agent")
	response, err := client.http.Do(request)
	if err != nil {
		return fmt.Errorf("perform request: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if len(body) > maximumResponseBytes {
		return errors.New("control-plane response exceeds 64 KiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeResponseError(response.StatusCode, body)
	}
	if err := json.Unmarshal(body, output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (client *Client) responseError(response *http.Response) error {
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read error response: %w", err)
	}
	return decodeResponseError(response.StatusCode, body)
}

func decodeResponseError(statusCode int, body []byte) error {
	var envelope apiErrorEnvelope
	if json.Unmarshal(body, &envelope) == nil && envelope.Error.Code != "" {
		return &APIError{StatusCode: statusCode, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	return &APIError{StatusCode: statusCode}
}

func randomIdentifier() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", value), nil
}

func heartbeatInterval(seconds int) time.Duration {
	return time.Duration(seconds) * time.Second
}

func validHeartbeatInterval(seconds int) bool {
	return seconds >= 5 && seconds <= 300
}
