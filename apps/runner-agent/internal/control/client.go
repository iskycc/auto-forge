package control

import (
	"bytes"
	"context"
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
)

const (
	protocolVersion       = 1
	maximumResponseBytes  = 64 * 1024
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
	SchemaVersion   int      `json:"schemaVersion"`
	BusySlots       int      `json:"busySlots"`
	Labels          []string `json:"labels"`
	MaxConcurrency  int      `json:"maxConcurrency"`
	AgentVersion    string   `json:"agentVersion"`
	TerminalEnabled bool     `json:"terminalEnabled"`
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
			Timeout:   defaultRequestTimeout,
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
		Labels:          configuration.Labels,
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

func (client *Client) Heartbeat(ctx context.Context, identity Identity, configuration config.Config, info buildinfo.Info) (HeartbeatResponse, error) {
	request := heartbeatRequest{
		SchemaVersion:   protocolVersion,
		BusySlots:       0,
		Labels:          configuration.Labels,
		MaxConcurrency:  configuration.MaxConcurrent,
		AgentVersion:    info.Version,
		TerminalEnabled: configuration.Terminal.Enabled,
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

func (client *Client) post(ctx context.Context, path, credential string, input, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+credential)
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
		var envelope apiErrorEnvelope
		if json.Unmarshal(body, &envelope) == nil && envelope.Error.Code != "" {
			return fmt.Errorf("control plane rejected request (%s): %s", envelope.Error.Code, envelope.Error.Message)
		}
		return fmt.Errorf("control plane returned HTTP %d", response.StatusCode)
	}
	if err := json.Unmarshal(body, output); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func heartbeatInterval(seconds int) time.Duration {
	return time.Duration(seconds) * time.Second
}

func validHeartbeatInterval(seconds int) bool {
	return seconds >= 5 && seconds <= 300
}
