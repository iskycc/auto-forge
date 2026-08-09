package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/terminal"
)

func TestTerminalConnectorBridgesCommandsToPTY(t *testing.T) {
	testContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	serverResult := make(chan error, 1)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/terminal-stream" {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer terminal-ticket" {
			serverResult <- fmt.Errorf("Authorization = %q", request.Header.Get("Authorization"))
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
			Subprotocols: []string{"autoforge-runner-terminal-v1"},
		})
		if err != nil {
			serverResult <- err
			return
		}
		defer connection.CloseNow()
		if err := wsjson.Write(testContext, connection, terminalCommand{
			SchemaVersion: 1,
			Type:          "open",
			SessionID:     "session-1",
			Columns:       100,
			Rows:          30,
		}); err != nil {
			serverResult <- err
			return
		}
		var output bytes.Buffer
		inputSent := false
		for {
			var event terminalEvent
			if err := wsjson.Read(testContext, connection, &event); err != nil {
				serverResult <- err
				return
			}
			switch event.Type {
			case "ready":
				if inputSent {
					continue
				}
				inputSent = true
				if err := wsjson.Write(testContext, connection, terminalCommand{
					SchemaVersion: 1,
					Type:          "input",
					SessionID:     "session-1",
					Data:          base64.StdEncoding.EncodeToString([]byte("printf 'gateway-ready\\n'\nexit\n")),
				}); err != nil {
					serverResult <- err
					return
				}
			case "output":
				decoded, decodeErr := base64.StdEncoding.DecodeString(event.Data)
				if decodeErr != nil {
					serverResult <- decodeErr
					return
				}
				_, _ = output.Write(decoded)
			case "exit":
				if !strings.Contains(output.String(), "gateway-ready") {
					serverResult <- fmt.Errorf("terminal output = %q", output.String())
					return
				}
				serverResult <- nil
				_ = connection.Close(websocket.StatusNormalClosure, "test complete")
				return
			}
		}
	}))
	defer server.Close()

	configuration := testConfiguration(t, server.URL)
	client, err := NewClient(configuration)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	defer client.Close()
	manager := terminal.NewManager(testContext, terminal.Configuration{
		Shell:           "/bin/sh",
		WorkDirectory:   t.TempDir(),
		MaxSessions:     1,
		MaximumDuration: time.Minute,
	})
	defer manager.CloseAll()
	connector := newTerminalConnector(client, manager)
	connectorResult := make(chan error, 1)
	go func() { connectorResult <- connector.serve(testContext, "terminal-ticket") }()

	if err := <-serverResult; err != nil {
		t.Fatalf("terminal server error = %v", err)
	}
	cancel()
	select {
	case <-connectorResult:
	case <-time.After(3 * time.Second):
		t.Fatal("terminal connector did not stop")
	}
}
