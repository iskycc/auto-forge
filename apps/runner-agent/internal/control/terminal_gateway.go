package control

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/terminal"
)

const (
	maximumTerminalMessageBytes = 64 * 1024
	maximumTerminalDataBytes    = 32 * 1024
	terminalWriteTimeout        = 10 * time.Second
)

type terminalCommand struct {
	SchemaVersion int    `json:"schemaVersion"`
	Type          string `json:"type"`
	SessionID     string `json:"sessionId"`
	Data          string `json:"data,omitempty"`
	Columns       int    `json:"columns,omitempty"`
	Rows          int    `json:"rows,omitempty"`
}

type terminalEvent struct {
	SchemaVersion int    `json:"schemaVersion"`
	Type          string `json:"type"`
	SessionID     string `json:"sessionId"`
	Data          string `json:"data,omitempty"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	Signal        string `json:"signal,omitempty"`
	Message       string `json:"message,omitempty"`
}

type terminalConnector struct {
	client      *Client
	manager     *terminal.Manager
	diagnostics io.Writer

	mu     sync.Mutex
	token  string
	notify chan struct{}
}

func newTerminalConnector(client *Client, manager *terminal.Manager, diagnostics io.Writer) *terminalConnector {
	return &terminalConnector{
		client:      client,
		manager:     manager,
		diagnostics: diagnostics,
		notify:      make(chan struct{}, 1),
	}
}

func (connector *terminalConnector) UpdateToken(token string) {
	if token == "" {
		return
	}
	connector.mu.Lock()
	connector.token = token
	connector.mu.Unlock()
	select {
	case connector.notify <- struct{}{}:
	default:
	}
}

func (connector *terminalConnector) Run(ctx context.Context) {
	backoff := time.Second
	for {
		token, ok := connector.waitForToken(ctx)
		if !ok {
			return
		}
		if err := connector.serve(ctx, token); err != nil && ctx.Err() == nil {
			fmt.Fprintf(connector.diagnostics, "terminal gateway connection failed: %v\n", err)
		}
		if ctx.Err() != nil {
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-connector.notify:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (connector *terminalConnector) waitForToken(ctx context.Context) (string, bool) {
	for {
		connector.mu.Lock()
		token := connector.token
		connector.mu.Unlock()
		if token != "" {
			return token, true
		}
		select {
		case <-ctx.Done():
			return "", false
		case <-connector.notify:
		}
	}
}

func (connector *terminalConnector) serve(ctx context.Context, token string) error {
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+token)
	connection, response, err := websocket.Dial(ctx, connector.endpoint(), &websocket.DialOptions{
		HTTPClient:   connector.client.http,
		HTTPHeader:   headers,
		Subprotocols: []string{"autoforge-runner-terminal-v1"},
	})
	if err != nil {
		if response != nil {
			return fmt.Errorf("connect terminal gateway: HTTP %d: %w", response.StatusCode, err)
		}
		return fmt.Errorf("connect terminal gateway: %w", err)
	}
	defer connection.CloseNow()
	defer connector.manager.CloseAll()
	fmt.Fprintln(connector.diagnostics, "terminal gateway connected")
	connection.SetReadLimit(maximumTerminalMessageBytes)

	for {
		var command terminalCommand
		if err := wsjson.Read(ctx, connection, &command); err != nil {
			if ctx.Err() != nil || websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return nil
			}
			return fmt.Errorf("read terminal command: %w", err)
		}
		if err := connector.handleCommand(ctx, connection, command); err != nil {
			return err
		}
	}
}

func (connector *terminalConnector) handleCommand(
	ctx context.Context,
	connection *websocket.Conn,
	command terminalCommand,
) error {
	if command.SchemaVersion != protocolVersion || !validTerminalSessionID(command.SessionID) {
		return errors.New("control plane sent an incompatible terminal command")
	}
	switch command.Type {
	case "open":
		if !validTerminalSize(command.Columns, command.Rows) {
			return errors.New("control plane sent invalid terminal dimensions")
		}
		err := connector.manager.Open(
			command.SessionID,
			uint16(command.Columns),
			uint16(command.Rows),
			terminal.Events{
				Output: func(output []byte) error {
					return connector.write(ctx, connection, terminalEvent{
						SchemaVersion: protocolVersion,
						Type:          "output",
						SessionID:     command.SessionID,
						Data:          base64.StdEncoding.EncodeToString(output),
					})
				},
				Exited: func(exit terminal.Exit) {
					_ = connector.write(ctx, connection, terminalEvent{
						SchemaVersion: protocolVersion,
						Type:          "exit",
						SessionID:     command.SessionID,
						ExitCode:      exit.Code,
						Signal:        exit.Signal,
					})
				},
			},
		)
		if err != nil {
			return connector.writeSessionError(ctx, connection, command.SessionID, err)
		}
		return connector.write(ctx, connection, terminalEvent{
			SchemaVersion: protocolVersion,
			Type:          "ready",
			SessionID:     command.SessionID,
		})
	case "input":
		input, err := base64.StdEncoding.DecodeString(command.Data)
		if err != nil || len(input) == 0 || len(input) > maximumTerminalDataBytes {
			return errors.New("control plane sent invalid terminal input")
		}
		if err := connector.manager.Input(command.SessionID, input); err != nil {
			return connector.writeSessionError(ctx, connection, command.SessionID, err)
		}
		return nil
	case "resize":
		if !validTerminalSize(command.Columns, command.Rows) {
			return errors.New("control plane sent invalid terminal dimensions")
		}
		if err := connector.manager.Resize(command.SessionID, uint16(command.Columns), uint16(command.Rows)); err != nil {
			return connector.writeSessionError(ctx, connection, command.SessionID, err)
		}
		return nil
	case "close":
		connector.manager.Close(command.SessionID)
		return nil
	default:
		return errors.New("control plane sent an unsupported terminal command")
	}
}

func (connector *terminalConnector) writeSessionError(
	ctx context.Context,
	connection *websocket.Conn,
	sessionID string,
	cause error,
) error {
	message := cause.Error()
	if len(message) > 500 {
		message = message[:500]
	}
	if err := connector.write(ctx, connection, terminalEvent{
		SchemaVersion: protocolVersion,
		Type:          "error",
		SessionID:     sessionID,
		Message:       message,
	}); err != nil {
		return err
	}
	connector.manager.Close(sessionID)
	return nil
}

func (connector *terminalConnector) write(
	ctx context.Context,
	connection *websocket.Conn,
	event terminalEvent,
) error {
	writeContext, cancel := context.WithTimeout(ctx, terminalWriteTimeout)
	defer cancel()
	if err := wsjson.Write(writeContext, connection, event); err != nil {
		return fmt.Errorf("write terminal event: %w", err)
	}
	return nil
}

func (connector *terminalConnector) endpoint() string {
	endpoint := *connector.client.baseURL
	if endpoint.Scheme == "https" {
		endpoint.Scheme = "wss"
	} else {
		endpoint.Scheme = "ws"
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/terminal-stream"
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String()
}

func validTerminalSessionID(sessionID string) bool {
	if len(sessionID) == 0 || len(sessionID) > 128 {
		return false
	}
	for _, character := range sessionID {
		if !(character >= 'a' && character <= 'z') &&
			!(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') &&
			character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func validTerminalSize(columns, rows int) bool {
	return columns >= 20 && columns <= 500 && rows >= 5 && rows <= 200
}
