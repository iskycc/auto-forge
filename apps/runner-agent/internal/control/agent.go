package control

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/terminal"
)

func Run(ctx context.Context, configuration config.Config, info buildinfo.Info, diagnostics io.Writer) error {
	if _, err := config.CheckLocalEnvironment(configuration); err != nil {
		return err
	}
	client, err := NewClient(configuration)
	if err != nil {
		return err
	}
	defer client.Close()
	store := NewIdentityStore(configuration.DataDirectory)
	identity, exists, err := store.Load()
	if err != nil {
		return err
	}
	interval := 15 * time.Second
	if !exists {
		if configuration.BootstrapToken == "" {
			return errors.New("runner is not registered and AUTOFORGE_AGENT_BOOTSTRAP_TOKEN is missing")
		}
		identity, interval, err = client.Register(ctx, configuration, info)
		if err != nil {
			return err
		}
		if err := store.Save(identity); err != nil {
			return err
		}
		_ = os.Unsetenv("AUTOFORGE_AGENT_BOOTSTRAP_TOKEN")
		fmt.Fprintf(diagnostics, "runner registered: %s\n", identity.RunnerID)
	} else if identity.ServerURL != configuration.ServerURL.String() {
		return errors.New("stored runner identity belongs to a different control-plane URL")
	}

	var terminalConnector *terminalConnector
	if configuration.Terminal.Enabled {
		terminalManager := terminal.NewManager(ctx, terminal.Configuration{
			Shell:           configuration.Terminal.Shell,
			WorkDirectory:   configuration.Terminal.WorkDirectory,
			MaxSessions:     configuration.Terminal.MaxSessions,
			MaximumDuration: configuration.Terminal.MaximumDuration,
		})
		defer terminalManager.CloseAll()
		terminalConnector = newTerminalConnector(client, terminalManager)
		go terminalConnector.Run(ctx)
	}

	for {
		response, heartbeatErr := client.Heartbeat(ctx, identity, configuration, info)
		if heartbeatErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			fmt.Fprintf(diagnostics, "heartbeat failed: %v\n", heartbeatErr)
		} else {
			interval = heartbeatInterval(response.HeartbeatIntervalSecond)
			if terminalConnector != nil {
				terminalConnector.UpdateToken(response.TerminalConnectionToken)
			}
			if response.Draining {
				return errors.New("control plane requested runner draining")
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}
