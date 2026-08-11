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
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/metrics"
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
			return errors.New("runner is not registered and the bootstrap token is missing")
		}
		identity, interval, err = client.Register(ctx, configuration, info)
		if err != nil {
			return err
		}
		if err := store.Save(identity); err != nil {
			return err
		}
		_ = os.Unsetenv("AUTOFORGE_AGENT_BOOTSTRAP_TOKEN")
		if configuration.ConfigurationFile != "" {
			if err := config.ConsumeBootstrapToken(configuration.ConfigurationFile); err != nil {
				return fmt.Errorf("consume bootstrap token after registration: %w", err)
			}
		}
		configuration.BootstrapToken = ""
		configuration.HasBootstrap = false
		fmt.Fprintf(diagnostics, "runner registered: %s\n", identity.RunnerID)
	} else if identity.ServerURL != configuration.ServerURL.String() {
		return errors.New("stored runner identity belongs to a different control-plane URL")
	} else if configuration.ConfigurationFile != "" && configuration.HasBootstrap {
		if err := config.ConsumeBootstrapToken(configuration.ConfigurationFile); err != nil {
			return fmt.Errorf("consume bootstrap token from registered runner: %w", err)
		}
		configuration.BootstrapToken = ""
		configuration.HasBootstrap = false
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
	resourceCollector := metrics.NewCollector()
	supervisor := newAttemptSupervisor(client, identity, configuration, diagnostics)
	if err := supervisor.Start(ctx); err != nil {
		return fmt.Errorf("start assignment supervisor: %w", err)
	}
	defer supervisor.Close()

	for {
		var resourceSnapshot *metrics.Snapshot
		collected, metricsErr := resourceCollector.Collect()
		if metricsErr != nil {
			fmt.Fprintf(diagnostics, "resource metrics unavailable: %v\n", metricsErr)
		} else {
			resourceSnapshot = &collected
		}
		response, heartbeatErr := client.Heartbeat(ctx, identity, configuration, info, supervisor.BusySlots(), resourceSnapshot)
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
				supervisor.BeginDrain()
			}
			if response.RotateCredential {
				rotated, rotationErr := client.RotateCredential(ctx, identity)
				if rotationErr != nil {
					fmt.Fprintf(diagnostics, "credential rotation failed: %v\n", rotationErr)
				} else if persistErr := persistRotatedIdentity(ctx, store, rotated, diagnostics); persistErr != nil {
					return persistErr
				} else {
					identity = rotated
					supervisor.UpdateIdentity(rotated)
					fmt.Fprintln(diagnostics, "runner credential rotated")
				}
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

func persistRotatedIdentity(ctx context.Context, store IdentityStore, identity Identity, diagnostics io.Writer) error {
	backoff := time.Second
	for {
		if err := store.Save(identity); err == nil {
			return nil
		} else {
			fmt.Fprintf(diagnostics, "persist rotated runner identity: %v; retrying\n", err)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return fmt.Errorf("persist rotated runner identity: %w", ctx.Err())
		case <-timer.C:
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}
